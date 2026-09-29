const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bodyLooksLikeManifest,
  looksLikeBinaryMedia,
  looksLikeDangerousFile,
  isManifestUrl,
  isBlockedByHeaders,
  hasCorsHeader,
  extractFirstReference,
  enrichRowsWithSourceStatus,
  manifestStatus,
  rankFor,
  FLAG_AFTER_FAILURES,
  nextConsecutiveFailures,
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
  const fakeStatus = (url) =>
    url === 'http://a.m3u8'
      ? { status: 'nocors', working: true, cors: false, resolvedUrl: 'http://cdn.example/a.m3u8?token=abc' }
      : null;
  const out = enrichRowsWithSourceStatus(rows, fakeStatus);

  assert.deepEqual(out[0].channels[0].sourceStatuses, ['nocors', null]);
  assert.deepEqual(out[0].channels[0].sourceWorking, [true, null]);
  assert.deepEqual(out[0].channels[0].sourceCors, [false, null]);
  assert.deepEqual(out[0].channels[0].sourceResolved, ['http://cdn.example/a.m3u8?token=abc', null]);
  // Exports (CSV/JSON) get this app's own /go redirect, not a raw CDN URL —
  // it re-resolves live at click time, so a token that rotates between the
  // last periodic check and whenever someone actually opens the link still
  // works, instead of exporting a snapshot that's already stale by then.
  assert.deepEqual(out[0].channels[0].sources, [
    '/go?u=' + encodeURIComponent('http://a.m3u8'),
    '/go?u=' + encodeURIComponent('http://b.m3u8'),
  ]);
});

test('enrichRowsWithSourceStatus: sources always become /go links regardless of check status', () => {
  const rows = [{ eventId: 'e1', channels: [{ name: 'Sky', sources: ['http://a.m3u8'] }] }];
  const out = enrichRowsWithSourceStatus(rows, () => ({ status: 'stream', resolvedUrl: 'http://a.m3u8' }), {
    publicBaseUrl: 'https://app.example',
  });
  assert.deepEqual(out[0].channels[0].sourceResolved, [null]); // resolvedUrl matches original -> null, still an audit fact
  assert.equal(out[0].channels[0].sources[0], 'https://app.example/go?u=' + encodeURIComponent('http://a.m3u8'));
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

test('rankFor: working requires both a real still AND a real gif, not just a still', () => {
  assert.equal(rankFor(null, { ok: true, gifOk: true }), 'working');
  assert.equal(rankFor(null, { ok: true, gifOk: false }), 'unverified'); // still only -> not enough
  assert.equal(rankFor(null, { ok: false }), 'unverified');
});

test('rankFor: a 401/403 is unauthorized, never low, regardless of consecutiveFailures', () => {
  assert.equal(rankFor({ status: 'dead', httpStatus: 401, consecutiveFailures: 10 }, null), 'unauthorized');
  assert.equal(rankFor({ status: 'dead', httpStatus: 403, consecutiveFailures: 1 }, null), 'unauthorized');
});

test('rankFor: reachable-but-uncaptured is medium', () => {
  assert.equal(rankFor({ status: 'ok' }, null), 'medium');
  assert.equal(rankFor({ status: 'stream' }, null), 'medium');
  assert.equal(rankFor({ status: 'nocors' }, null), 'medium');
});

test('rankFor: dead only counts as low after FLAG_AFTER_FAILURES in a row, not on the first miss', () => {
  assert.equal(rankFor({ status: 'dead', consecutiveFailures: FLAG_AFTER_FAILURES - 1 }, null), 'unverified');
  assert.equal(rankFor({ status: 'dead', consecutiveFailures: FLAG_AFTER_FAILURES }, null), 'low');
  assert.equal(rankFor({ status: 'dead', consecutiveFailures: FLAG_AFTER_FAILURES + 5 }, null), 'low');
});

test('rankFor: never checked at all is unverified', () => {
  assert.equal(rankFor(null, null), 'unverified');
});

test('nextConsecutiveFailures: increments on repeated dead results, resets the instant it recovers', () => {
  assert.equal(nextConsecutiveFailures('dead', null), 1);
  assert.equal(nextConsecutiveFailures('dead', { consecutiveFailures: 1 }), 2);
  assert.equal(nextConsecutiveFailures('dead', { consecutiveFailures: 2 }), 3);
  assert.equal(nextConsecutiveFailures('ok', { consecutiveFailures: 5 }), 0);
  assert.equal(nextConsecutiveFailures('stream', { consecutiveFailures: 5 }), 0);
});

test('looksLikeDangerousFile: Windows PE (MZ) magic bytes are flagged', () => {
  const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  assert.equal(looksLikeDangerousFile(buf, 'application/octet-stream', null, 'http://x.example/thing'), true);
});

test('looksLikeDangerousFile: ELF magic bytes are flagged', () => {
  const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
  assert.equal(looksLikeDangerousFile(buf, 'application/octet-stream', null, 'http://x.example/thing'), true);
});

test('looksLikeDangerousFile: Content-Disposition: attachment is flagged regardless of body', () => {
  assert.equal(looksLikeDangerousFile(Buffer.from('#EXTM3U\n'), 'text/plain', 'attachment; filename="thing.m3u8"', 'http://x.example/thing.m3u8'), true);
});

test('looksLikeDangerousFile: a known-dangerous extension in the URL is flagged even with an innocuous body', () => {
  assert.equal(looksLikeDangerousFile(Buffer.from('hello'), 'text/plain', null, 'http://x.example/setup.exe'), true);
});

test('looksLikeDangerousFile: a known-dangerous content-type is flagged', () => {
  assert.equal(looksLikeDangerousFile(Buffer.from('MZ'), 'application/x-msdownload', null, 'http://x.example/x'), true);
});

test('looksLikeDangerousFile: a real HLS manifest is never flagged', () => {
  assert.equal(looksLikeDangerousFile(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'), 'application/vnd.apple.mpegurl', null, 'http://x.example/live.m3u8'), false);
});

test('looksLikeDangerousFile: an empty/missing body with a normal URL is never flagged', () => {
  assert.equal(looksLikeDangerousFile(null, null, null, 'http://x.example/live.m3u8'), false);
});

test('rankFor: dangerous overrides every other signal, even a proven working capture', () => {
  assert.equal(rankFor({ status: 'dangerous' }, { ok: true, gifOk: true }), 'dangerous');
});

// checkUrl/resolveNow's own dangerous-file handling is a one-line call into
// looksLikeDangerousFile (tested exhaustively above) — not re-tested here
// over a real socket. This machine's local security software blocks Node
// from connecting to its own http.createServer() (EACCES on loopback,
// confirmed independent of this test runner's sandboxing), which made that
// kind of test permanently red here regardless of correctness — see
// nextConsecutiveFailures above for the same reasoning applied to checkAll.
