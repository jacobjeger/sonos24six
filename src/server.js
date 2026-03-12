require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const { login } = require('./auth');
const { dispatch } = require('./soap');
const { getStreamUrl, prewarmCache } = require('./client');
const { handleStreamProxy } = require('./proxy');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// In-memory request log (last 200 entries) — accessible via /logs
const requestLog = [];
let smapiRequestCount = 0;
function addLog(entry) {
  requestLog.push({ ts: new Date().toISOString(), ...entry });
  if (requestLog.length > 200) requestLog.shift();
}

// Normalize double slashes and log every request
app.use((req, res, next) => {
  if (req.path !== req.path.replace(/\/+/g, '/')) {
    return res.redirect(req.path.replace(/\/+/g, '/'));
  }
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

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
  smapiRequestCount++;
  const reqNum = smapiRequestCount;
  const soapAction = req.headers['soapaction'] || req.headers['SOAPAction'] || '';
  const method = (soapAction.match(/#(\w+)/) || [])[1] || 'unknown';
  // Extract id from SOAP body for logging
  const idMatch = (req.body || '').match(/<(?:[\w]+:)?id[^>]*>([^<]*)<\/(?:[\w]+:)?id>/);
  const id = idMatch ? idMatch[1].trim() : null;

  // Log search term for debugging
  if (method === 'search') {
    const termMatch = (req.body || '').match(/<(?:[\w]+:)?term[^>]*>([^<]*)<\/(?:[\w]+:)?term>/);
    const term = termMatch ? termMatch[1].trim() : '(none)';
    console.log(`[smapi] #${reqNum} SEARCH request: term="${term}" id=${id}`);
  }

  try {
    const start = Date.now();
    const xml = await dispatch(soapAction, req.body, req.get('host'));
    const elapsed = Date.now() - start;
    addLog({ method, id, responseLength: xml ? xml.length : 0, elapsed });
    if (method === 'search') {
      console.log(`[smapi] #${reqNum} SEARCH response: ${xml ? xml.length : 0} bytes in ${elapsed}ms`);
    }
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error(`[soap] error:`, err.message);
    addLog({ method, id, error: err.message });
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
  <stringtable xml:lang="en-US" section="Search">
    <string stringId="search_all">All</string>
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
      <id>my-library</id>
      <name>My Library</name>
    </Option>
    <Option>
      <id>browse</id>
      <name>Browse</name>
    </Option>
  </BrowseOptions>
  <SearchCategories>
    <CustomCategory mappedId="search:all" stringId="search_all"/>
  </SearchCategories>
</Presentation>`);
});

// AAC stream proxy — downloads HLS, extracts AAC, serves with Range support for Sonos
app.get('/stream/:trackId', handleStreamProxy);
app.head('/stream/:trackId', handleStreamProxy);

// HLS manifest proxy — resolves master→media playlist so Sonos gets segment list
app.get('/hls/:trackId/playlist.m3u8', async (req, res) => {
  const { trackId } = req.params;
  console.log(`[hls] Manifest request for track ${trackId}`);

  try {
    // Step 1: Get fresh Mux HLS URL (master playlist)
    const muxUrl = await getStreamUrl(trackId);
    if (!muxUrl) {
      console.log(`[hls] No stream URL for track ${trackId}`);
      return res.status(502).send('No stream URL');
    }
    console.log(`[hls] Got Mux master URL: ${muxUrl.substring(0, 120)}...`);

    // Step 2: Fetch the master playlist
    const masterRes = await fetch(muxUrl);
    if (!masterRes.ok) {
      console.log(`[hls] Mux master returned ${masterRes.status}`);
      return res.status(502).send('Failed to fetch master playlist');
    }
    const masterManifest = await masterRes.text();
    console.log(`[hls] === MASTER PLAYLIST ===`);
    console.log(masterManifest);
    console.log(`[hls] === END MASTER PLAYLIST ===`);

    // Step 3: Parse out the rendition URL (line after #EXT-X-STREAM-INF)
    const lines = masterManifest.split('\n');
    let renditionUrl = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        // Next non-empty line is the rendition URL
        for (let j = i + 1; j < lines.length; j++) {
          const candidate = lines[j].trim();
          if (candidate && !candidate.startsWith('#')) {
            renditionUrl = candidate;
            break;
          }
        }
        break;
      }
    }

    if (!renditionUrl) {
      // Maybe it's already a media playlist (has #EXTINF)
      if (masterManifest.includes('#EXTINF')) {
        console.log(`[hls] Already a media playlist, serving directly`);
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        return res.send(masterManifest);
      }
      console.log(`[hls] No rendition URL found in master playlist`);
      return res.status(502).send('No rendition URL in master playlist');
    }

    // Make rendition URL absolute if relative
    if (!renditionUrl.startsWith('http')) {
      const baseUrl = muxUrl.substring(0, muxUrl.lastIndexOf('/') + 1);
      renditionUrl = baseUrl + renditionUrl;
    }
    console.log(`[hls] Rendition URL: ${renditionUrl.substring(0, 120)}...`);

    // Step 4: Fetch the media playlist (actual segments)
    const mediaRes = await fetch(renditionUrl);
    if (!mediaRes.ok) {
      console.log(`[hls] Rendition fetch returned ${mediaRes.status}`);
      return res.status(502).send('Failed to fetch media playlist');
    }
    const mediaManifest = await mediaRes.text();
    console.log(`[hls] === MEDIA PLAYLIST (${mediaManifest.length} bytes) ===`);
    console.log(mediaManifest);
    console.log(`[hls] === END MEDIA PLAYLIST ===`);

    // Step 5: Serve the media playlist as-is (segment URLs are already absolute)
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(mediaManifest);
  } catch (err) {
    console.error(`[hls] Error:`, err);
    res.status(500).send('Internal error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '24Six Sonos SMAPI Bridge' });
});

// Diagnostic endpoint — test SMAPI handlers directly
app.get('/test/:method/:id?', async (req, res) => {
  const { method, id } = req.params;
  const validMethods = ['getMetadata', 'getExtendedMetadata', 'getMediaMetadata'];
  if (!validMethods.includes(method)) {
    return res.json({ error: `Unknown method. Use: ${validMethods.join(', ')}` });
  }
  try {
    const handler = require(`./handlers/${method}`);
    const xml = await handler({ id: id || 'root', index: 0, count: 100 });
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug search — inspect the exact SOAP XML that Sonos receives
app.get('/debug/search', async (req, res) => {
  const term = req.query.q || 'test';
  try {
    const searchHandler = require('./handlers/search');
    const xml = await searchHandler({ id: 'search:all', term, index: 0, count: 100 });
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View all SOAP requests received since startup
app.get('/logs', (req, res) => {
  res.json({
    total: requestLog.length,
    totalSmapi: smapiRequestCount,
    uptime: `${Math.floor(process.uptime())}s`,
    requests: requestLog,
  });
});

// Debug: dump featured homepage data structure
app.get('/debug/featured', async (req, res) => {
  try {
    const client = require('./client');
    const featured = await client.getFeatured();
    const summary = {};
    for (const key of Object.keys(featured)) {
      const val = featured[key];
      if (val == null) { summary[key] = null; continue; }
      if (Array.isArray(val)) {
        summary[key] = { type: 'array', length: val.length, first: val[0] ? { keys: Object.keys(val[0]), id: val[0].id, title: val[0].title, name: val[0].name, headline: val[0].headline } : null };
      } else if (typeof val === 'object') {
        summary[key] = { type: 'object', keys: Object.keys(val), headline: val.headline, title: val.title, tilesCount: Array.isArray(val.tiles) ? val.tiles.length : undefined, dataCount: Array.isArray(val.data) ? val.data.length : undefined };
      } else {
        summary[key] = { type: typeof val, value: String(val).substring(0, 100) };
      }
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-test — simulate a SOAP getMetadata(root) call through the full pipeline
app.get('/selftest', async (req, res) => {
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <getMetadata xmlns="http://www.sonos.com/Services/1.1">
      <id>root</id>
      <index>0</index>
      <count>100</count>
    </getMetadata>
  </s:Body>
</s:Envelope>`;
  try {
    const xml = await dispatch('"http://www.sonos.com/Services/1.1#getMetadata"', soapBody, req.get('host'));
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Start server
async function start() {
  try {
    console.log('[server] Logging in to 24Six...');
    await login();
    console.log('[server] Login successful');
    // Pre-warm track cache in the background (don't block startup)
    prewarmCache().catch(err => console.error('[server] Prewarm failed:', err.message));
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
