const fetch = require('node-fetch');
const { getStreamUrl } = require('./client');

// Cache stream URLs briefly (tokens expire, so short TTL)
const urlCache = new Map();
const URL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Cache decoded audio buffers (avoid re-downloading for Sonos range requests)
const audioCache = new Map();
const AUDIO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_AUDIO_CACHE = 10; // max tracks cached

async function getCachedStreamUrl(trackId) {
  const entry = urlCache.get(trackId);
  if (entry && Date.now() - entry.ts < URL_CACHE_TTL) return entry.url;
  urlCache.delete(trackId);

  const url = await getStreamUrl(trackId);
  if (url) urlCache.set(trackId, { url, ts: Date.now() });
  return url;
}

function getCachedAudio(trackId) {
  const entry = audioCache.get(trackId);
  if (entry && Date.now() - entry.ts < AUDIO_CACHE_TTL) return entry.data;
  audioCache.delete(trackId);
  return null;
}

function setCachedAudio(trackId, data) {
  // Evict oldest if cache is full
  if (audioCache.size >= MAX_AUDIO_CACHE) {
    const oldest = audioCache.keys().next().value;
    audioCache.delete(oldest);
  }
  audioCache.set(trackId, { data, ts: Date.now() });
}

/**
 * Fetch HLS, extract AAC, serve with Range support for Sonos.
 * Sonos speakers require:
 * - HEAD request support (to get Content-Length before GET)
 * - Range request support (for seeking)
 * - Proper Content-Type (audio/aac for ADTS streams)
 */
async function handleStreamProxy(req, res) {
  const trackId = req.params.trackId;
  const method = req.method;
  console.log(`[proxy] ${method} /stream/${trackId}`);

  try {
    // Check audio cache first
    let aacData = getCachedAudio(trackId);

    if (!aacData) {
      // Need to download and decode
      aacData = await downloadAndExtract(trackId);
      if (!aacData || aacData.length === 0) {
        console.log(`[proxy] No audio data for track ${trackId}`);
        res.status(404).send('Audio not available');
        return;
      }
      setCachedAudio(trackId, aacData);
    } else {
      console.log(`[proxy] Serving from cache: ${aacData.length} bytes`);
    }

    // Serve the audio with Range support
    serveAudio(req, res, aacData);
  } catch (err) {
    console.error(`[proxy] Error for track ${trackId}:`, err);
    if (!res.headersSent) {
      res.status(500).send('Stream error');
    }
  }
}

/**
 * Serve audio buffer with HEAD, GET, and Range request support.
 */
function serveAudio(req, res, data) {
  const total = data.length;

  // Common headers
  res.set('Content-Type', 'audio/aac');
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'public, max-age=300');

  // HEAD request — Sonos sends this first to get Content-Length
  if (req.method === 'HEAD') {
    res.set('Content-Length', String(total));
    console.log(`[proxy] HEAD response: ${total} bytes`);
    res.status(200).end();
    return;
  }

  // Handle Range requests
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;

      console.log(`[proxy] Range: bytes ${start}-${end}/${total} (${chunkSize} bytes)`);

      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(chunkSize));
      res.send(data.slice(start, end + 1));
      return;
    }
  }

  // Full GET request
  res.set('Content-Length', String(total));
  console.log(`[proxy] Full response: ${total} bytes`);
  res.send(data);
}

/**
 * Download HLS segments, extract AAC ADTS audio from MPEG-TS.
 */
