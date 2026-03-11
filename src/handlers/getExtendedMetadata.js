const { simpleResponse, mediaMetadata, mediaCollection } = require('../xml');
const { getCachedTrack } = require('../client');

async function getExtendedMetadata({ id }) {
  console.log(`[getExtendedMetadata] id=${id}`);

  if (id && id.startsWith('track:')) {
    const trackId = id.split(':')[1];
    const track = getCachedTrack(trackId);

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

  // For containers (albums, playlists, artists)
  let itemType = 'container';
  if (id && id.startsWith('album:')) itemType = 'album';
  if (id && id.startsWith('playlist:')) itemType = 'playlist';
  if (id && id.startsWith('artist:')) itemType = 'artist';

  const xml = mediaCollection({
    id,
    itemType,
    title: id,
    albumArtURI: '',
    canPlay: itemType !== 'artist',
    canEnumerate: true,
  });
  return simpleResponse('getExtendedMetadata',
    `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
}

module.exports = getExtendedMetadata;
