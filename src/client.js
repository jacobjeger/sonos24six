const fetch = require('node-fetch');
const { login, getCookieHeader, getXsrfHeader } = require('./auth');

const BASE = 'https://24six.app';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache
const cache = new Map();

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
  return {
    'Cookie': getCookieHeader(),
    'X-XSRF-TOKEN': getXsrfHeader(),
    'X-Inertia': 'true',
    'X-Inertia-Version': '',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, application/xhtml+xml',
  };
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
    opts.headers = { ...opts.headers, ...defaultHeaders() };
    res = await fetch(url, opts);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Some endpoints may redirect or return non-JSON
    console.log(`[client] Non-JSON response from ${url}:`, text.substring(0, 200));
    data = {};
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
  const data = await apiRequest('POST', `${BASE}/app/music/playlist/${id}`, undefined, false);
  return data;
}

async function getAlbumContents(id) {
  const data = await apiRequest('POST', `${BASE}/app/music/collection/${id}`, undefined, false);
  return data;
}

async function getStreamUrl(trackId) {
  const data = await apiRequest('POST', `${BASE}/app/content/${trackId}/begin`, undefined, false);
  return data.url || null;
}

async function getFeatured() {
  const data = await apiRequest('GET', `${BASE}/app/music/featured-homepage`, undefined, true);
  return (data.props && data.props.data) || data || [];
}

// Search helper — filter in-memory library data
async function searchLibrary(term) {
  const lower = term.toLowerCase();
  const results = [];

  const [playlists, albums, artists, songs] = await Promise.all([
    getPlaylists(),
    getAlbums(),
    getArtists(),
    getLikedSongs(),
  ]);

  for (const p of playlists) {
    if (p.title && p.title.toLowerCase().includes(lower)) {
      results.push({ type: 'playlist', ...p });
    }
  }
  for (const a of albums) {
    if ((a.title && a.title.toLowerCase().includes(lower)) ||
        (a.subtitle && a.subtitle.toLowerCase().includes(lower))) {
      results.push({ type: 'album', ...a });
    }
  }
  for (const a of artists) {
    if (a.name && a.name.toLowerCase().includes(lower)) {
      results.push({ type: 'artist', ...a });
    }
  }
  for (const s of songs) {
    if ((s.title && s.title.toLowerCase().includes(lower)) ||
        (s.subtitle && s.subtitle.toLowerCase().includes(lower))) {
      results.push({ type: 'track', ...s });
    }
  }

  return results;
}

module.exports = {
  getPlaylists,
  getAlbums,
  getArtists,
  getLikedSongs,
  getPlaylistContents,
  getAlbumContents,
  getStreamUrl,
  getFeatured,
  searchLibrary,
  clearCache,
};
