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
  console.log(`[search] Called with id=${id} term=${term} index=${index} count=${count}`);
  if (!term) {
    return resultResponse('search', [], 0, 0);
  }

  // Normalize category — handle any format: search:all, All, SEARCH:ALL, etc.
  let category = 'all';
  if (id) {
    category = id.replace(/^search[_:]?/i, '').toLowerCase() || 'all';
  }
  console.log(`[search] Searching for "${term}" in category "${category}"`);

  let items = [];

  // Try full search first (GET /app/music/search?q=) — returns categorized results
  try {
    const props = await searchFull(term);
    const propKeys = Object.keys(props || {});
    console.log(`[search] Full search props keys:`, propKeys);

    function extractArr(val) {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (val.tiles) return val.tiles;
      if (val.data) return val.data;
      if (val.items) return val.items;
      return [];
    }

    const songs = extractArr(props.songs || props.contents || props.content);
    const albums = extractArr(props.collections || props.albums);
    const artists = extractArr(props.artists);
    const playlists = extractArr(props.playlists);

    console.log(`[search] Full search results: ${songs.length} songs, ${albums.length} albums, ${artists.length} artists, ${playlists.length} playlists`);

    // If no categorized results, scan all props for arrays of items
    if (songs.length === 0 && albums.length === 0 && artists.length === 0 && playlists.length === 0) {
      console.log(`[search] No categorized results, scanning all props...`);
      for (const key of propKeys) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const val = props[key];
        const arr = extractArr(val);
        if (arr.length > 0) {
          console.log(`[search] Found ${arr.length} items in props.${key}`);
          for (const r of arr) {
            if (!r || !r.id) continue;
            const type = r.type || (r.contents !== undefined ? 'playlist' : (r.is_artist ? 'artist' : ''));
            if (type === 'content' || r.length || r.length_in_seconds) {
              items.push(trackItem(r));
            } else if (type === 'artist' || r.is_artist) {
              items.push(artistItem(r));
            } else if (type === 'collection' || r.cover_url) {
              items.push(albumItem(r));
            } else {
              items.push(trackItem(r));
            }
          }
        }
      }
    } else {
      if (category === 'all' || category === 'tracks') {
        for (const r of songs) if (r && r.id) items.push(trackItem(r));
      }
      if (category === 'all' || category === 'albums') {
        for (const r of albums) if (r && r.id) items.push(albumItem(r));
      }
      if (category === 'all' || category === 'artists') {
        for (const r of artists) if (r && r.id) items.push(artistItem(r));
      }
      if (category === 'all' || category === 'playlists') {
        for (const r of playlists) {
          if (!r || !r.id) continue;
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
    }
  } catch (err) {
    console.log(`[search] Full search failed: ${err.message}, falling back to quick search`);
  }

  // Fallback to quick search if full search returned nothing
  if (items.length === 0) {
    try {
      const results = await searchQuick(term);
      console.log(`[search] Quick search: ${results.length} results`);
      for (const r of results) {
        if (!r || !r.id) continue;
        if (r.type === 'content' && (category === 'all' || category === 'tracks')) {
          items.push(trackItem(r));
        } else if (r.type === 'collection' && (category === 'all' || category === 'albums')) {
          items.push(albumItem(r));
        } else if (r.type === 'artist' && (category === 'all' || category === 'artists')) {
          items.push(artistItem(r));
        } else if (category === 'all') {
          items.push(trackItem(r));
        }
      }
    } catch (err) {
      console.error(`[search] Quick search also failed: ${err.message}`);
    }
  }

  const sliced = items.slice(index, index + count);
  console.log(`[search] Returning ${sliced.length} of ${items.length} items`);
  const xml = resultResponse('search', sliced, index, items.length);
  // Log response snippet for debugging Sonos "No results" issue
  console.log(`[search] Response XML length: ${xml.length}, first 600 chars:`);
  console.log(xml.substring(0, 600));
  return xml;
}

module.exports = search;
