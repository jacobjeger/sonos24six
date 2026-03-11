const { mediaMetadata, simpleResponse } = require('../xml');

async function getMediaMetadata({ id }) {
  // For now, return minimal metadata based on the track ID
  // The Sonos app will have already fetched full metadata during browsing
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;

  const xml = mediaMetadata({
    id: `track:${trackId}`,
    title: `Track ${trackId}`,
    artist: '',
    album: '',
    albumArtURI: '',
    duration: 0,
  });

  return simpleResponse('getMediaMetadata', `      <getMediaMetadataResult>\n${xml}\n      </getMediaMetadataResult>`);
}

module.exports = getMediaMetadata;
