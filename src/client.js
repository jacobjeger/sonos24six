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

// Artist metadata cache — populated during browsing
const artistCache = new Map();

// Playlist metadata cache — populated during browsing
const playlistCache = new Map();

function cacheTrack(track) {
  if (!track || !track.id) return;
  if (track.collection) {
    if (!track.subtitle && !hasArtists(track)) {
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
  const contentId = track.content_id || track.id;
  trackCache.set(String(contentId), track);
  if (String(track.id) !== String(contentId)) {
    trackCache.set(String(track.id), track);
  }
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

function cacheArtist(artist) {
  if (!artist || !artist.id) return;
  artistCache.set(String(artist.id), artist);
}

function getCachedArtist(id) {
  return artistCache.get(String(id)) || null;
}

function cachePlaylist(playlist) {
  if (!playlist || !playlist.id) return;
  playlistCache.set(String(playlist.id), playlist);
}

function getCachedPlaylist(id) {
  return playlistCache.get(String(id)) || null;
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
    console.log(`[client] ${res.status} on ${url}, re-logging in`);
    clearCache();
    await login();
    opts.headers = defaultHeaders();
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    res = await fetch(url, opts);
  }

  // Inertia 409 = version mismatch, fall back to full HTML page
  if (res.status === 409) {
    console.log(`[client] Inertia 409, fetching HTML for ${url}`);
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': getCookieHeader(),
        'Accept': 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
    });
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const $ = cheerio.load(text);
    const dataPage = $('[data-page]').attr('data-page');
    if (dataPage) {
      try {
        data = JSON.parse(dataPage);
      } catch {
        console.error(`[client] Failed to parse data-page JSON from ${url}`);
        data = {};
      }
    } else {
      console.error(`[client] Non-JSON, no data-page from ${url} (${res.status})`);
      data = {};
    }
  }

  // Capture device_id from API responses (needed for streaming)
  if (data.props && data.props.device_id) {
    deviceId = data.props.device_id;
  }

  if (cacheKey) setCache(cacheKey, data);
  return data;
}

// Helper: extract array from API response (handles .data, .tiles, direct array)
function extractList(data, label) {
  const props = data.props || data;
  if (!props) return [];
  const raw = props.data;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (raw.tiles) return raw.tiles;
    if (raw.data) return raw.data;
  }
  for (const key of Object.keys(props)) {
    if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
    const val = props[key];
    if (Array.isArray(val) && val.length > 0 && val[0] && val[0].id) {
      return val;
    }
  }
  console.log(`[client] extractList(${label}): no data found`);
  return [];
}

// Library endpoints
async function getPlaylists() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/playlist`, undefined, true);
  return extractList(data, 'playlists');
}

async function getAlbums() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/collection`, undefined, true);
  return extractList(data, 'albums');
}

