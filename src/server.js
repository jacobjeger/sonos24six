require('dotenv').config();

const express = require('express');
const { login } = require('./auth');
const { dispatch } = require('./soap');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse raw XML body for SOAP requests
app.post('/smapi', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const soapAction = req.headers['soapaction'] || req.headers['SOAPAction'] || '';
  console.log(`[server] SOAP request: ${soapAction}`);

  try {
    const xml = await dispatch(soapAction, req.body);
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

// Health check
app.get('/', (req, res) => {
  res.send('24Six Sonos SMAPI Bridge is running');
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
