const { simpleResponse } = require('../xml');

async function getLastUpdate() {
  console.log(`[getLastUpdate] Returning static catalog version`);
  return simpleResponse('getLastUpdate',
    `      <getLastUpdateResult>
        <catalog>1</catalog>
        <favorites>1</favorites>
        <pollInterval>60</pollInterval>
      </getLastUpdateResult>`);
}

module.exports = getLastUpdate;
