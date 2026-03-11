const { mediaMetadata, simpleResponse } = require('../xml');
const { getCachedTrack, getTrackInfo } = require('../client');

function extractArtist(track) {
  if (!track) return '';
  if (track.artists && track.artists.length > 0 && track.artists[0].name) return track.artists[0].name;
  if (track.subtitle) return track.subtitle;
  if (track.collection && track.collection.artists && track.collection.artists.length > 0) return track.collection.artists[0].name || '';
  return '';
}

function extractAlbum(track) {
  if (!track) return '';
  if (track.collection) return track.collection.title || track.collection.name || '';
  if (track.album_title) return track.album_title;
  return '';
}

async function getMediaMetadata({ id }) {
  if (!id) {
    const xml = mediaMetadata({ id: '', title: 'Unknown', artist: '', album: '', albumArtURI: '', duration: 0 });
    return simpleResponse('getMediaMetadata', `      <getMediaMetadataResult>\n${xml}\n      </getMediaMetadataResult>`);
  }

  // Guard: non-track IDs shouldn't reach here but handle gracefully
  if (id.startsWith('playlist:') || id.startsWith('album:') || id.startsWith('artist:')) {
    console.log(`[getMediaMetadata] non-track id: ${id}`);
    const xml = mediaMetadata({ id, title: id, artist: '', album: '', albumArtURI: '', duration: 0 });
    return simpleResponse('getMediaMetadata', `      <getMediaMetadataResult>\n${xml}\n      </getMediaMetadataResult>`);
  }

  const trackId = id.startsWith('track:') ? id.split(':')[1] : id;
  let track = getCachedTrack(trackId);

  // Re-fetch if cached but incomplete
  if (track && (!extractArtist(track) || !(track.img || track.content_image_url))) {
    try {
      const fresh = await getTrackInfo(trackId);
      if (fresh) track = fresh;
    } catch (err) {
      console.error(`[getMediaMetadata] re-fetch ${trackId} failed: ${err.message}`);
    }
  }

  // Fetch from API if not cached
  if (!track) {
    try {
      track = await getTrackInfo(trackId);
    } catch (err) {
      console.error(`[getMediaMetadata] fetch ${trackId} failed: ${err.message}`);
    }
  }

  const title = (track && (track.title || track.name || '')) || `Track ${trackId}`;
  const artist = extractArtist(track);
  const album = extractAlbum(track);
  const albumArtURI = (track && (track.img || track.content_image_url)) || '';
  const duration = (track && (track.length || track.length_in_seconds)) || 0;

  const xml = mediaMetadata({ id: `track:${trackId}`, title, artist, album, albumArtURI, duration });
  return simpleResponse('getMediaMetadata', `      <getMediaMetadataResult>\n${xml}\n      </getMediaMetadataResult>`);
}

module.exports = getMediaMetadata;
