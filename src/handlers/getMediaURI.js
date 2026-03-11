const { simpleResponse, escapeXml } = require('../xml');
const { getStreamUrl } = require('../client');

async function getMediaURI({ id }) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  console.log(`[getMediaURI] Fetching stream for track ${trackId}`);

  const url = await getStreamUrl(trackId);
  if (!url) {
    throw new Error(`No stream URL returned for track ${trackId}`);
  }

  console.log(`[getMediaURI] Returning Mux HLS URL: ${url.substring(0, 100)}...`);

  // Return the Mux m3u8 URL directly — Sonos supports HLS natively
  return simpleResponse('getMediaURI',
    `      <getMediaURIResult>${escapeXml(url)}</getMediaURIResult>`);
}

module.exports = getMediaURI;
