# 24Six Sonos Bridge

A Sonos SMAPI bridge that lets you stream [24Six](https://www.24six.com) music on any Sonos speaker. Runs as a Node.js/Express server that translates between the Sonos SMAPI protocol and the 24Six web API.

## Features

- Browse your 24Six library (playlists, albums, artists, liked songs)
- Browse featured/curated content from the 24Six homepage
- Search across tracks, albums, and artists
- Stream audio via HLS-to-AAC proxy (extracts AAC from MPEG-TS segments)
- Auto-relogin on session expiry

## Requirements

- Node.js 20+
- A [24Six](https://www.24six.com) account
- A Sonos speaker on your network

## Setup

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/jacobjeger/sonos24six.git
   cd sonos24six
   npm install
   ```

2. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Fill in your 24Six credentials:
   ```
   TWENTYFOUR_EMAIL=your@email.com
   TWENTYFOUR_PASSWORD=your-password
   TWENTYFOUR_PROFILE_ID=46901
   PORT=3000
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Register the service on Sonos using one of the methods below.

### Option A: Sonos Developer Portal (Recommended)

This is the recommended approach — it registers the service globally for your Sonos household and persists across reboots.

1. Create a free account at [developer.sonos.com](https://developer.sonos.com)

2. Go to **My Integrations** and create a new SMAPI integration

3. Configure the **Endpoints** tab:
   - **Secure SMAPI Endpoint**: `https://your-bridge.up.railway.app/smapi` (your deployed bridge URL with `/smapi`)
   - **Authentication**: Select **Anonymous**
   - **Presentation Map URI**: `https://your-bridge.up.railway.app/presentationmap.xml`
   - **Strings Table URI**: `https://your-bridge.up.railway.app/strings.xml`

4. Configure the **Search Capabilities** tab:
   - **SMAPI Search**: Enabled
   - **Catalog Type**: GLOBAL
   - Add a search category:
     - **Category ID**: `All`
     - **Category Mapped ID**: `search:all`

5. Under **Distribution**, keep it set to **Development** (this is fine for personal use)

6. Click **Test** or go to your Sonos app → **Settings > Services & Voice > Add a Service** and select your service name

### Option B: Local Registration Script

For quick local testing without a developer account:

   ```bash
   node register.js <sonos-ip> <bridge-url>

   # Local network example:
   node register.js 10.0.0.48 http://10.0.0.10:3000

   # Public URL example (Railway, Cloudflare Tunnel, etc.):
   node register.js 10.0.0.48 https://your-bridge.up.railway.app
   ```

   Then open the Sonos app, go to **Settings > Services & Voice > Add a Service**, and select **24Six**.

   > **Note:** Local registration may not persist across Sonos reboots. The Developer Portal method is more reliable.

## Deploy to Railway

The project includes a `railway.json` for one-click deployment:

1. Push to GitHub
2. Connect the repo in [Railway](https://railway.app)
3. Set the environment variables (`TWENTYFOUR_EMAIL`, `TWENTYFOUR_PASSWORD`, `TWENTYFOUR_PROFILE_ID`)
4. Railway auto-deploys on every push to `main`

Railway sets `RAILWAY_PUBLIC_DOMAIN` automatically, which the bridge uses to construct stream proxy URLs.

## Architecture

```
src/
├── server.js              # Express entry point, endpoints
├── soap.js                # SOAP envelope parser, method dispatcher
├── xml.js                 # SMAPI XML response builders
├── auth.js                # 24Six login flow (cookie jar + XSRF)
├── client.js              # 24Six API client with caching and auto-relogin
├── proxy.js               # HLS → AAC stream proxy
└── handlers/
    ├── getMetadata.js         # Browse hierarchy
    ├── getMediaMetadata.js    # Track metadata lookup
    ├── getMediaURI.js         # Stream URL resolution
    ├── getLastUpdate.js       # Catalog version polling
    ├── getExtendedMetadata.js # Extended metadata for favorites
    └── search.js              # Search across library
```

### Endpoints

| Endpoint | Description |
|---|---|
| `POST /smapi` | Sonos SMAPI SOAP endpoint |
| `GET /smapi` | WSDL for Sonos service verification |
| `GET /stream/:trackId` | AAC stream proxy |
| `GET /strings.xml` | Sonos string table |
| `GET /presentationmap.xml` | Sonos presentation map |
| `GET /` | Health check |
| `GET /logs` | Recent SOAP request log |
| `GET /debug/search?q=term` | Test search responses |
| `GET /debug/featured` | Inspect featured data |
| `GET /selftest` | Simulate a SOAP getMetadata call |

### How streaming works

1. Sonos calls `getMediaURI` for a track
2. The bridge resolves the 24Six streaming URL (Mux CDN HLS)
3. Returns a proxy URL (`/stream/:trackId`) pointing back to the bridge
4. When Sonos hits the proxy, it downloads the HLS segments, demuxes MPEG-TS, and extracts raw AAC/ADTS frames
5. Serves the audio as `audio/aac` with Range request support

## Troubleshooting

- **"Not encoded correctly" on Sonos** — usually an audio format or content-type issue in the stream proxy
- **No search results** — check `/logs` to see if Sonos is sending search requests; try removing and re-adding the service in the Sonos app
- **401/403 errors in logs** — session expired, the client auto-relogins but check your credentials in `.env`
- **Blank artist names** — verify the 24Six API is returning artist data; check `/debug/search?q=artist-name`

## License

MIT
