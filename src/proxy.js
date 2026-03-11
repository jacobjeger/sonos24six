const fetch = require('node-fetch');
const { getStreamUrl } = require('./client');

// Cache stream URLs briefly (tokens expire, so short TTL)
const urlCache = new Map();
const URL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function getCachedStreamUrl(trackId) {
  const entry = urlCache.get(trackId);
  if (entry && Date.now() - entry.ts < URL_CACHE_TTL) return entry.url;
  urlCache.delete(trackId);

  const url = await getStreamUrl(trackId);
  if (url) urlCache.set(trackId, { url, ts: Date.now() });
  return url;
}

/**
 * Fetch HLS master playlist, download all segments, extract AAC audio,
 * and serve as a proper audio stream for Sonos.
 */
async function handleStreamProxy(req, res) {
  const trackId = req.params.trackId;
  console.log(`[proxy] Stream request for track ${trackId}`);

  try {
    const m3u8Url = await getCachedStreamUrl(trackId);
    if (!m3u8Url) {
      console.log(`[proxy] No stream URL for track ${trackId}`);
      res.status(404).send('Stream not available');
      return;
    }

    console.log(`[proxy] Fetching master m3u8: ${m3u8Url.substring(0, 80)}...`);
    const masterRes = await fetch(m3u8Url);
    if (!masterRes.ok) {
      console.log(`[proxy] Master m3u8 fetch failed: ${masterRes.status}`);
      res.status(502).send('Failed to fetch stream');
      return;
    }

    const masterText = await masterRes.text();
    console.log(`[proxy] Master m3u8 (${masterText.length} chars)`);

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    let playlistText = masterText;
    let playlistBase = baseUrl;

    // If master playlist, resolve to variant
    if (masterText.includes('#EXT-X-STREAM-INF') || masterText.includes('#EXT-X-MEDIA')) {
      const variantUrl = pickAudioVariant(masterText, baseUrl, m3u8Url);
      if (!variantUrl) {
        console.log(`[proxy] No audio variant found`);
        res.status(502).send('No audio variant');
        return;
      }

      console.log(`[proxy] Fetching variant m3u8`);
      const variantRes = await fetch(variantUrl);
      playlistText = await variantRes.text();
      playlistBase = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
    }

    // Get segment URLs
    const segmentUrls = [];
    const lines = playlistText.split('\n').map(l => l.trim());
    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        segmentUrls.push(line.startsWith('http') ? line : playlistBase + line);
      }
    }

    console.log(`[proxy] Found ${segmentUrls.length} segments`);
    if (segmentUrls.length === 0) {
      res.status(502).send('No segments found');
      return;
    }

    // Download ALL segments first, then extract AAC and serve
    const allSegmentData = [];
    let totalBytes = 0;
    for (let i = 0; i < segmentUrls.length; i++) {
      try {
        const segRes = await fetch(segmentUrls[i]);
        if (!segRes.ok) {
          console.log(`[proxy] Segment ${i} failed: ${segRes.status}`);
          continue;
        }
        const buf = await segRes.buffer();
        allSegmentData.push(buf);
        totalBytes += buf.length;
      } catch (err) {
        console.log(`[proxy] Segment ${i} error: ${err.message}`);
      }
    }

    console.log(`[proxy] Downloaded ${allSegmentData.length} segments, ${totalBytes} bytes total`);

    // Concatenate all segment data
    const tsData = Buffer.concat(allSegmentData);

    // Extract AAC ADTS frames from MPEG-TS data
    const aacData = extractADTSFromTS(tsData);
    console.log(`[proxy] Extracted ${aacData.length} bytes of AAC ADTS audio`);

    if (aacData.length === 0) {
      console.log(`[proxy] No AAC audio found in TS data`);
      res.status(502).send('No audio data found');
      return;
    }

    // Serve as AAC audio
    res.set('Content-Type', 'audio/aac');
    res.set('Content-Length', String(aacData.length));
    res.set('Accept-Ranges', 'bytes');
    res.send(aacData);
    console.log(`[proxy] Sent ${aacData.length} bytes of AAC audio`);
  } catch (err) {
    console.error(`[proxy] Error streaming track ${trackId}:`, err);
    if (!res.headersSent) {
      res.status(500).send('Stream error');
    }
  }
}

/**
 * Extract AAC ADTS frames from MPEG-TS data.
 *
 * MPEG-TS packets are 188 bytes, starting with 0x47.
 * We collect payload from audio PID packets, then extract ADTS frames.
 */
