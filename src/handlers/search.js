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

// Simple search cache — Sonos may re-query the same term quickly
const searchCache = new Map();
const CACHE_TTL = 60000; // 60 seconds

function getCachedSearch(key) {
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.xml;
  searchCache.delete(key);
  return null;
}

async function search({ id, term, index, count }) {
  const t0 = Date.now();
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

  // Check cache first — instant response for repeated searches
  const cacheKey = `${category}:${term}:${index}:${count}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`[search] Cache hit for "${term}" (${Date.now() - t0}ms)`);
    return cached;
  }

  let items = [];

  function extractArr(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (val.tiles) return val.tiles;
    if (val.data) return val.data;
    if (val.items) return val.items;
    return [];
  }

  // Run BOTH searches in parallel — total time = max(full, quick) instead of full + quick
  const [fullResult, quickResult] = await Promise.allSettled([
    searchFull(term),
    searchQuick(term),
  ]);

  console.log(`[search] API calls done in ${Date.now() - t0}ms (full: ${fullResult.status}, quick: ${quickResult.status})`);

  // Try full search results first (better categorization)
  if (fullResult.status === 'fulfilled' && fullResult.value) {
    const props = fullResult.value;
    const propKeys = Object.keys(props || {});

    const songs = extractArr(props.songs || props.contents || props.content);
    const albums = extractArr(props.collections || props.albums);
    const artists = extractArr(props.artists);
    const playlists = extractArr(props.playlists);

    console.log(`[search] Full: ${songs.length} songs, ${albums.length} albums, ${artists.length} artists, ${playlists.length} playlists`);

    if (songs.length === 0 && albums.length === 0 && artists.length === 0 && playlists.length === 0) {
      for (const key of propKeys) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const arr = extractArr(props[key]);
        for (const r of arr) {
          if (!r || !r.id) continue;
          const type = r.type || (r.contents !== undefined ? 'playlist' : (r.is_artist ? 'artist' : ''));
          if (type === 'content' || r.length || r.length_in_seconds) items.push(trackItem(r));
          else if (type === 'artist' || r.is_artist) items.push(artistItem(r));
          else if (type === 'collection' || r.cover_url) items.push(albumItem(r));
          else items.push(trackItem(r));
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
  }

  // Fallback to quick search if full search returned nothing
  if (items.length === 0 && quickResult.status === 'fulfilled' && quickResult.value) {
    const results = quickResult.value;
    console.log(`[search] Using quick search fallback: ${results.length} results`);
    for (const r of results) {
      if (!r || !r.id) continue;
      if (r.type === 'content' && (category === 'all' || category === 'tracks')) items.push(trackItem(r));
      else if (r.type === 'collection' && (category === 'all' || category === 'albums')) items.push(albumItem(r));
      else if (r.type === 'artist' && (category === 'all' || category === 'artists')) items.push(artistItem(r));
      else if (category === 'all') items.push(trackItem(r));
    }
  }

  const sliced = items.slice(index, index + count);
  const elapsed = Date.now() - t0;
  console.log(`[search] Returning ${sliced.length} of ${items.length} items (${elapsed}ms)`);
  const xml = resultResponse('search', sliced, index, items.length);

  // Cache the response for quick repeat lookups
  searchCache.set(cacheKey, { xml, ts: Date.now() });

  // Warn if slow — Sonos likely times out around 3-5s
  if (elapsed > 3000) {
    console.warn(`[search] SLOW RESPONSE: ${elapsed}ms — Sonos may have timed out!`);
  }

  return xml;
}

module.exports = search;
