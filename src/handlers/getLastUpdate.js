const { simpleResponse } = require('../xml');

// Use a stable catalog version — changing this on every deploy causes Sonos to
// invalidate ALL caches (browse, search categories, etc.), which breaks search
// until Sonos re-discovers capabilities. Since we proxy 24Six's catalog and
// don't have our own versioned catalog, use a fixed version string.
// Only bump this manually when the browse hierarchy structure changes.
const CATALOG_VERSION = '1';
// Favorites can change when users modify playlists/likes on 24Six
const FAVORITES_VERSION = String(Math.floor(Date.now() / 86400000)); // daily

async function getLastUpdate() {
  return simpleResponse('getLastUpdate',
    `      <getLastUpdateResult>
        <catalog>${CATALOG_VERSION}</catalog>
        <favorites>${FAVORITES_VERSION}</favorites>
        <pollInterval>300</pollInterval>
      </getLastUpdateResult>`);
}

module.exports = getLastUpdate;
