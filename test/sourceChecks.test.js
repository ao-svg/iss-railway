const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bodyLooksLikeManifest,
  looksLikeBinaryMedia,
  isManifestUrl,
  isBlockedByHeaders,
  hasCorsHeader,
  extractFirstReference,
  enrichRowsWithSourceStatus,
  manifestStatus,
} = require('../src/sourceChecks');

test('manifestStatus: confirmed-broken content is dead regardless of CORS', () => {
  assert.equal(manifestStatus(false, true), 'dead');
  assert.equal(manifestStatus(false, false), 'dead');
});

test('manifestStatus: working or unverified + CORS is stream', () => {
  assert.equal(manifestStatus(true, true), 'stream');
  assert.equal(manifestStatus(null, true), 'stream');
});

test('manifestStatus: working or unverified without CORS is nocors, not blocked', () => {
  assert.equal(manifestStatus(true, false), 'nocors');
  assert.equal(manifestStatus(null, false), 'nocors');
});

test('bodyLooksLikeManifest: detects HLS by #EXTM3U prefix', () => {
  assert.equal(bodyLooksLikeManifest(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')), true);
});

test('bodyLooksLikeManifest: detects DASH by <MPD tag', () => {
  assert.equal(bodyLooksLikeManifest(Buffer.from('<?xml version="1.0"?><MPD xmlns="x">')), true);
});

test('bodyLooksLikeManifest: plain HTML is not a manifest', () => {
  assert.equal(bodyLooksLikeManifest(Buffer.from('<!doctype html><html></html>')), false);
});

test('bodyLooksLikeManifest: empty/missing buffer is inconclusive (null)', () => {
  assert.equal(bodyLooksLikeManifest(null), null);
  assert.equal(bodyLooksLikeManifest(Buffer.alloc(0)), null);
});

test('looksLikeBinaryMedia: MPEG-TS sync byte 0x47 is recognized', () => {
  const bytes = Buffer.from([0x47, 0x40, 0x11, 0x10, ...Array(184).fill(0)]);
  assert.equal(looksLikeBinaryMedia(bytes, null), true);
});

test('looksLikeBinaryMedia: fMP4 ftyp box signature is recognized', () => {
  const bytes = Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom', 'latin1');
  assert.equal(looksLikeBinaryMedia(bytes, null), true);
});

test('looksLikeBinaryMedia: declared text/html content-type is rejected', () => {
  const bytes = Buffer.from('<html><body>error</body></html>');
  assert.equal(looksLikeBinaryMedia(bytes, 'text/html; charset=utf-8'), false);
});

test('looksLikeBinaryMedia: mostly-printable text with no media signature reads as false', () => {
  const bytes = Buffer.from('this is just a plain text error message from the server');
  assert.equal(looksLikeBinaryMedia(bytes, null), false);
});

test('looksLikeBinaryMedia: empty buffer is inconclusive (null), never penalized', () => {
  assert.equal(looksLikeBinaryMedia(null, null), null);
  assert.equal(looksLikeBinaryMedia(Buffer.alloc(0), null), null);
});

test('isManifestUrl: body sniff wins over content-type and extension', () => {
  assert.equal(isManifestUrl('https://x.com/video.bin', 'text/plain', Buffer.from('#EXTM3U\n')), true);
});

test('isManifestUrl: falls back to content-type when body is inconclusive', () => {
  assert.equal(isManifestUrl('https://x.com/stream', 'application/vnd.apple.mpegurl', Buffer.alloc(0)), true);
});

test('isManifestUrl: falls back to URL extension when body and content-type are both inconclusive', () => {
  assert.equal(isManifestUrl('https://x.com/playlist.m3u8', null, Buffer.alloc(0)), true);
  assert.equal(isManifestUrl('https://x.com/page.html', null, Buffer.alloc(0)), false);
});

test('isBlockedByHeaders: X-Frame-Options DENY/SAMEORIGIN blocks framing', () => {
  assert.equal(isBlockedByHeaders({ 'x-frame-options': 'DENY' }), true);
  assert.equal(isBlockedByHeaders({ 'x-frame-options': 'SAMEORIGIN' }), true);
  assert.equal(isBlockedByHeaders({}), false);
});

test('isBlockedByHeaders: CSP frame-ancestors none/self blocks framing', () => {
  assert.equal(isBlockedByHeaders({ 'content-security-policy': "frame-ancestors 'none'" }), true);
  assert.equal(isBlockedByHeaders({ 'content-security-policy': "frame-ancestors 'self'" }), true);
  assert.equal(isBlockedByHeaders({ 'content-security-policy': "frame-ancestors *" }), false);
});

test('hasCorsHeader: any non-empty Access-Control-Allow-Origin counts', () => {
  assert.equal(hasCorsHeader({ 'access-control-allow-origin': '*' }), true);
  assert.equal(hasCorsHeader({}), false);
  assert.equal(hasCorsHeader({ 'access-control-allow-origin': '' }), false);
});

test('extractFirstReference: returns the first non-comment line resolved against the base URL', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n';
  assert.equal(extractFirstReference(text, 'https://cdn.example.com/master.m3u8'), 'https://cdn.example.com/variant.m3u8');
});

test('extractFirstReference: returns null when nothing but comments', () => {
  assert.equal(extractFirstReference('#EXTM3U\n#EXT-X-VERSION:3\n', 'https://x.com/m.m3u8'), null);
});

test('enrichRowsWithSourceStatus: adds a parallel sourceStatuses array, never mutates input', () => {
  const rows = [
    {
      eventId: 'e1',
      channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8'] }],
    },
  ];
  const fakeStatus = (url) => (url === 'http://a.m3u8' ? { status: 'nocors', working: true, cors: false } : null);
  const out = enrichRowsWithSourceStatus(rows, fakeStatus);

  assert.deepEqual(out[0].channels[0].sourceStatuses, ['nocors', null]);
  assert.deepEqual(out[0].channels[0].sourceWorking, [true, null]);
  assert.deepEqual(out[0].channels[0].sourceCors, [false, null]);
  assert.equal(out[0].channels[0].sources[0], 'http://a.m3u8'); // sources unchanged
  assert.ok(!('sourceStatuses' in rows[0].channels[0])); // original row never mutated
});

test('enrichRowsWithSourceStatus: a cache entry from before working/cors existed maps to null, not false', () => {
  const rows = [{ eventId: 'e1', channels: [{ name: 'Sky', sources: ['http://old.m3u8'] }] }];
  const out = enrichRowsWithSourceStatus(rows, () => ({ status: 'stream' }));
  assert.deepEqual(out[0].channels[0].sourceWorking, [null]);
  assert.deepEqual(out[0].channels[0].sourceCors, [null]);
});

test('enrichRowsWithSourceStatus: row with no channels stays empty, no crash', () => {
  const out = enrichRowsWithSourceStatus([{ eventId: 'e1' }], () => null);
  assert.deepEqual(out[0].channels, []);
});
