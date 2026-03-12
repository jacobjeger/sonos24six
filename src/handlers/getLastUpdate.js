const { simpleResponse } = require('../xml');

// Use startup timestamp so each deploy gets a fresh catalog version
const CATALOG_VERSION = String(Math.floor(Date.now() / 1000));

async function getLastUpdate() {
  return simpleResponse('getLastUpdate',
    `      <getLastUpdateResult>
        <catalog>${CATALOG_VERSION}</catalog>
        <favorites>${CATALOG_VERSION}</favorites>
        <pollInterval>60</pollInterval>
      </getLastUpdateResult>`);
}

module.exports = getLastUpdate;
