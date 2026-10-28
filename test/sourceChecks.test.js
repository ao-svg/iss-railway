const test = require('node:test');
const assert = require('node:assert/strict');
// checkAll persists its cache — keep it out of the repo's own data/.
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sourcechecks-test-'));
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

test('looksLikeBinaryMedia: real MPEG-TS mislabeled text/plain still counts as media', () => {
  const bytes = Buffer.from([0x47, 0x40, 0x11, 0x1d, ...Array(184).fill(0)]);
  assert.equal(looksLikeBinaryMedia(bytes, 'text/plain'), true);
  assert.equal(looksLikeBinaryMedia(Buffer.from('404 not found'), 'text/plain'), false);
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

const PLAYABLE = { status: 'stream', isManifest: true, working: true, cors: true };

test('rankFor: working requires both a real still AND a real gif, not just a still', () => {
  assert.equal(rankFor(PLAYABLE, { ok: true, gifOk: true }), 'working');
  assert.equal(rankFor(PLAYABLE, { ok: true, gifOk: false }), 'medium'); // still only -> not enough
  assert.equal(rankFor(PLAYABLE, { ok: false }), 'medium');
});

test('rankFor: a capture alone is not working — the check must back it up', () => {
  assert.equal(rankFor(null, { ok: true, gifOk: true }), 'unverified');
});

test('rankFor: a good capture of a stream with no CORS on some hop is medium at best', () => {
  const nocors = { status: 'nocors', isManifest: true, working: true, cors: false };
  assert.equal(rankFor(nocors, { ok: true, gifOk: true }), 'medium');
});

test('rankFor: a good capture whose segment is unverified (working null) is medium, not working', () => {
  const unverified = { status: 'stream', isManifest: true, working: null, cors: true };
  assert.equal(rankFor(unverified, { ok: true, gifOk: true }), 'medium');
});

test('rankFor: an old good capture never keeps a source working once the check says dead or 403', () => {
  const shot = { ok: true, gifOk: true };
  assert.equal(rankFor({ status: 'dead', isManifest: true, working: false, cors: null, consecutiveFailures: 1 }, shot), 'unverified');
  assert.equal(rankFor({ status: 'dead', isManifest: true, working: false, consecutiveFailures: FLAG_AFTER_FAILURES }, shot), 'low');
  assert.equal(rankFor({ status: 'dead', working: false, httpStatus: 403 }, shot), 'unauthorized');
});

test('rankFor: an HTML page needs status ok, not CORS (iframes do not need it)', () => {
  const shot = { ok: true, gifOk: true };
  assert.equal(rankFor({ status: 'ok', isManifest: false, working: true, cors: null }, shot), 'working');
  assert.equal(rankFor({ status: 'blocked', isManifest: false, working: true, cors: null }, shot), 'unverified');
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
  assert.equal(rankFor({ ...PLAYABLE, status: 'dangerous' }, { ok: true, gifOk: true }), 'dangerous');
});

// checkUrl/resolveNow's own dangerous-file handling is a one-line call into
// looksLikeDangerousFile (tested exhaustively above) — not re-tested here
// over a real socket. This machine's local security software blocks Node
// from connecting to its own http.createServer() (EACCES on loopback,
// confirmed independent of this test runner's sandboxing), which made that
// kind of test permanently red here regardless of correctness — see
// nextConsecutiveFailures above for the same reasoning applied to checkAll.

test('geoHintFor: known geo-fenced CDN hosts and their subdomains are us-only, others null', () => {
  const { geoHintFor } = require('../src/sourceChecks');
  assert.equal(geoHintFor('https://turnerlive.warnermediacdn.com/hls/live/2023172/tbseast/x.m3u8'), 'us-only');
  assert.equal(geoHintFor('https://amg19223-amg19223c4-amgplt0351.playout.now3.amagi.tv/playlist/p.m3u8'), 'us-only');
  assert.equal(geoHintFor('https://fastly.live.brightcove.com/x/chunklist.m3u8'), null);
  assert.equal(geoHintFor('https://evilplayout.now3.amagi.tv.example.com/p.m3u8'), null, 'suffix must be a whole domain label');
  assert.equal(geoHintFor('not a url'), null);
  assert.equal(geoHintFor('https://a.example/x', { 'eu-only': ['example'] }), 'eu-only');
});

test('enrichRowsWithSourceStatus: sourceGeo uses the resolved host when the check has one', () => {
  const rows = [{ channels: [{ name: 'x', sources: ['https://redirector.example/tbs.m3u8', 'https://plain.example/a.m3u8', 'https://turnerlive.warnermediacdn.com/t.m3u8'] }] }];
  const checks = {
    'https://redirector.example/tbs.m3u8': { status: 'stream', resolvedUrl: 'https://turnerlive.warnermediacdn.com/hls/x.m3u8' },
  };
  const out = enrichRowsWithSourceStatus(rows, (u) => checks[u] || null);
  assert.deepEqual(out[0].channels[0].sourceGeo, ['us-only', null, 'us-only']);
});

// Local origin servers for checkUrl's request behaviour (loopback works in
// this environment again — relay.test.js relies on it too).
async function withServer(handler, fn) {
  const http = require('node:http');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('checkUrl: a 403 to the ranged request is retried once without Range before calling it unauthorized', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  const seen = [];
  await withServer(
    (req, res) => {
      seen.push(req.headers.range || null);
      if (req.headers.range) return res.writeHead(403).end();
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>page</html>');
    },
    async (base) => {
      const r = await checkUrl(`${base}/page`);
      assert.equal(r.status, 'ok');
      assert.equal(r.httpStatus, 200);
    }
  );
  assert.deepEqual(seen, ['bytes=0-16383', null]);
});

test('checkUrl: a 403 that persists without Range stays unauthorized, after exactly one retry', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  let hits = 0;
  await withServer(
    (req, res) => {
      hits++;
      res.writeHead(403).end();
    },
    async (base) => {
      const r = await checkUrl(`${base}/live.m3u8`);
      assert.equal(r.status, 'dead');
      assert.equal(r.httpStatus, 403);
      assert.equal(rankFor({ ...r, consecutiveFailures: 1 }, null), 'unauthorized');
    }
  );
  assert.equal(hits, 2);
});

test('checkUrl: the no-Range retry reads only the first 16KB of an endless body', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  let streamClosed = false;
  await withServer(
    (req, res) => {
      if (req.headers.range) return res.writeHead(403).end();
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const chunk = Buffer.alloc(4096, 0x47);
      const iv = setInterval(() => res.write(chunk), 5);
      res.on('close', () => {
        streamClosed = true;
        clearInterval(iv);
      });
    },
    async (base) => {
      const r = await checkUrl(`${base}/endless`);
      assert.equal(r.httpStatus, 200);
      assert.notEqual(r.status, 'dead');
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(streamClosed, 'the endless response was cut off, not drained');
});

test('checkUrl: probes send an Origin header, so CDNs that only answer CORS to one count as cors', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  await withServer(
    (req, res) => {
      const acao = req.headers.origin ? { 'Access-Control-Allow-Origin': '*' } : {};
      if (req.url === '/master.m3u8') return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', ...acao }).end('#EXTM3U\n#EXTINF:6,\nseg.ts\n');
      res.writeHead(200, { 'Content-Type': 'video/mp2t', ...acao }).end(Buffer.alloc(376, 0x47));
    },
    async (base) => {
      const r = await checkUrl(`${base}/master.m3u8`);
      assert.equal(r.cors, true);
      assert.equal(r.working, true);
      assert.equal(r.status, 'stream');
    }
  );
});

test('checkUrl: a redirected master resolves its relative variant against the host it was served from', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  await withServer(
    (req, res) => {
      if (req.url === '/short.m3u8') return res.writeHead(302, { Location: '/stitch/master.m3u8' }).end();
      if (req.url === '/stitch/master.m3u8') return res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' }).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1042180/playlist.m3u8\n');
      if (req.url === '/stitch/1042180/playlist.m3u8') return res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' }).end('#EXTM3U\n#EXTINF:6,\nseg.ts\n');
      if (req.url === '/stitch/1042180/seg.ts') return res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(Buffer.alloc(376, 0x47));
      res.writeHead(404).end();
    },
    async (base) => {
      const r = await checkUrl(`${base}/short.m3u8`);
      assert.equal(r.working, true);
      assert.equal(r.nestedUrl, `${base}/stitch/1042180/playlist.m3u8`);
      assert.equal(r.segmentUrl, `${base}/stitch/1042180/seg.ts`);
    }
  );
});

