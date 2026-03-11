#!/usr/bin/env node
/**
 * Register the 24Six SMAPI bridge as a custom music service on Sonos.
 *
 * Usage:
 *   node register.js <sonos-ip> <bridge-url>
 *
 * Examples:
 *   node register.js 10.0.0.48 http://10.0.0.10:3000
 *   node register.js 10.0.0.48 https://24six.yourdomain.com
 *
 * The bridge-url must be reachable by the Sonos speaker.
 * On firmware 86+, Sonos requires HTTPS URLs accessible from the internet.
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const SID = 254;          // Custom service ID (must be unique, 200-299 range)
const SERVICE_NAME = '24Six';
const POLL_INTERVAL = 1200;

async function register(sonosIp, bridgeUrl) {
  const deviceUrl = `http://${sonosIp}:1400`;

  // Method 1: Try customsd POST (works on older firmware)
  console.log(`\n=== Method 1: customsd POST to ${deviceUrl}/customsd ===`);
  try {
    // First try to GET the customsd page for CSRF token
    const page = await fetch(`${deviceUrl}/customsd`, { timeout: 5000 });
    if (page.status === 403) {
      console.log('  customsd page returned 403 (blocked on this firmware)');
    } else {
      const html = await page.text();
      const $ = cheerio.load(html);
      const csrfToken = $('input[name="csrfToken"]').val() || '';

      const formData = new URLSearchParams({
        sid: String(SID),
        name: SERVICE_NAME,
        uri: `${bridgeUrl}/smapi`,
        secureUri: `${bridgeUrl}/smapi`,
        pollInterval: String(POLL_INTERVAL),
        authType: 'Anonymous',
        stringsVersion: '1',
        stringsUri: `${bridgeUrl}/strings.xml`,
        presentationMapVersion: '1',
        presentationMapUri: '',
        containerType: 'MService',
        caps: 'search',
        ...(csrfToken ? { csrfToken } : {}),
      });

      const res = await fetch(`${deviceUrl}/customsd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      });
      console.log(`  POST /customsd → ${res.status} ${res.statusText}`);
      const body = await res.text();
      if (body) console.log(`  Response: ${body.substring(0, 500)}`);
      if (res.ok) {
        console.log('\n✓ Service registered successfully via customsd!');
        console.log('  Open the Sonos app → Settings → Services & Voice → Add a Service');
        console.log(`  You should see "${SERVICE_NAME}" in the list.`);
        return;
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // Method 2: Try UPnP MusicServices SOAP call
  console.log(`\n=== Method 2: UPnP MusicServices SOAP ===`);
  try {
    // First, list available services to verify connectivity
    const listBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:ListAvailableServices xmlns:u="urn:schemas-upnp-org:service:MusicServices:1">
    </u:ListAvailableServices>
  </s:Body>
</s:Envelope>`;

    const listRes = await fetch(`${deviceUrl}/MusicServices/Control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"urn:schemas-upnp-org:service:MusicServices:1#ListAvailableServices"',
      },
      body: listBody,
    });
    console.log(`  ListAvailableServices → ${listRes.status}`);

    if (listRes.ok) {
      const xml = await listRes.text();
      // Check if our service is already registered
      if (xml.includes(`Name="${SERVICE_NAME}"`)) {
        console.log(`  "${SERVICE_NAME}" is already in the services list!`);
      } else {
        console.log(`  "${SERVICE_NAME}" not found in services list.`);
      }
    }

    // Try UpdateAvailableServices
    const updateBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:UpdateAvailableServices xmlns:u="urn:schemas-upnp-org:service:MusicServices:1">
    </u:UpdateAvailableServices>
  </s:Body>
</s:Envelope>`;

    const updateRes = await fetch(`${deviceUrl}/MusicServices/Control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"urn:schemas-upnp-org:service:MusicServices:1#UpdateAvailableServices"',
      },
      body: updateBody,
    });
    console.log(`  UpdateAvailableServices → ${updateRes.status}`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // Method 3: Try SystemProperties approach
  console.log(`\n=== Method 3: SystemProperties SOAP ===`);
  try {
    // Try setting a custom service via SystemProperties
    const spBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddURIToQueue xmlns:u="urn:schemas-upnp-org:service:SystemProperties:1">
      <VariableName>R_SvcCustomDescriptor</VariableName>
      <StringValue>${SID},${SERVICE_NAME},${bridgeUrl}/smapi,${bridgeUrl}/smapi,${POLL_INTERVAL},Anonymous,${bridgeUrl}/strings.xml</StringValue>
    </u:AddURIToQueue>
  </s:Body>
</s:Envelope>`;

    const spRes = await fetch(`${deviceUrl}/SystemProperties/Control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"urn:schemas-upnp-org:service:SystemProperties:1#SetString"',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetString xmlns:u="urn:schemas-upnp-org:service:SystemProperties:1">
      <VariableName>R_SvcCustomDescriptor_${SID}</VariableName>
      <StringValue>${JSON.stringify({
        sid: SID,
        name: SERVICE_NAME,
        uri: `${bridgeUrl}/smapi`,
        secureUri: `${bridgeUrl}/smapi`,
        pollInterval: POLL_INTERVAL,
        authType: 'Anonymous',
        stringsVersion: '1',
        stringsUri: `${bridgeUrl}/strings.xml`,
        containerType: 'MService',
        caps: ['search'],
      })}</StringValue>
    </u:SetString>
  </s:Body>
</s:Envelope>`,
    });
    console.log(`  SystemProperties SetString → ${spRes.status}`);
    if (spRes.ok) {
      const body = await spRes.text();
      console.log(`  Response: ${body.substring(0, 300)}`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`If all methods returned 403 or failed, your firmware has blocked custom service registration.`);
  console.log(`\nAlternative approaches:`);
  console.log(`  1. Use Cloudflare Tunnel to expose your bridge with HTTPS:`);
  console.log(`     brew install cloudflared`);
  console.log(`     cloudflared tunnel --url http://localhost:3000`);
  console.log(`     Then use the generated HTTPS URL as your bridge URL.`);
  console.log(`\n  2. Try the Sonos Desktop Controller app (Mac) — it may still support customsd`);
  console.log(`\n  3. Use a third-party Sonos app: SonoPhone, SonoPad, or Phonos Universal`);
  console.log(`\n  4. Deploy to Railway (or similar) for a public HTTPS URL:`);
  console.log(`     railway up`);
  console.log(`     Then register with the Railway URL.`);
}

// Parse args
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node register.js <sonos-ip> <bridge-url>');
  console.log('');
  console.log('Examples:');
  console.log('  node register.js 10.0.0.48 http://10.0.0.10:3000');
  console.log('  node register.js 10.0.0.48 https://24six.yourdomain.com');
  process.exit(1);
}

register(args[0], args[1].replace(/\/$/, '')).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