function extractADTSFromTS(tsData) {
  const TS_PACKET_SIZE = 188;
  const SYNC_BYTE = 0x47;

  // First pass: find the audio PID from PAT/PMT
  let audioPid = -1;
  let pmtPid = -1;

  // Find sync byte offset (some streams have extra bytes before first packet)
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
      // PAT (Program Association Table)
      const adaptationField = (tsData[i + 3] >> 4) & 0x03;
      let payloadStart = i + 4;
      if (adaptationField === 0x03 || adaptationField === 0x02) {
        payloadStart += 1 + tsData[i + 4]; // adaptation field length
      }
      const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;
      if (payloadUnitStart && payloadStart < i + TS_PACKET_SIZE) {
        payloadStart += 1 + tsData[payloadStart]; // pointer field
      }
      // Skip PAT header (8 bytes: table_id, section_syntax, section_length, transport_stream_id, etc.)
      const tableStart = payloadStart;
      if (tableStart + 8 < i + TS_PACKET_SIZE) {
        const sectionLength = ((tsData[tableStart + 1] & 0x0F) << 8) | tsData[tableStart + 2];
        const programStart = tableStart + 8;
        const programEnd = Math.min(tableStart + 3 + sectionLength - 4, i + TS_PACKET_SIZE);
        for (let j = programStart; j + 3 < programEnd; j += 4) {
          const programNum = (tsData[j] << 8) | tsData[j + 1];
          const pPid = ((tsData[j + 2] & 0x1F) << 8) | tsData[j + 3];
          if (programNum !== 0) {
            pmtPid = pPid;
            break;
          }
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

      if (pid === pmtPid) {
        const adaptationField = (tsData[i + 3] >> 4) & 0x03;
        let payloadStart = i + 4;
        if (adaptationField === 0x03 || adaptationField === 0x02) {
          payloadStart += 1 + tsData[i + 4];
        }
        const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;
        if (payloadUnitStart && payloadStart < i + TS_PACKET_SIZE) {
          payloadStart += 1 + tsData[payloadStart]; // pointer field
        }
        // PMT: table_id(1) + section_syntax+section_length(2) + program_number(2) +
        // version(1) + section_number(1) + last_section(1) + PCR_PID(2) + program_info_length(2)
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
            // AAC stream types: 0x0F (AAC ADTS), 0x11 (AAC LATM)
            if (streamType === 0x0F || streamType === 0x11) {
              audioPid = elementaryPid;
              break;
            }
            streamStart += 5 + esInfoLength;
          }
        }
        if (audioPid >= 0) break;
      }
    }
  }

  console.log(`[proxy] MPEG-TS: PMT PID=${pmtPid}, Audio PID=${audioPid}`);

  // If we couldn't find audio PID via PAT/PMT, try heuristic:
  // find the most common non-null, non-PAT PID with ADTS-looking data
  if (audioPid < 0) {
    console.log(`[proxy] Falling back to heuristic audio PID detection`);
    const pidCounts = {};
    for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
      if (tsData[i] !== SYNC_BYTE) continue;
      const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];
      if (pid !== 0 && pid !== pmtPid && pid !== 0x1FFF) {
        pidCounts[pid] = (pidCounts[pid] || 0) + 1;
      }
    }
    // Pick the PID with the most packets
    let maxCount = 0;
    for (const [pid, count] of Object.entries(pidCounts)) {
      if (count > maxCount) {
        maxCount = count;
        audioPid = parseInt(pid, 10);
      }
    }
    console.log(`[proxy] Heuristic audio PID=${audioPid} (${maxCount} packets)`);
  }

  if (audioPid < 0) {
    console.log(`[proxy] Could not determine audio PID`);
    return Buffer.alloc(0);
  }

  // Second pass: collect PES payload from audio PID packets
  const pesChunks = [];
  for (let i = syncOffset; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
    if (tsData[i] !== SYNC_BYTE) continue;
    const pid = ((tsData[i + 1] & 0x1F) << 8) | tsData[i + 2];
    if (pid !== audioPid) continue;

    const adaptationFieldControl = (tsData[i + 3] >> 4) & 0x03;
    let payloadStart = i + 4;

    // Skip adaptation field if present
    if (adaptationFieldControl === 0x02) continue; // adaptation only, no payload
    if (adaptationFieldControl === 0x03) {
      const adaptLen = tsData[i + 4];
      payloadStart = i + 5 + adaptLen;
    }

    const payloadUnitStart = (tsData[i + 1] >> 6) & 0x01;

    if (payloadUnitStart) {
      // PES header starts here — skip it to get to ADTS data
      // PES header: start_code(3) + stream_id(1) + PES_packet_length(2) + flags(2) + header_data_length(1) + header_data
      if (payloadStart + 9 <= i + TS_PACKET_SIZE) {
        // Verify PES start code: 0x00 0x00 0x01
        if (tsData[payloadStart] === 0x00 && tsData[payloadStart + 1] === 0x00 && tsData[payloadStart + 2] === 0x01) {
          const headerDataLen = tsData[payloadStart + 8];
          payloadStart = payloadStart + 9 + headerDataLen;
        }
      }
    }

    if (payloadStart < i + TS_PACKET_SIZE) {
      pesChunks.push(tsData.slice(payloadStart, i + TS_PACKET_SIZE));
    }
  }

  console.log(`[proxy] Collected ${pesChunks.length} audio PES chunks`);

  // Concatenate all PES payload data
  const rawAudio = Buffer.concat(pesChunks);

  // Extract valid ADTS frames from the raw audio data
  return extractADTSFrames(rawAudio);
}

/**
 * Scan buffer for valid ADTS frames and extract them.
 */
function extractADTSFrames(data) {
  const frames = [];
  let i = 0;

  while (i < data.length - 7) {
    // ADTS sync word: 0xFFF (12 bits)
    if (data[i] === 0xFF && (data[i + 1] & 0xF0) === 0xF0) {
      // Read frame length from ADTS header (13 bits at bit offset 30)
      const frameLength = ((data[i + 3] & 0x03) << 11) |
                          (data[i + 4] << 3) |
                          ((data[i + 5] & 0xE0) >> 5);

      if (frameLength >= 7 && frameLength <= 8192 && i + frameLength <= data.length) {
        // Verify next frame also starts with ADTS sync (or we're at end of data)
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

/**
 * Pick the best audio variant URL from a master HLS playlist.
 */
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

  // Also check for #EXT-X-MEDIA type=AUDIO
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        bestUrl = resolveUrl(uriMatch[1], baseUrl, originalUrl);
      }
    }
  }

  return bestUrl;
}

function resolveUrl(url, baseUrl, originalUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    const origin = new URL(originalUrl || baseUrl).origin;
    return origin + url;
  }
  return baseUrl + url;
}

module.exports = { handleStreamProxy };