async function downloadAndExtract(trackId) {
  const m3u8Url = await getCachedStreamUrl(trackId);
  if (!m3u8Url) return null;

  console.log(`[proxy] Fetching m3u8 for track ${trackId}`);
  const masterRes = await fetch(m3u8Url);
  if (!masterRes.ok) return null;

  const masterText = await masterRes.text();
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  let playlistText = masterText;
  let playlistBase = baseUrl;

  // Resolve master → variant
  if (masterText.includes('#EXT-X-STREAM-INF') || masterText.includes('#EXT-X-MEDIA')) {
    const variantUrl = pickAudioVariant(masterText, baseUrl, m3u8Url);
    if (!variantUrl) return null;

    const variantRes = await fetch(variantUrl);
    playlistText = await variantRes.text();
    playlistBase = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
  }

  // Get segment URLs
  const segmentUrls = [];
  for (const line of playlistText.split('\n').map(l => l.trim())) {
    if (line && !line.startsWith('#')) {
      segmentUrls.push(line.startsWith('http') ? line : playlistBase + line);
    }
  }

  console.log(`[proxy] Downloading ${segmentUrls.length} segments`);

  // Download all segments
  const allSegmentData = [];
  let totalBytes = 0;
  for (let i = 0; i < segmentUrls.length; i++) {
    try {
      const segRes = await fetch(segmentUrls[i]);
      if (segRes.ok) {
        const buf = await segRes.buffer();
        allSegmentData.push(buf);
        totalBytes += buf.length;
      }
    } catch (err) {
      console.log(`[proxy] Segment ${i} error: ${err.message}`);
    }
  }

  console.log(`[proxy] Downloaded ${totalBytes} bytes from ${allSegmentData.length} segments`);

  const tsData = Buffer.concat(allSegmentData);
  const aacData = extractADTSFromTS(tsData);
  console.log(`[proxy] Extracted ${aacData.length} bytes of AAC audio`);

  return aacData;
}

/**
 * Extract AAC ADTS frames from MPEG-TS data.
 */
function extractADTSFromTS(tsData) {
  const TS_PACKET_SIZE = 188;
  const SYNC_BYTE = 0x47;

  let audioPid = -1;
  let pmtPid = -1;

  // Find sync byte offset
  let syncOffset = 0;
  for (let i = 0; i < Math.min(tsData.length, TS_PACKET_SIZE); i++) {
    if (tsData[i] === SYNC_BYTE &&
        i + TS_PACKET_SIZE < tsData.length &&
        tsData[i + TS_PACKET_SIZE] === SYNC_BYTE) {
      syncOffset = i;
      break;
    }
  }

  // Parse PAT to find PMT PID
  for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
    if (tsData[i] !== SYNC_BYTE) continue;
    const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];

    if (pid === 0) {
      const adaptationField = (tsData[i + 3] >> 4) & 0x03;
      let payloadStart = i + 4;
      if (adaptationField === 0x03 || adaptationField === 0x02) {
        payloadStart += 1 + tsData[i + 4];
      }
      const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;
      if (payloadUnitStart && payloadStart < i + TS_PACKET_SIZE) {
        payloadStart += 1 + tsData[payloadStart];
      }
      const tableStart = payloadStart;
      if (tableStart + 8 < i + TS_PACKET_SIZE) {
        const sectionLength = ((tsData[tableStart + 1] & 0x0F) << 8) | tsData[tableStart + 2];
        const programStart = tableStart + 8;
        const programEnd = Math.min(tableStart + 3 + sectionLength - 4, i + TS_PACKET_SIZE);
        for (let j = programStart; j + 3 < programEnd; j += 4) {
          const programNum = (tsData[j] << 8) | tsData[j + 1];
          const pPid = ((tsData[j + 2] & 0x1F) << 8) | tsData[j + 3];
          if (programNum !== 0) { pmtPid = pPid; break; }
        }
      }
      if (pmtPid >= 0) break;
    }
  }

  // Parse PMT to find audio PID
  if (pmtPid >= 0) {
    for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
      if (tsData[i] !== SYNC_BYTE) continue;
      const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];
      if (pid !== pmtPid) continue;

      const adaptationField = (tsData[i + 3] >> 4) & 0x03;
      let payloadStart = i + 4;
      if (adaptationField === 0x03 || adaptationField === 0x02) {
        payloadStart += 1 + tsData[i + 4];
      }
      const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;
      if (payloadUnitStart && payloadStart < i + TS_PACKET_SIZE) {
        payloadStart += 1 + tsData[payloadStart];
      }
      const tableStart = payloadStart;
      if (tableStart + 12 < i + TS_PACKET_SIZE) {
        const sectionLength = ((tsData[tableStart + 1] & 0x0F) << 8) | tsData[tableStart + 2];
        const programInfoLength = ((tsData[tableStart + 10] & 0x0F) << 8) | tsData[tableStart + 11];
        let streamStart = tableStart + 12 + programInfoLength;
        const streamEnd = Math.min(tableStart + 3 + sectionLength - 4, i + TS_PACKET_SIZE);
        while (streamStart + 4 < streamEnd) {
          const streamType = tsData[streamStart];
          const elementaryPid = ((tsData[streamStart + 1] & 0x1F) << 8) | tsData[streamStart + 2];
          const esInfoLength = ((tsData[streamStart + 3] & 0x0F) << 8) | tsData[streamStart + 4];
          if (streamType === 0x0F || streamType === 0x11) { audioPid = elementaryPid; break; }
          streamStart += 5 + esInfoLength;
        }
      }
      if (audioPid >= 0) break;
    }
  }

  console.log(`[proxy] MPEG-TS: PMT PID=${pmtPid}, Audio PID=${audioPid}`);

  // Heuristic fallback
  if (audioPid < 0) {
    const pidCounts = {};
    for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
      if (tsData[i] !== SYNC_BYTE) continue;
      const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];
      if (pid !== 0 && pid !== pmtPid && pid !== 0x1FFF) {
        pidCounts[pid] = (pidCounts[pid] || 0) + 1;
      }
    }
    let maxCount = 0;
    for (const [pid, count] of Object.entries(pidCounts)) {
      if (count > maxCount) { maxCount = count; audioPid = parseInt(pid, 10); }
    }
  }

  if (audioPid < 0) return Buffer.alloc(0);

  // Collect PES payload from audio PID
  const pesChunks = [];
  for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
    if (tsData[i] !== SYNC_BYTE) continue;
    const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];
    if (pid !== audioPid) continue;

    const adaptationFieldControl = (tsData[i + 3] >> 4) & 0x03;
    let payloadStart = i + 4;
    if (adaptationFieldControl === 0x02) continue;
    if (adaptationFieldControl === 0x03) {
      payloadStart = i + 5 + tsData[i + 4];
    }

    const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;
    if (payloadUnitStart) {
      if (payloadStart + 9 <= i + TS_PACKET_SIZE &&
          tsData[payloadStart] === 0x00 && tsData[payloadStart + 1] === 0x00 && tsData[payloadStart + 2] === 0x01) {
        payloadStart = payloadStart + 9 + tsData[payloadStart + 8];
      }
    }

    if (payloadStart < i + TS_PACKET_SIZE) {
      pesChunks.push(tsData.slice(payloadStart, i + TS_PACKET_SIZE));
    }
  }

  const rawAudio = Buffer.concat(pesChunks);
  return extractADTSFrames(rawAudio);
}

