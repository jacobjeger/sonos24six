const { mediaMetadata, simpleResponse } = require('../xml');
const { getCachedTrack, getTrackInfo } = require('../client');

// Extract artist name from track — handles various 24Six object shapes
function extractArtist(track) {
  if (!track) return '';
  // Try artists array first
  if (track.artists && track.artists.length > 0 && track.artists[0].name) {
    return track.artists[0].name;
  }
  // Try subtitle (used in library listing format)
  if (track.subtitle) return track.subtitle;
  // Try collection's artist info
  if (track.collection && track.collection.artists && track.collection.artists.length > 0) {
    return track.collection.artists[0].name || '';
  }
  return '';
}

// Extract album name from track
function extractAlbum(track) {
  if (!track) return '';
  // Try collection object (name or title)
  if (track.collection) {
    return track.collection.title || track.collection.name || '';
  }
  if (track.album_title) return track.album_title;
  return '';
}

// Extract artwork URL from track
function extractArt(track) {
  if (!track) return '';
  return track.img || track.content_image_url || '';
}

// Extract duration from track
function extractDuration(track) {
  if (!track) return 0;
  return track.length || track.length_in_seconds || 0;
}

async function getMediaMetadata({ id }) {
  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  console.log(`[getMediaMetadata] Looking up track ${trackId}`);

  // Check the in-memory cache first (populated during browsing / prewarm)
  let track = getCachedTrack(trackId);

  // If cached but missing artist/art, re-fetch to get complete data
  if (track && (!extractArtist(track) || !extractArt(track))) {
    console.log(`[getMediaMetadata] Track ${trackId} cached but incomplete (artist="${extractArtist(track)}", art=${!!extractArt(track)}), re-fetching...`);
    try {
      const fresh = await getTrackInfo(trackId);
      if (fresh) track = fresh;
    } catch (err) {
      console.log(`[getMediaMetadata] Re-fetch failed: ${err.message}`);
    }
  }

  // If not cached at all, try fetching from 24Six API
  if (!track) {
    console.log(`[getMediaMetadata] Track ${trackId} not in cache, fetching from API...`);
    try {
      track = await getTrackInfo(trackId);
    } catch (err) {
      console.log(`[getMediaMetadata] Failed to fetch track ${trackId}: ${err.message}`);
    }
  }

  const title = (track && (track.title || track.name || '')) || `Track ${trackId}`;
  const artist = extractArtist(track);
  const album = extractAlbum(track);
  const albumArtURI = extractArt(track);
  const duration = extractDuration(track);

  // Debug: dump full track when artist or art missing
  if (track && (!artist || !albumArtURI)) {
    console.log(`[getMediaMetadata] DEBUG track ${trackId} keys:`, Object.keys(track));
    console.log(`[getMediaMetadata] DEBUG track ${trackId} artists:`, JSON.stringify(track.artists));
    console.log(`[getMediaMetadata] DEBUG track ${trackId} collection:`, JSON.stringify(track.collection && { name: track.collection.name, title: track.collection.title, artists: track.collection.artists }));
    console.log(`[getMediaMetadata] DEBUG track ${trackId} subtitle:`, track.subtitle, 'img:', track.img, 'content_image_url:', track.content_image_url);
  }

  console.log(`[getMediaMetadata] Returning: title="${title}" artist="${artist}" album="${album}" art="${albumArtURI ? 'yes' : 'no'}" dur=${duration}`);

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
