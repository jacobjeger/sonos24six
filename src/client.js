const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { login, getCookieHeader, getXsrfHeader, getInertiaVersion } = require('./auth');

const BASE = 'https://24six.app';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Device ID captured from API responses (required for streaming)
let deviceId = null;

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
  const data = await apiRequest('POST', `${BASE}/app/music/playlist/${id}`, undefined, false);
  return data;
}

async function getAlbumContents(id) {
  const data = await apiRequest('POST', `${BASE}/app/music/collection/${id}`, undefined, false);
  return data;
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
    const body = JSON.stringify({ device_id: deviceId });
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
