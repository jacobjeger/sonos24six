const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const { searchQuick, cacheTrack } = require('../client');

async function search({ id, term, index, count }) {
  if (!term) {
    return resultResponse('search', [], 0, 0);
  }

  // id is the search category (search:all, search:tracks, etc.)
  const category = id ? id.replace('search:', '') : 'all';
  console.log(`[search] Searching for "${term}" in category "${category}"`);

  const results = await searchQuick(term);
  console.log(`[search] Got ${results.length} results`);

  const items = results.map(r => {
    // 24Six search returns type: "artist", "collection", "content"
    if (r.type === 'content') {
      if (category !== 'all' && category !== 'tracks') return null;
      // Cache track data for getMediaMetadata
      cacheTrack({ id: r.id, title: r.name || r.title, subtitle: r.subtitle, img: r.img, length: r.length });
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
      if (category !== 'all' && category !== 'albums') return null;
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
      if (category !== 'all' && category !== 'artists') return null;
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
  console.log(`[search] Returning ${sliced.length} of ${items.length} items`);
  return resultResponse('search', sliced, index, items.length);
}

module.exports = search;
