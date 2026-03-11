const fetch = require('node-fetch');
const cheerio = require('cheerio');

const BASE = 'https://24six.app';

// Module-level cookie jar and state
let cookies = {};
let loggedIn = false;
let inertiaVersion = '';

function parseCookies(response) {
  const raw = response.headers.raw()['set-cookie'];
  if (!raw) return;
  for (const header of raw) {
    const parts = header.split(';')[0].split('=');
    const name = parts[0].trim();
    const value = parts.slice(1).join('=').trim();
    cookies[name] = value;
  }
}

function getCookieHeader() {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function getXsrfHeader() {
  const token = cookies['XSRF-TOKEN'];
  if (!token) return '';
  return decodeURIComponent(token);
}

async function login() {
  const email = process.env.TWENTYFOUR_EMAIL;
  const password = process.env.TWENTYFOUR_PASSWORD;
  const profileId = parseInt(process.env.TWENTYFOUR_PROFILE_ID || '46901', 10);

  if (!email || !password) {
    throw new Error('TWENTYFOUR_EMAIL and TWENTYFOUR_PASSWORD must be set');
  }

  console.log('[auth] Starting login flow...');
  cookies = {};
  loggedIn = false;

  // Step 1: Scrape CSRF token from login page
  const loginPage = await fetch(`${BASE}/login`, { redirect: 'manual' });
  parseCookies(loginPage);
  const html = await loginPage.text();
  const $ = cheerio.load(html);
  const csrfToken = $('input[name="_token"]').val();
  if (!csrfToken) {
    throw new Error('[auth] Could not find _token in login page');
  }

  // Extract Inertia version from page (data-page attribute or @inertiaHead)
  const dataPage = $('[data-page]').attr('data-page');
  if (dataPage) {
    try {
      const pageData = JSON.parse(dataPage);
      inertiaVersion = pageData.version || '';
      console.log('[auth] Got Inertia version:', inertiaVersion);
    } catch {}
  }
  if (!inertiaVersion) {
    // Try to find version in inline script
    const scriptMatch = html.match(/version["']\s*:\s*["']([^"']+)["']/);
    if (scriptMatch) {
      inertiaVersion = scriptMatch[1];
      console.log('[auth] Got Inertia version from script:', inertiaVersion);
    }
  }

  console.log('[auth] Got CSRF token');

  // Step 2: Submit credentials
  const body = new URLSearchParams({
    _token: csrfToken,
    email,
    password,
  });
  const checkUser = await fetch(`${BASE}/check-existing-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE}/login`,
      'Cookie': getCookieHeader(),
    },
    body: body.toString(),
    redirect: 'manual',
  });
  parseCookies(checkUser);
  console.log('[auth] Credentials submitted, status:', checkUser.status);

  // Step 3: Pin check
  const pinCheck = await fetch(`${BASE}/profiles/pin-check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': getXsrfHeader(),
      'Cookie': getCookieHeader(),
    },
    body: JSON.stringify({ profile_id: profileId }),
    redirect: 'manual',
  });
  parseCookies(pinCheck);
  console.log('[auth] Pin check, status:', pinCheck.status);

  // Step 4: Profile login
  const profileLogin = await fetch(`${BASE}/profiles/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': getXsrfHeader(),
      'Cookie': getCookieHeader(),
    },
    body: JSON.stringify({ profile: profileId, pin: null }),
    redirect: 'manual',
  });
  parseCookies(profileLogin);
  console.log('[auth] Profile login, status:', profileLogin.status);

  loggedIn = true;
  console.log('[auth] Login complete');
}

function isLoggedIn() {
  return loggedIn;
}

function getInertiaVersion() {
  return inertiaVersion;
}

module.exports = { login, getCookieHeader, getXsrfHeader, getInertiaVersion, isLoggedIn };
