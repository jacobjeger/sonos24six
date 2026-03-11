const { simpleResponse, mediaMetadata, mediaCollection } = require('../xml');
const { getCachedTrack, getCachedAlbum, getTrackInfo, getAlbumContents, cacheAlbum } = require('../client');

async function getExtendedMetadata({ id }) {
  console.log(`[getExtendedMetadata] id=${id}`);

  if (id && id.startsWith('track:')) {
    const trackId = id.split(':')[1];
    let track = getCachedTrack(trackId);

    // Fallback: fetch from API if not cached
    if (!track) {
      console.log(`[getExtendedMetadata] Track ${trackId} not in cache, fetching...`);
      try {
        track = await getTrackInfo(trackId);
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch track ${trackId}: ${err.message}`);
      }
    }

    const title = (track && track.title) || `Track ${trackId}`;
    const artist = track
      ? ((track.artists && track.artists[0] && track.artists[0].name) || track.subtitle || '')
      : '';
    const album = track
      ? ((track.collection && track.collection.title) || track.album_title || '')
      : '';
    const albumArtURI = (track && track.img) || '';
    const duration = (track && track.length) || 0;

    const xml = mediaMetadata({ id, title, artist, album, albumArtURI, duration });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Album — look up from cache or fetch
  if (id && id.startsWith('album:')) {
    const albumId = id.split(':')[1];
    let album = getCachedAlbum(albumId);

    if (!album) {
      console.log(`[getExtendedMetadata] Album ${albumId} not in cache, fetching...`);
      try {
        const data = await getAlbumContents(albumId);
        if (data && data.id) {
          cacheAlbum(data);
          album = data;
        }
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch album ${albumId}: ${err.message}`);
      }
    }

    const xml = mediaCollection({
      id,
      itemType: 'album',
      title: (album && (album.title || album.name)) || `Album ${albumId}`,
      albumArtURI: (album && album.img) || '',
      canPlay: true,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Playlist
  if (id && id.startsWith('playlist:')) {
    const xml = mediaCollection({
      id,
      itemType: 'playlist',
      title: id,
      albumArtURI: '',
      canPlay: true,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Artist
  if (id && id.startsWith('artist:')) {
    const xml = mediaCollection({
      id,
      itemType: 'artist',
      title: id,
      albumArtURI: '',
      canPlay: false,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Fallback
  const xml = mediaCollection({
    id,
    itemType: 'container',
    title: id,
    albumArtURI: '',
    canPlay: false,
    canEnumerate: true,
  });
  return simpleResponse('getExtendedMetadata',
    `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
}

module.exports = getExtendedMetadata;
