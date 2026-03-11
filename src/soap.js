const { soapFault } = require('./xml');
const getMetadata = require('./handlers/getMetadata');
const getMediaMetadata = require('./handlers/getMediaMetadata');
const getMediaURI = require('./handlers/getMediaURI');
const getLastUpdate = require('./handlers/getLastUpdate');
const search = require('./handlers/search');

const handlers = {
  getMetadata,
  getMediaMetadata,
  getMediaURI,
  getLastUpdate,
  search,
};

function extractTag(xml, tag) {
  const regex = new RegExp(`<(?:[\\w]+:)?${tag}[^>]*>([^<]*)</(?:[\\w]+:)?${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

async function dispatch(soapAction, body) {
  // Extract method name from SOAPAction header
  // e.g. "http://www.sonos.com/Services/1.1#getMetadata"
  const methodMatch = soapAction && soapAction.match(/#(\w+)/);
  const method = methodMatch ? methodMatch[1] : null;

  console.log(`[soap] Method: ${method}`);

  // Handle getSessionId inline
  if (method === 'getSessionId') {
    const { simpleResponse } = require('./xml');
    return simpleResponse('getSessionId',
      '      <getSessionIdResult>sonos-session-1</getSessionIdResult>');
  }

  const handler = handlers[method];
  if (!handler) {
    console.log(`[soap] Unknown method: ${method}`);
    return soapFault('Client.UnsupportedMethod', `Method ${method} not supported`);
  }

  // Extract common parameters from SOAP body
  const params = {
    id: extractTag(body, 'id'),
    index: parseInt(extractTag(body, 'index') || '0', 10),
    count: parseInt(extractTag(body, 'count') || '100', 10),
    term: extractTag(body, 'term'),
  };

  console.log(`[soap] Params:`, JSON.stringify(params));

  try {
    return await handler(params);
  } catch (err) {
    console.error(`[soap] Handler error for ${method}:`, err);
    return soapFault('Server.ServiceError', err.message || 'Internal error');
  }
}

module.exports = { dispatch };
