const NS = 'http://www.sonos.com/Services/1.1';

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
${body}
  </soap:Body>
</soap:Envelope>`;
}

function mediaCollection({ id, itemType, title, albumArtURI, canPlay = false, canEnumerate = true }) {
  return `        <mediaCollection>
          <id>${escapeXml(id)}</id>
          <itemType>${escapeXml(itemType)}</itemType>
          <title>${escapeXml(title)}</title>
          <albumArtURI>${escapeXml(albumArtURI || '')}</albumArtURI>
          <canPlay>${canPlay}</canPlay>
          <canEnumerate>${canEnumerate}</canEnumerate>
        </mediaCollection>`;
}

function mediaMetadata({ id, title, mimeType = 'audio/aac', artist = '', album = '', albumArtURI = '', duration = 0 }) {
  return `        <mediaMetadata>
          <id>${escapeXml(id)}</id>
          <itemType>track</itemType>
          <title>${escapeXml(title)}</title>
          <mimeType>${escapeXml(mimeType)}</mimeType>
          <trackMetadata>
            <artist>${escapeXml(artist)}</artist>
            <album>${escapeXml(album)}</album>
            <albumArtURI>${escapeXml(albumArtURI)}</albumArtURI>
            <duration>${duration}</duration>
          </trackMetadata>
        </mediaMetadata>`;
}

function resultResponse(methodName, items, index, total) {
  const count = items.length;
  return soapEnvelope(`    <${methodName}Response xmlns="${NS}">
      <${methodName}Result>
        <index>${index}</index>
        <count>${count}</count>
        <total>${total}</total>
${items.join('\n')}
      </${methodName}Result>
    </${methodName}Response>`);
}

function simpleResponse(methodName, innerXml) {
  return soapEnvelope(`    <${methodName}Response xmlns="${NS}">
${innerXml}
    </${methodName}Response>`);
}

function soapFault(code, message) {
  return soapEnvelope(`    <soap:Fault>
      <faultcode>${escapeXml(code)}</faultcode>
      <faultstring>${escapeXml(message)}</faultstring>
    </soap:Fault>`);
}

module.exports = {
  escapeXml,
  soapEnvelope,
  mediaCollection,
  mediaMetadata,
  resultResponse,
  simpleResponse,
  soapFault,
};
