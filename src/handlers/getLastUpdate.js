const { simpleResponse } = require('../xml');

async function getLastUpdate() {
  return simpleResponse('getLastUpdate',
    `      <getLastUpdateResult>
        <catalog>1</catalog>
        <favorites>1</favorites>
        <pollInterval>60</pollInterval>
      </getLastUpdateResult>`);
}

module.exports = getLastUpdate;
