require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const { login } = require('./auth');
const { dispatch } = require('./soap');
const { getStreamUrl } = require('./client');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Sonos SMAPI WSDL / GET endpoint — Sonos verifies reachability via GET
app.get('/smapi', (req, res) => {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="utf-8"?>
<definitions name="Sonos"
  xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="http://www.sonos.com/Services/1.1"
  targetNamespace="http://www.sonos.com/Services/1.1">
  <service name="SonosSvc">
    <port name="SonosSvcPort" binding="tns:SonosSvcBinding">
      <soap:address location="${req.protocol}://${req.get('host')}/smapi"/>
    </port>
  </service>
</definitions>`);
});

// Parse raw XML body for SOAP requests
app.post('/smapi', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const soapAction = req.headers['soapaction'] || req.headers['SOAPAction'] || '';
  console.log(`[server] SOAP request: ${soapAction}`);
  console.log(`[server] Request body: ${typeof req.body === 'string' ? req.body.substring(0, 500) : 'empty'}`);

  try {
    const xml = await dispatch(soapAction, req.body, req.get('host'));
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('[server] Error:', err);
    const { soapFault } = require('./xml');
    res.status(500).set('Content-Type', 'text/xml; charset=utf-8');
    res.send(soapFault('Server.ServiceError', err.message || 'Internal error'));
  }
});

// Strings table for Sonos service registration
app.get('/strings.xml', (req, res) => {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="utf-8" ?>
<stringtables>
  <stringtable xml:lang="en-US" section="AppLink">
    <string stringId="AppLinkMessage">Sign in to 24Six</string>
  </stringtable>
</stringtables>`);
});

// Presentation map for Sonos (browse menu structure)
app.get('/presentationmap.xml', (req, res) => {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="utf-8" ?>
<Presentation>
  <BrowseOptions>
    <Option>
      <id>root</id>
      <name>24Six</name>
    </Option>
  </BrowseOptions>
</Presentation>`);
});

// HLS manifest proxy — fetches Mux m3u8, rewrites relative URLs to absolute
app.get('/hls/:trackId/playlist.m3u8', async (req, res) => {
  const { trackId } = req.params;
  console.log(`[hls] Manifest request for track ${trackId}`);

  try {
    // Get fresh Mux HLS URL
    const muxUrl = await getStreamUrl(trackId);
    if (!muxUrl) {
      console.log(`[hls] No stream URL for track ${trackId}`);
      return res.status(502).send('No stream URL');
    }
    console.log(`[hls] Got Mux URL: ${muxUrl.substring(0, 100)}...`);

    // Fetch the m3u8 manifest from Mux
    const muxRes = await fetch(muxUrl);
    if (!muxRes.ok) {
      console.log(`[hls] Mux returned ${muxRes.status}`);
      return res.status(502).send('Failed to fetch manifest');
    }
    const manifest = await muxRes.text();

    console.log(`[hls] === RAW MANIFEST FROM MUX (${manifest.length} bytes) ===`);
    console.log(manifest);
    console.log(`[hls] === END RAW MANIFEST ===`);

    // Derive base URL for rewriting relative segment paths
    const baseUrl = muxUrl.substring(0, muxUrl.lastIndexOf('/') + 1);
    console.log(`[hls] Base URL for rewriting: ${baseUrl}`);

    // Rewrite relative URLs to absolute
    const rewritten = manifest.replace(/^(?!#)(\S+\.(?:m3u8|ts|m4s|mp4|aac)(\?[^\s]*)?)$/gm, (match) => {
      if (match.startsWith('http://') || match.startsWith('https://')) {
        return match; // already absolute
      }
      const abs = baseUrl + match;
      console.log(`[hls]   rewrite: ${match.substring(0, 80)} → ${abs.substring(0, 120)}`);
      return abs;
    });

    console.log(`[hls] === REWRITTEN MANIFEST (${rewritten.length} bytes) ===`);
    console.log(rewritten);
    console.log(`[hls] === END REWRITTEN MANIFEST ===`);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    console.error(`[hls] Error:`, err);
    res.status(500).send('Internal error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '24Six Sonos SMAPI Bridge' });
});

// Start server
async function start() {
  try {
    console.log('[server] Logging in to 24Six...');
    await login();
    console.log('[server] Login successful');
  } catch (err) {
    console.error('[server] Login failed:', err.message);
    console.log('[server] Starting anyway — will retry on first request');
  }

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] SMAPI endpoint: http://localhost:${PORT}/smapi`);
    console.log(`[server] Strings table: http://localhost:${PORT}/strings.xml`);
  });
}

start();
