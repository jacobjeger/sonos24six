const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { login, getCookieHeader, getXsrfHeader, getInertiaVersion } = require('./auth');

const BASE = 'https://24six.app';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Device ID captured from API responses (required for streaming)
let deviceId = null;

// Simple in-memory cache
const cache = new Map();

// Track metadata cache — populated when tracks are listed, used by getMediaMetadata
const trackCache = new Map();

// Album/collection metadata cache — populated during browsing/prewarm
const albumCache = new Map();

function cacheTrack(track) {
  if (!track || !track.id) return;
  // Normalize: pull artist/image from nested collection if missing on track
  if (track.collection) {
    if (!track.subtitle && !hasArtists(track)) {
      // Try collection's subtitle or artists
      if (track.collection.subtitle) {
        track.subtitle = track.collection.subtitle;
      } else if (track.collection.artists && track.collection.artists.length > 0) {
        track.subtitle = track.collection.artists[0].name || '';
        if (!track.artists || track.artists.length === 0) {
          track.artists = track.collection.artists;
        }
      }
    }
    if (!track.img && !track.content_image_url) {
      track.img = track.collection.cover_url || track.collection.img || '';
    }
  }
  trackCache.set(String(track.id), track);
}

function hasArtists(track) {
  return track.artists && track.artists.length > 0 && track.artists[0] && track.artists[0].name;
}

function getCachedTrack(id) {
  return trackCache.get(String(id)) || null;
}

function cacheAlbum(album) {
  if (!album || !album.id) return;
  albumCache.set(String(album.id), album);
}

function getCachedAlbum(id) {
  return albumCache.get(String(id)) || null;
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function clearCache() {
  cache.clear();
}

function defaultHeaders() {
  const headers = {
    'Cookie': getCookieHeader(),
    'X-XSRF-TOKEN': getXsrfHeader(),
    'X-Inertia': 'true',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, application/xhtml+xml',
  };
  const ver = getInertiaVersion();
  if (ver) headers['X-Inertia-Version'] = ver;
  return headers;
}

async function apiRequest(method, url, body, useCache) {
  const cacheKey = useCache ? `${method}:${url}` : null;
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const opts = {
    method,
    headers: defaultHeaders(),
    redirect: 'manual',
  };

  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res = await fetch(url, opts);

  // Auto-relogin on 401/403
  if (res.status === 401 || res.status === 403) {
    console.log(`[client] Got ${res.status}, re-logging in...`);
    clearCache();
    await login();
    opts.headers = defaultHeaders();
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    res = await fetch(url, opts);
  }

  // Inertia 409 = version mismatch, fall back to full HTML page
  if (res.status === 409) {
    console.log(`[client] Inertia 409 — fetching full HTML page instead`);
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': getCookieHeader(),
        'Accept': 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
    });
  }

  console.log(`[client] ${method} ${url} → status ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Response is HTML — extract Inertia data from data-page attribute
    const $ = cheerio.load(text);
    const dataPage = $('[data-page]').attr('data-page');
    if (dataPage) {
      try {
        data = JSON.parse(dataPage);
        console.log(`[client]   extracted Inertia data from HTML, keys:`, Object.keys(data));
      } catch {
        console.log(`[client] Could not parse data-page JSON`);
        data = {};
      }
    } else {
      console.log(`[client] Non-JSON, no data-page (${text.length} chars):`, text.substring(0, 300));
      data = {};
    }
  }

  if (Object.keys(data).length > 0) {
    console.log(`[client]   response keys:`, Object.keys(data));
    if (data.props) {
      console.log(`[client]   props keys:`, Object.keys(data.props));
      // Capture device_id from API responses (needed for streaming)
      if (data.props.device_id) {
        deviceId = data.props.device_id;
        console.log(`[client]   captured device_id: ${deviceId}`);
      }
    }
  }

  if (cacheKey) setCache(cacheKey, data);
  return data;
}

// Library endpoints
async function getPlaylists() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/playlist`, undefined, true);
  return (data.props && data.props.data) || [];
}

async function getAlbums() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/collection`, undefined, true);
  return (data.props && data.props.data) || [];
}

async function getArtists() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/artist`, undefined, true);
  return (data.props && data.props.data) || [];
}

