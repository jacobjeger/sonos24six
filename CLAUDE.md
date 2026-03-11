# Autonomous Operation Rules

## Project Overview
Sonos SMAPI bridge for 24Six music streaming. Node.js/Express server deployed on Railway.
Every push to main triggers a Railway redeploy.

## Autonomous Fix Rules

### ALWAYS do autonomously:
- Fix code-level bugs (syntax errors, runtime exceptions, logic errors)
- Fix HTTP response format issues (XML, SOAP, content types)
- Fix authentication/session handling issues
- Fix stream proxy issues (HLS parsing, audio extraction, content serving)
- Update error handling and logging
- Run existing tests before pushing

### NEVER do without asking:
- Modify database migrations
- Change environment variables (TWENTYFOUR_EMAIL, TWENTYFOUR_PASSWORD, TWENTYFOUR_PROFILE_ID, etc.)
- Push to main if tests fail
- Delete or rename existing API endpoints
- Change the Railway deployment configuration
- Modify package.json dependencies without clear justification

### Logging
- Log every autonomous action to `auto-fix.log` in the project root
- Include timestamp, error detected, fix applied, and outcome
- Format: `[ISO_TIMESTAMP] ACTION: description | FILES: file1.js, file2.js | RESULT: success/failure`

## Architecture

```
src/
├── server.js           # Express entry point, /smapi, /stream/:trackId, /strings.xml
├── soap.js             # SOAP envelope parser, method dispatcher
├── xml.js              # SMAPI XML response builders (mediaCollection, mediaMetadata, etc.)
├── auth.js             # 24Six 4-step login flow, cookie/XSRF management
├── client.js           # 24Six API client with auto-relogin, caching, device_id capture
├── proxy.js            # HLS→AAC stream proxy (MPEG-TS demux, ADTS extraction)
└── handlers/
    ├── getMetadata.js       # Browse hierarchy (root → library → playlists/albums/artists)
    ├── getMediaMetadata.js  # Track metadata lookup
    ├── getMediaURI.js       # Stream URL resolution (returns proxy URL)
    ├── getLastUpdate.js     # Catalog version polling
    ├── getExtendedMetadata.js # Extended metadata for favorites
    └── search.js            # In-memory library search
```

## Key Technical Details
- 24Six uses Inertia.js; API responses come as JSON or HTML with data-page attribute
- Streaming uses Mux CDN HLS (.m3u8 → .ts segments with AAC audio)
- Proxy extracts AAC ADTS frames from MPEG-TS and serves as audio/aac
- Authentication requires cookie jar + XSRF token + Inertia version header
- device_id is captured from API response props and required for /begin streaming endpoint
- Railway auto-sets RAILWAY_PUBLIC_DOMAIN env var for proxy URL construction

## Common Error Patterns
- `401/403` → Session expired, auto-relogin triggered in client.js
- `409` → Inertia version mismatch, falls back to full HTML page fetch
- `422` → Missing required field (e.g., device_id for streaming)
- `302 to /login` → Not authenticated, need fresh login
- Sonos "not encoded correctly" → Audio format/content-type issue in proxy
