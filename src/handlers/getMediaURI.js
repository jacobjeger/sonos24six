const { simpleResponse, escapeXml } = require('../xml');

function getProxyUrl(trackId, reqHost) {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_HOST || reqHost;
  const protocol = host && host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/hls/${trackId}/playlist.m3u8`;
}

async function getMediaURI({ id }, reqHost) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  const proxyUrl = getProxyUrl(trackId, reqHost);
  console.log(`[getMediaURI] Returning HLS manifest proxy URL: ${proxyUrl}`);

  return simpleResponse('getMediaURI',
    `      <getMediaURIResult>${escapeXml(proxyUrl)}</getMediaURIResult>`);
}

module.exports = getMediaURI;
