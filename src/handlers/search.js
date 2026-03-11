const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const { searchLibrary } = require('../client');

async function search({ id, term, index, count }) {
  if (!term) {
    return resultResponse('search', [], 0, 0);
  }

  console.log(`[search] Searching for "${term}"`);
  const results = await searchLibrary(term);

  const items = results.map(r => {
    if (r.type === 'track') {
      return mediaMetadata({
        id: `track:${r.id}`,
        title: r.title,
        artist: r.subtitle || '',
        album: '',
        albumArtURI: r.img || '',
        duration: r.length || 0,
      });
    }
    if (r.type === 'playlist') {
      return mediaCollection({
        id: `playlist:${r.id}`,
        itemType: 'playlist',
        title: r.title,
        albumArtURI: r.img || '',
        canPlay: true,
        canEnumerate: true,
      });
    }
    if (r.type === 'album') {
      return mediaCollection({
        id: `album:${r.id}`,
        itemType: 'album',
        title: r.title,
        albumArtURI: r.img || '',
        canPlay: true,
        canEnumerate: true,
      });
    }
    if (r.type === 'artist') {
      return mediaCollection({
        id: `artist:${r.id}`,
        itemType: 'artist',
        title: r.name,
        albumArtURI: r.img || '',
        canPlay: false,
        canEnumerate: true,
      });
    }
    return null;
  }).filter(Boolean);

  const sliced = items.slice(index, index + count);
  return resultResponse('search', sliced, index, items.length);
}

module.exports = search;
