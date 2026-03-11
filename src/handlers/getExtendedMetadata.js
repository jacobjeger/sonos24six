const { simpleResponse, mediaMetadata, mediaCollection } = require('../xml');

async function getExtendedMetadata({ id }) {
  console.log(`[getExtendedMetadata] id=${id}`);

  // Return minimal extended metadata wrapper
  // Sonos calls this for items that have been added to My Sonos / favorites
  if (id && id.startsWith('track:')) {
    const trackId = id.split(':')[1];
    const xml = mediaMetadata({
      id,
      title: `Track ${trackId}`,
      artist: '',
      album: '',
      albumArtURI: '',
      duration: 0,
    });
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
