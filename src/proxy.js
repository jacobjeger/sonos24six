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
 * Fetch HLS master playlist, resolve to audio segments, and pipe as AAC stream.
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
    console.log(`[proxy] Master m3u8 (${masterText.length} chars):\n${masterText.substring(0, 500)}`);

    // Resolve base URL for relative paths in the manifest
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    // Check if this is a master playlist (has #EXT-X-STREAM-INF) or a media playlist
    if (masterText.includes('#EXT-X-STREAM-INF') || masterText.includes('#EXT-X-MEDIA')) {
      // Master playlist — pick the best audio variant
      const variantUrl = pickAudioVariant(masterText, baseUrl, m3u8Url);
      if (!variantUrl) {
        console.log(`[proxy] No audio variant found in master playlist`);
        res.status(502).send('No audio variant in stream');
        return;
      }

      console.log(`[proxy] Fetching variant m3u8: ${variantUrl.substring(0, 100)}...`);
      const variantRes = await fetch(variantUrl);
      const variantText = await variantRes.text();
      console.log(`[proxy] Variant m3u8 (${variantText.length} chars):\n${variantText.substring(0, 500)}`);

      const variantBase = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
      await streamSegments(variantText, variantBase, res);
    } else {
      // Already a media playlist — stream segments directly
      await streamSegments(masterText, baseUrl, res);
    }
  } catch (err) {
    console.error(`[proxy] Error streaming track ${trackId}:`, err);
    if (!res.headersSent) {
      res.status(500).send('Stream error');
    }
  }
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
        // Pick highest bandwidth (best quality)
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

/**
 * Resolve a potentially relative URL against a base.
 */
function resolveUrl(url, baseUrl, originalUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    const origin = new URL(originalUrl || baseUrl).origin;
    return origin + url;
  }
  return baseUrl + url;
}

/**
 * Parse a media playlist and stream all audio segments to the response.
 */
async function streamSegments(playlistText, baseUrl, res) {
  const lines = playlistText.split('\n').map(l => l.trim());
  const segmentUrls = [];

  for (const line of lines) {
    if (line && !line.startsWith('#')) {
      const segUrl = line.startsWith('http') ? line : baseUrl + line;
      segmentUrls.push(segUrl);
    }
  }

  console.log(`[proxy] Found ${segmentUrls.length} segments to stream`);

  if (segmentUrls.length === 0) {
    res.status(502).send('No segments found');
    return;
  }

  // Determine content type from first segment extension
  const firstSeg = segmentUrls[0].split('?')[0];
  let contentType = 'audio/aac';
  if (firstSeg.endsWith('.ts')) contentType = 'video/mp2t';
  else if (firstSeg.endsWith('.m4s') || firstSeg.endsWith('.mp4')) contentType = 'audio/mp4';
  else if (firstSeg.endsWith('.aac')) contentType = 'audio/aac';

  res.set('Content-Type', contentType);
  res.set('Transfer-Encoding', 'chunked');
  res.set('Accept-Ranges', 'none');

  // Stream each segment sequentially
  for (let i = 0; i < segmentUrls.length; i++) {
    if (res.destroyed) {
      console.log(`[proxy] Client disconnected at segment ${i}`);
      break;
    }

    try {
      const segRes = await fetch(segmentUrls[i]);
      if (!segRes.ok) {
        console.log(`[proxy] Segment ${i} fetch failed: ${segRes.status}`);
        continue;
      }

      // Pipe segment data to response
      await new Promise((resolve, reject) => {
        segRes.body.on('data', chunk => res.write(chunk));
        segRes.body.on('end', resolve);
        segRes.body.on('error', reject);
      });
    } catch (err) {
      console.log(`[proxy] Segment ${i} error:`, err.message);
    }
  }

  console.log(`[proxy] Finished streaming all segments`);
  res.end();
}

module.exports = { handleStreamProxy };
