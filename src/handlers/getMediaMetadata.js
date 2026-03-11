const { mediaMetadata, simpleResponse } = require('../xml');
const { getCachedTrack, getTrackInfo } = require('../client');

async function getMediaMetadata({ id }) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  console.log(`[getMediaMetadata] Looking up track ${trackId}`);

  // Check the in-memory cache first (populated during browsing / prewarm)
  let track = getCachedTrack(trackId);

  // If not cached, try fetching from 24Six API
  if (!track) {
    console.log(`[getMediaMetadata] Track ${trackId} not in cache, fetching from API...`);
    try {
      track = await getTrackInfo(trackId);
    } catch (err) {
      console.log(`[getMediaMetadata] Failed to fetch track ${trackId}: ${err.message}`);
    }
  }

  const title = (track && (track.title || '')) || `Track ${trackId}`;
  const artist = track
    ? ((track.artists && track.artists[0] && track.artists[0].name) || track.subtitle || '')
    : '';
  const album = track
    ? ((track.collection && track.collection.title) || track.album_title || '')
    : '';
  const albumArtURI = (track && track.img) || '';
  const duration = (track && track.length) || 0;

  console.log(`[getMediaMetadata] Returning: title="${title}" artist="${artist}" album="${album}"`);

  const xml = mediaMetadata({
    id: `track:${trackId}`,
    title,
    artist,
    album,
    albumArtURI,
    duration,
  });

  return simpleResponse('getMediaMetadata', `      <getMediaMetadataResult>\n${xml}\n      </getMediaMetadataResult>`);
}

module.exports = getMediaMetadata;
