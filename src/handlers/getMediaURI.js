const { simpleResponse } = require('../xml');
const { getStreamUrl } = require('../client');

async function getMediaURI({ id }) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  console.log(`[getMediaURI] Fetching stream for track ${trackId}`);

  const url = await getStreamUrl(trackId);
  if (!url) {
    throw new Error(`No stream URL returned for track ${trackId}`);
  }

  console.log(`[getMediaURI] Got stream URL: ${url.substring(0, 80)}...`);

  return simpleResponse('getMediaURI',
    `      <getMediaURIResult>${url}</getMediaURIResult>`);
}

module.exports = getMediaURI;
