const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const { searchFull, searchQuick, cacheTrack } = require('../client');

function trackItem(r) {
  const title = r.title || r.name || '';
  const artist = r.subtitle || (r.artists && r.artists[0] && r.artists[0].name) || '';
  const img = r.img || r.content_image_url || '';
  const duration = r.length || r.length_in_seconds || 0;
  // Cache for getMediaMetadata
  cacheTrack({ id: r.id, title, subtitle: artist, img, length: duration, artists: r.artists, collection: r.collection });
  return mediaMetadata({
    id: `track:${r.id}`,
    title,
    artist,
    album: (r.collection && (r.collection.name || r.collection.title)) || '',
    albumArtURI: img,
    duration,
  });
}

function albumItem(r) {
  return mediaCollection({
    id: `album:${r.id}`,
    itemType: 'album',
    title: r.name || r.title || '',
    albumArtURI: r.img || r.cover_url || '',
    artist: r.subtitle || (r.artists && r.artists[0] && r.artists[0].name) || '',
    canPlay: true,
    canEnumerate: true,
  });
}

function artistItem(r) {
  return mediaCollection({
    id: `artist:${r.id}`,
    itemType: 'artist',
    title: r.name || r.title || '',
    albumArtURI: r.img || '',
    canPlay: false,
    canEnumerate: true,
  });
}

async function search({ id, term, index, count }) {
  if (!term) {
    return resultResponse('search', [], 0, 0);
  }

  const category = id ? id.replace('search:', '') : 'all';
  console.log(`[search] Searching for "${term}" in category "${category}"`);

  let items = [];

  // Try full search first (GET /app/music/search?q=) — returns categorized results
  try {
    const props = await searchFull(term);
    // Full search returns props with: songs/contents, collections/albums, artists, playlists
    const songs = props.songs || props.contents || props.content || [];
    const albums = props.collections || props.albums || [];
    const artists = props.artists || [];
    const playlists = props.playlists || [];

    console.log(`[search] Full search results: ${songs.length} songs, ${albums.length} albums, ${artists.length} artists, ${playlists.length} playlists`);

    if (category === 'all' || category === 'tracks') {
      for (const r of songs) items.push(trackItem(r));
    }
    if (category === 'all' || category === 'albums') {
      for (const r of albums) items.push(albumItem(r));
    }
    if (category === 'all' || category === 'artists') {
      for (const r of artists) items.push(artistItem(r));
    }
    if (category === 'all' || category === 'playlists') {
      for (const r of playlists) {
        items.push(mediaCollection({
          id: `playlist:${r.id}`,
          itemType: 'playlist',
          title: r.name || r.title || '',
          albumArtURI: r.cover_url || r.img || r.image_url || '',
          canPlay: true,
          canEnumerate: true,
        }));
      }
    }
  } catch (err) {
    console.log(`[search] Full search failed: ${err.message}, falling back to quick search`);
  }

  // Fallback to quick search if full search returned nothing
  if (items.length === 0) {
    const results = await searchQuick(term);
    console.log(`[search] Quick search: ${results.length} results`);
    for (const r of results) {
      if (r.type === 'content' && (category === 'all' || category === 'tracks')) {
        items.push(trackItem(r));
      } else if (r.type === 'collection' && (category === 'all' || category === 'albums')) {
        items.push(albumItem(r));
      } else if (r.type === 'artist' && (category === 'all' || category === 'artists')) {
        items.push(artistItem(r));
      }
    }
  }

  const sliced = items.slice(index, index + count);
  console.log(`[search] Returning ${sliced.length} of ${items.length} items`);
  return resultResponse('search', sliced, index, items.length);
}

module.exports = search;