async function getArtists() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/artist`, undefined, true);
  return extractList(data, 'artists');
}

async function getLikedSongs() {
  const data = await apiRequest('GET', `${BASE}/app/music/library/content`, undefined, true);
  return extractList(data, 'liked-songs');
}

// Content endpoints
async function getPlaylistContents(id) {
  const data = await apiRequest('GET', `${BASE}/app/music/playlist/${id}`, undefined, false);
  const props = data.props || {};
  return props.playlist || props.collection || data;
}

async function getAlbumContents(id) {
  const data = await apiRequest('GET', `${BASE}/app/music/collection/${id}`, undefined, false);
  const props = data.props || data || {};
  const collection = props.collection || props || {};
  const albumArtists = props.artists || (collection && collection.artists) || [];
  const albumArtist = props.artist || (albumArtists[0]) || null;
  const albumImg = (collection && (collection.cover_url || collection.img)) || '';
  const albumName = (collection && (collection.name || collection.title)) || '';

  if (collection.contents) {
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
  }
  return collection;
}

async function getAlbumExtras(albumId) {
  const data = await apiRequest('GET', `${BASE}/app/music/collection/${albumId}/extras`, undefined, true);
  return (data && data.albums) || [];
}

async function getStreamUrl(trackId) {
  const url = `${BASE}/app/content/${trackId}/begin`;

  if (!deviceId) {
    await getPlaylists();
  }
  if (!deviceId) {
    console.error(`[client] No device_id available for streaming`);
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

    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location && !location.includes('24six.app/app/') && !location.includes('24six.app/login')) {
        return location;
      }
      return null;
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (data.url) return data.url;
      if (data.stream_url) return data.stream_url;
      if (data.src) return data.src;
      if (data.errors) console.error(`[client] Stream error for ${trackId}:`, JSON.stringify(data.errors));
    } catch {
      // non-JSON response
    }

    return null;
  }

  let result = await doStreamRequest();
  if (result) return result;

  // Re-login and retry once
  console.log(`[client] Stream failed for ${trackId}, re-logging in`);
  clearCache();
  await login();
  deviceId = null;
  await getPlaylists();

  result = await doStreamRequest();
  if (!result) console.error(`[client] All stream attempts failed for ${trackId}`);
  return result;
}

async function getFeatured() {
  const data = await apiRequest('GET', `${BASE}/app/music/featured-homepage`, undefined, true);
  return data.props || data;
}

async function getArtistPage(artistId) {
  const data = await apiRequest('GET', `${BASE}/app/music/artist/${artistId}`, undefined, true);
  const props = data.props || data;

  const rawAlbums = props.albums || props.collections || [];
  const albums = Array.isArray(rawAlbums) ? rawAlbums : (rawAlbums.tiles || rawAlbums.data || []);

  const rawSongs = props.top_songs || [];
  const topSongs = Array.isArray(rawSongs) ? rawSongs : (rawSongs.tiles || rawSongs.data || []);

  const rawFeatured = props.featured_on || [];
  const featuredOn = Array.isArray(rawFeatured) ? rawFeatured : (rawFeatured.tiles || rawFeatured.data || []);

  const latest = props.latest || null;

  return {
    artist: props.artist || props,
    albums,
    topSongs,
    latest,
    featuredOn,
  };
}

async function searchQuick(term) {
  const data = await apiRequest('POST', `${BASE}/app/music/search/quick`, { q: term }, false);
  return Array.isArray(data) ? data : [];
}

async function searchFull(term) {
  const data = await apiRequest('GET', `${BASE}/app/music/search?q=${encodeURIComponent(term)}`, undefined, false);
  return data.props || data;
}

async function getTrackInfo(trackId) {
  // POST /app/music/content/{id} — returns raw track object
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
    if (res.ok) {
      const postData = await res.json();
      if (postData && postData.id && postData.title) {
        cacheTrack(postData);
        return postData;
      }
    }
  } catch (err) {
    console.error(`[client] POST track ${trackId} failed: ${err.message}`);
  }

  // Fallback: GET with Inertia
  const data = await apiRequest('GET', `${BASE}/app/music/content/${trackId}`, undefined, false);
  const props = data.props || data;
  const track = props.content || props.track || props;
  if (track && track.id) {
    cacheTrack(track);
    return track;
  }
  return null;
}

async function prewarmCache() {
  console.log(`[cache] Pre-warming...`);
  let totalCached = 0;

  try {
    const likedSongs = await getLikedSongs();
    for (const s of likedSongs) { cacheTrack(s); totalCached++; }

    const playlists = await getPlaylists();
    for (const p of playlists.slice(0, 10)) {
      try {
        const data = await getPlaylistContents(p.id);
        for (const t of (data.contents || [])) { cacheTrack(t); totalCached++; }
      } catch (err) {
        console.error(`[cache] Playlist ${p.id} failed: ${err.message}`);
      }
    }

    const albums = await getAlbums();
    for (const a of albums) { cacheAlbum(a); }
    for (const a of albums.slice(0, 20)) {
      try {
        const data = await getAlbumContents(a.id);
        if (data && data.id) cacheAlbum(data);
        for (const t of (data.contents || [])) { cacheTrack(t); totalCached++; }
      } catch (err) {
        console.error(`[cache] Album ${a.id} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[cache] Pre-warm error:`, err.message);
  }

  console.log(`[cache] Warmed: ${totalCached} tracks (${trackCache.size} unique)`);
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
  cacheArtist,
  getCachedArtist,
  cachePlaylist,
  getCachedPlaylist,
  getTrackInfo,
  prewarmCache,
};