async function getLikedSongs() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/content`, undefined, true);
  return (data.props && data.props.data) || [];
}

// Content endpoints
async function getPlaylistContents(id) {
  // GET returns playlist with contents[]; POST adds a song to playlist per API ref
  const data = await apiRequest('GET', `${BASE}/app/music/playlist/${id}`, undefined, false);
  // Inertia page wraps in props.playlist or props.collection
  const props = data.props || {};
  const playlist = props.playlist || props.collection || data;
  return playlist;
}

async function getAlbumContents(id) {
  // GET with Inertia headers returns props.collection with contents[]
  // POST only returns collection metadata without contents
  const data = await apiRequest('GET', `${BASE}/app/music/collection/${id}`, undefined, false);
  const props = data.props || data;
  const collection = props.collection || data;
  const albumArtists = props.artists || collection.artists || [];
  const albumArtist = props.artist || (albumArtists[0]) || null;
  const albumImg = collection.cover_url || collection.img || '';
  const albumName = collection.name || collection.title || '';

  console.log(`[client] Album ${id} contents keys:`, Object.keys(collection));
  if (collection.contents) {
    console.log(`[client] Album ${id}: ${collection.contents.length} tracks`);
    // Enrich each track with album info if missing
    for (const t of collection.contents) {
      if (!t.subtitle && albumArtist) {
        t.subtitle = albumArtist.name || albumArtist.title || '';
      }
      if (!t.img && albumImg) {
        t.img = albumImg;
      }
      if (!t.artists || t.artists.length === 0) {
        t.artists = albumArtists.length > 0 ? albumArtists : (albumArtist ? [albumArtist] : []);
      }
      if (!t.collection) {
        t.collection = { id: collection.id, name: albumName, title: albumName, artists: albumArtists };
      }
    }
  } else {
    console.log(`[client] Album ${id}: no contents field found`);
  }
  return collection;
}

async function getAlbumExtras(albumId) {
  const data = await apiRequest('GET', `${BASE}/app/music/collection/${albumId}/extras`, undefined, true);
  return (data && data.albums) || [];
}

async function getStreamUrl(trackId) {
  const url = `${BASE}/app/content/${trackId}/begin`;

  // Ensure we have a device_id (fetch a library page if needed)
  if (!deviceId) {
    console.log(`[getStreamUrl] No device_id cached, fetching from library...`);
    await getPlaylists();
  }
  if (!deviceId) {
    console.log(`[getStreamUrl] Still no device_id after library fetch!`);
    return null;
  }

  async function doStreamRequest() {
    const headers = {
      'Cookie': getCookieHeader(),
      'X-XSRF-TOKEN': getXsrfHeader(),
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({ device_id: deviceId, interaction: true });
    console.log(`[getStreamUrl] POST ${url} with device_id=${deviceId}`);

    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual' });
    console.log(`[getStreamUrl] Response status: ${res.status}`);

    // If redirect, check Location header for stream URL
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      console.log(`[getStreamUrl] Redirect Location: ${location}`);
      if (location && !location.includes('24six.app/app/') && !location.includes('24six.app/login')) {
        return location;
      }
      return null;
    }

    // Parse JSON response
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      console.log(`[getStreamUrl] Response keys:`, Object.keys(data));
      if (data.message) console.log(`[getStreamUrl] Message:`, data.message);
      if (data.errors) console.log(`[getStreamUrl] Errors:`, JSON.stringify(data.errors));
      if (data.url) return data.url;
      if (data.stream_url) return data.stream_url;
      if (data.src) return data.src;
    } catch {
      console.log(`[getStreamUrl] Non-JSON response (${text.length} chars):`, text.substring(0, 200));
    }

    return null;
  }

  // Try with current session
  let result = await doStreamRequest();
  if (result) return result;

  // Re-login and retry once
  console.log(`[getStreamUrl] First attempt failed, re-logging in...`);
  clearCache();
  await login();
  // Re-fetch device_id after login
  deviceId = null;
  await getPlaylists();

  result = await doStreamRequest();
  if (result) return result;

  console.log(`[getStreamUrl] All attempts failed for track ${trackId}`);
  return null;
}

async function getFeatured() {
  const data = await apiRequest('GET', `${BASE}/app/music/featured-homepage`, undefined, true);
  const props = data.props || data;
  console.log(`[client] Featured homepage props keys:`, Object.keys(props));
  // Debug: dump shapes of all props
  for (const key of Object.keys(props)) {
    if (['errors', 'device_id', 'meta'].includes(key)) continue;
    const val = props[key];
    if (Array.isArray(val)) {
      console.log(`[client] Featured props.${key}: array(${val.length})${val.length > 0 ? ' first=' + JSON.stringify(Object.keys(val[0] || {})) : ''}`);
    } else if (val && typeof val === 'object') {
      console.log(`[client] Featured props.${key}: object keys=${JSON.stringify(Object.keys(val))}`);
    } else {
      console.log(`[client] Featured props.${key}: ${typeof val}`);
    }
  }
  // Return the full props so the handler can pick what it needs
  return props;
}

// Artist page — returns artist info with top songs, albums, etc.
async function getArtistPage(artistId) {
  const data = await apiRequest('GET', `${BASE}/app/music/artist/${artistId}`, undefined, true);
  const props = data.props || data;
  console.log(`[client] Artist ${artistId} props keys:`, Object.keys(props));

  // Debug: dump raw shapes of key fields
  for (const key of ['albums', 'collections', 'top_songs', 'latest', 'featured_on', 'artist']) {
    const val = props[key];
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      console.log(`[client] Artist ${artistId} props.${key}: array(${val.length})`);
    } else if (val && typeof val === 'object') {
      console.log(`[client] Artist ${artistId} props.${key}: object keys=${JSON.stringify(Object.keys(val))}`);
      if (val.data) console.log(`[client] Artist ${artistId} props.${key}.data: array(${Array.isArray(val.data) ? val.data.length : typeof val.data})`);
    } else {
      console.log(`[client] Artist ${artistId} props.${key}: ${typeof val} = ${JSON.stringify(val)}`);
    }
  }

  // Extract albums — can be array or paginated object with .data
  const rawAlbums = props.albums || props.collections || [];
  const albums = Array.isArray(rawAlbums) ? rawAlbums : (rawAlbums.data || []);

  // Extract top songs
  const rawSongs = props.top_songs || [];
  const topSongs = Array.isArray(rawSongs) ? rawSongs : (rawSongs.data || []);

  console.log(`[client] Artist ${artistId}: ${albums.length} albums, ${topSongs.length} top songs`);

  return {
    artist: props.artist || props,
    albums,
    topSongs,
    latest: props.latest || [],
    featuredOn: props.featured_on || [],
  };
}

// Quick search (typeahead) — POST returns flat array of mixed results
async function searchQuick(term) {
  const data = await apiRequest('POST', `${BASE}/app/music/search/quick`, { q: term }, false);
  return Array.isArray(data) ? data : [];
}

// Full search — GET returns categorized results (songs, albums, artists, playlists)
async function searchFull(term) {
  const data = await apiRequest('GET', `${BASE}/app/music/search?q=${encodeURIComponent(term)}`, undefined, false);
  const props = data.props || data;
  console.log(`[client] Full search response keys:`, Object.keys(props));
  return props;
}

// Fetch individual track metadata — POST returns track directly (no Inertia wrapper)
async function getTrackInfo(trackId) {
  console.log(`[client] Fetching track info for ${trackId}`);

  // POST /app/music/content/{id} — returns raw track object (no Inertia headers needed)
  try {
    const res = await fetch(`${BASE}/app/music/content/${trackId}`, {
      method: 'POST',
      headers: {
        'Cookie': getCookieHeader(),
        'X-XSRF-TOKEN': getXsrfHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
      },
      redirect: 'manual',
    });
    console.log(`[client] POST track ${trackId} → status ${res.status}`);
    if (res.ok) {
      const postData = await res.json();
      console.log(`[client] POST track ${trackId} response keys:`, Object.keys(postData));
      if (postData && postData.id && postData.title) {
        console.log(`[client] Track info (POST): title="${postData.title}" artists=${JSON.stringify(postData.artists?.map(a => a.name))} collection=${postData.collection?.name || 'none'}`);
        cacheTrack(postData);
        return postData;
      }
    }
  } catch (err) {
    console.log(`[client] POST track ${trackId} failed: ${err.message}`);
  }

  // Fallback: GET with Inertia returns page with content in props
  console.log(`[client] Trying GET for track ${trackId}...`);
  const data = await apiRequest('GET', `${BASE}/app/music/content/${trackId}`, undefined, false);
  const props = data.props || data;
  console.log(`[client] GET track ${trackId} response keys:`, Object.keys(props));
  const track = props.content || props.track || props;
  if (track && track.id) {
    console.log(`[client] Track info (GET): title="${track.title}" subtitle="${track.subtitle}" img="${track.img}" artists=${JSON.stringify(track.artists?.map(a => a.name))}`);
    cacheTrack(track);
    return track;
  }
  console.log(`[client] Could not extract track from response`);
  return null;
}

// Pre-warm the track cache on startup
async function prewarmCache() {
  console.log(`[cache] Pre-warming track cache...`);
  let totalCached = 0;

  try {
    // 1. Cache liked songs
    const likedSongs = await getLikedSongs();
    for (const s of likedSongs) {
      cacheTrack(s);
      totalCached++;
    }
    console.log(`[cache] Cached ${likedSongs.length} liked songs`);

    // 2. Get playlists and cache their contents (up to 10)
    const playlists = await getPlaylists();
    const playlistSlice = playlists.slice(0, 10);
    let loggedFirstPlaylistTrack = false;
    for (const p of playlistSlice) {
      try {
        const data = await getPlaylistContents(p.id);
        const tracks = data.contents || [];
        // Log raw first track from first playlist for field verification
        if (!loggedFirstPlaylistTrack && tracks.length > 0) {
          console.log(`[cache] RAW playlist track object keys:`, Object.keys(tracks[0]));
          console.log(`[cache] RAW playlist track[0]:`, JSON.stringify(tracks[0]).substring(0, 500));
          loggedFirstPlaylistTrack = true;
        }
        for (const t of tracks) {
          cacheTrack(t);
          totalCached++;
        }
        console.log(`[cache] Playlist "${p.title || p.id}": ${tracks.length} tracks`);
      } catch (err) {
        console.log(`[cache] Failed to fetch playlist ${p.id}: ${err.message}`);
      }
    }

    // 3. Get albums and cache their contents (up to 20)
    const albums = await getAlbums();
    // Log raw first album object for field verification
    if (albums.length > 0) {
      console.log(`[cache] RAW album object keys:`, Object.keys(albums[0]));
      console.log(`[cache] RAW album[0]:`, JSON.stringify(albums[0]).substring(0, 500));
    }
    // Cache album metadata
    for (const a of albums) {
      cacheAlbum(a);
    }
    const albumSlice = albums.slice(0, 20);
    for (const a of albumSlice) {
      try {
        const data = await getAlbumContents(a.id);
        // getAlbumContents now returns the collection object with contents[]
        if (data && data.id) {
          cacheAlbum(data);
        }
        const tracks = data.contents || [];
        for (const t of tracks) {
          cacheTrack(t);
          totalCached++;
        }
        console.log(`[cache] Album "${a.title || a.name || a.id}": ${tracks.length} tracks`);
      } catch (err) {
        console.log(`[cache] Failed to fetch album ${a.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[cache] Pre-warm error:`, err.message);
  }

  console.log(`[cache] Cache warmed: ${totalCached} tracks (${trackCache.size} unique)`);

  // Log first 3 cached entries for field verification
  let count = 0;
  for (const [id, track] of trackCache) {
    if (count >= 3) break;
    console.log(`[cache] Sample track ${id}:`, JSON.stringify({
      id: track.id,
      title: track.title,
      subtitle: track.subtitle,
      img: track.img ? track.img.substring(0, 60) : null,
      length: track.length,
      collection_id: track.collection_id,
      artist_id: track.artist_id,
      artists: track.artists,
    }));
    count++;
  }
}

module.exports = {
  getPlaylists,
  getAlbums,
  getArtists,
  getLikedSongs,
  getPlaylistContents,
  getAlbumContents,
  getAlbumExtras,
  getArtistPage,
  getStreamUrl,
  getFeatured,
  searchQuick,
  searchFull,
  clearCache,
  cacheTrack,
  getCachedTrack,
  cacheAlbum,
  getCachedAlbum,
  getTrackInfo,
  prewarmCache,
};