test('checkUrl: a segment that answers 503 once is retried, like a player would, before the stream counts as dead', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  const hits = {};
  await withServer(
    (req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      if (req.url === '/live.m3u8') return res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' }).end('#EXTM3U\n#EXTINF:10,\n/seg/1\n#EXTINF:10,\n/seg/2\n');
      if (req.url === '/seg/2' && hits[req.url] === 1) return res.writeHead(503, { 'Content-Type': 'text/html' }).end('<html>503</html>');
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(Buffer.alloc(376, 0x47));
    },
    async (base) => {
      const r = await checkUrl(`${base}/live.m3u8`);
      assert.equal(r.working, true);
      assert.equal(r.status, 'nocors');
      assert.equal(r.segmentUrl, `${base}/seg/2`, 'the newest segment is tried first');
    }
  );
  assert.equal(hits['/seg/2'], 2);
  assert.equal(hits['/seg/1'], undefined);
});

test('checkUrl: segments that keep failing still make the stream dead', async () => {
  const { checkUrl } = require('../src/sourceChecks');
  const hits = {};
  await withServer(
    (req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      if (req.url === '/live.m3u8') return res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' }).end('#EXTM3U\n#EXTINF:10,\n/seg/1\n#EXTINF:10,\n/seg/2\n');
      if (req.url === '/seg/1') return res.writeHead(404).end();
      res.writeHead(503).end();
    },
    async (base) => {
      const r = await checkUrl(`${base}/live.m3u8`);
      assert.equal(r.working, false);
      assert.equal(r.status, 'dead');
    }
  );
  assert.equal(hits['/seg/2'], 2, 'a 5xx is retried once');
  assert.equal(hits['/seg/1'], 1, 'a 404 is not');
});

test('carryOver: a swapped-in URL starts from the old result, minus the old token facts, never overwriting its own', async () => {
  const sc = require('../src/sourceChecks');
  const from = 'https://carry.example/live.m3u8?token=old';
  const to = 'https://carry.example/live.m3u8?token=new';
  await withServer(
    (req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>'),
    async (base) => {
      // seed `from` with a real cache entry via checkAll against a local page
      await sc.checkAll([`${base}/a`], { force: true });
      const seeded = sc.getStatus(`${base}/a`);
      sc.carryOver(`${base}/a`, to);
      assert.equal(sc.getStatus(to).status, seeded.status);
      assert.equal(sc.getStatus(to).resolvedUrl, to, 'never the old (expired) resolved URL');
      assert.equal(sc.getStatus(to).carriedFrom, `${base}/a`);
      sc.carryOver(from, to); // `from` unknown -> no-op
      assert.equal(sc.getStatus(to).carriedFrom, `${base}/a`);
    }
  );
});
