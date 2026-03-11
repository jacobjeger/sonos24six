const { simpleResponse, escapeXml } = require('../xml');
const { getStreamUrl } = require('../client');

// Build the proxy URL that Sonos will fetch to get the audio stream
function getProxyUrl(trackId, reqHost) {
  // Use the public host from environment or fall back to request host
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_HOST || reqHost;
  const protocol = host && host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/stream/${trackId}`;
}

async function getMediaURI({ id }, reqHost) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  console.log(`[getMediaURI] Fetching stream for track ${trackId}`);

  // Pre-warm: ensure we can get a stream URL (validates auth + device_id)
  const url = await getStreamUrl(trackId);
  if (!url) {
    throw new Error(`No stream URL returned for track ${trackId}`);
  }

  console.log(`[getMediaURI] Got Mux URL: ${url.substring(0, 100)}...`);

  // Return our proxy URL — Sonos will fetch this and get a direct audio stream
  const proxyUrl = getProxyUrl(trackId, reqHost);
  console.log(`[getMediaURI] Returning proxy URL: ${proxyUrl}`);

  return simpleResponse('getMediaURI',
    `      <getMediaURIResult>${escapeXml(proxyUrl)}</getMediaURIResult>`);
}

module.exports = getMediaURI;