/**
 * Extract valid ADTS frames from raw audio data.
 */
function extractADTSFrames(data) {
  const frames = [];
  let i = 0;

  while (i < data.length - 7) {
    if (data[i] === 0xFF && (data[i + 1] & 0xF0) === 0xF0) {
      const frameLength = ((data[i + 3] & 0x03) << 11) |
                          (data[i + 4] << 3) |
                          ((data[i + 5] & 0xE0) >> 5);

      if (frameLength >= 7 && frameLength <= 8192 && i + frameLength <= data.length) {
        if (i + frameLength >= data.length - 7 ||
            (data[i + frameLength] === 0xFF && (data[i + frameLength + 1] & 0xF0) === 0xF0)) {
          frames.push(data.slice(i, i + frameLength));
          i += frameLength;
          continue;
        }
      }
    }
    i++;
  }

  return Buffer.concat(frames);
}

function pickAudioVariant(masterText, baseUrl, originalUrl) {
  const lines = masterText.split('\n').map(l => l.trim()).filter(Boolean);
  let bestUrl = null;
  let bestBandwidth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        if (bandwidth >= bestBandwidth) {
          bestBandwidth = bandwidth;
          bestUrl = resolveUrl(nextLine, baseUrl, originalUrl);
        }
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) bestUrl = resolveUrl(uriMatch[1], baseUrl, originalUrl);
    }
  }

  return bestUrl;
}

function resolveUrl(url, baseUrl, originalUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return new URL(originalUrl || baseUrl).origin + url;
  return baseUrl + url;
}

module.exports = { handleStreamProxy };
