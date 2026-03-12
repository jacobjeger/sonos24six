const { simpleResponse } = require('../xml');

// Bump this version whenever browse structure changes to invalidate Sonos cache
const CATALOG_VERSION = '2';

async function getLastUpdate() {
  return simpleResponse('getLastUpdate',
    `      <getLastUpdateResult>
        <catalog>${CATALOG_VERSION}</catalog>
        <favorites>${CATALOG_VERSION}</favorites>
        <pollInterval>60</pollInterval>
      </getLastUpdateResult>`);
}

module.exports = getLastUpdate;
