const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const { searchQuick } = require('../client');

async function search({ id, term, index, count }) {
  if (!term) {
    return resultResponse('search', [], 0, 0);
  }

  console.log(`[search] Searching for "${term}"`);
  const results = await searchQuick(term);

  const items = results.map(r => {
    // 24Six search returns type: "artist", "collection", "content"
    if (r.type === 'content') {
      return mediaMetadata({
        id: `track:${r.id}`,
        title: r.name || r.title || '',
        artist: r.subtitle || '',
        album: '',
        albumArtURI: r.img || '',
        duration: r.length || 0,
      });
    }
    if (r.type === 'collection') {
      return mediaCollection({
        id: `album:${r.id}`,
        itemType: 'album',
        title: r.name || r.title || '',
        albumArtURI: r.img || '',
        canPlay: true,
        canEnumerate: true,
      });
    }
    if (r.type === 'artist') {
      return mediaCollection({
        id: `artist:${r.id}`,
        itemType: 'artist',
        title: r.name || '',
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
