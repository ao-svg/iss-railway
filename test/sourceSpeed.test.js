const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
// checkAll/caches persist to the data dir — keep them out of the repo's data/.
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'source-speed-test-'));
const { segmentDurationFor, speedVerdict, carrySpeedForward, speedTestDue, rankFor, checkUrl } = require('../src/sourceChecks');
const { categorize } = require('../src/sourceReport');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('segmentDurationFor: the EXTINF before the segment, else TARGETDURATION', () => {
  const pl = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.005,\nseg1.ts\n#EXTINF:6.006,\nseg2.ts\n';
  assert.equal(segmentDurationFor(pl, 'https://h/live/index.m3u8', 'https://h/live/seg2.ts'), 6.006);
  assert.equal(segmentDurationFor(pl, 'https://h/live/index.m3u8', 'https://h/live/seg1.ts'), 5.005);
  assert.equal(segmentDurationFor(pl, 'https://h/live/index.m3u8', 'https://h/live/missing.ts'), 6);
  assert.equal(segmentDurationFor('#EXTM3U\nseg.ts\n', 'https://h/i.m3u8', 'https://h/other.ts'), null);
});

test('speedVerdict: slower than 0.8x real time is too slow; an incomplete fast download proves nothing', () => {
  assert.equal(speedVerdict({ seconds: 18.7, bytes: 2.6e6, complete: true }, 6).tooSlow, true);
  assert.equal(speedVerdict({ seconds: 18.7, bytes: 2.6e6, complete: true }, 6).ratio, 3.12);
  assert.equal(speedVerdict({ seconds: 2, bytes: 1e6, complete: true }, 6).tooSlow, false);
  assert.equal(speedVerdict({ seconds: 20, bytes: 1e5, complete: false }, 6).tooSlow, true, 'cut at the time cap');
  assert.equal(speedVerdict({ seconds: 1, bytes: 8e6, complete: false }, 6).tooSlow, null, 'byte cap hit fast');
  assert.equal(speedVerdict({ seconds: 3, bytes: 1, complete: true }, null).tooSlow, null);
});

test('carrySpeedForward: between tests a too-slow verdict sticks; a fast one keeps working', () => {
  const slowPrev = { speed: { ratio: 3, tooSlow: true, duration: 6, seconds: 18, complete: true }, speedCheckedAt: '2026-11-03T10:00:00Z' };
  const r = carrySpeedForward({ isManifest: true, working: true, cors: true, status: 'stream' }, slowPrev);
  assert.equal(r.working, false);
  assert.equal(r.status, 'dead');
  assert.equal(r.tooSlow, true);
  assert.match(r.error, /too slow/);
  const fastPrev = { speed: { ratio: 0.3, tooSlow: false, duration: 6, seconds: 2, complete: true }, speedCheckedAt: '2026-11-03T10:00:00Z' };
  const f = carrySpeedForward({ isManifest: true, working: true, cors: true, status: 'stream' }, fastPrev);
  assert.equal(f.working, true);
  assert.equal(f.speed.ratio, 0.3);
});

test('speedTestDue: never tested or tested over 30 min ago', () => {
  const now = Date.parse('2026-11-03T10:31:00Z');
  assert.equal(speedTestDue(null, now), true);
  assert.equal(speedTestDue({ speedCheckedAt: '2026-11-03T10:00:00Z' }, now), true);
  assert.equal(speedTestDue({ speedCheckedAt: '2026-11-03T10:20:00Z' }, now), false);
});

test('rankFor / report: a too-slow source ranks low straight away and has its own report category', () => {
  const slow = { status: 'dead', working: false, httpStatus: 200, tooSlow: true, consecutiveFailures: 1 };
  assert.equal(rankFor(slow, { ok: true, gifOk: true }), 'low');
  assert.equal(categorize(slow), 'tooSlow');
});

test('checkUrl with a speed test: a segment that downloads slower than it plays is too slow, a fast one works', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/slow.m3u8')) return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nslow.ts\n');
      if (req.url.startsWith('/fast.m3u8')) return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nfast.ts\n');
      if (req.url === '/fast.ts') return res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(Buffer.alloc(188 * 1000, 0x47));
      // slow.ts: first bytes at once (the 16 KB probe passes), the rest over ~1.5 s for a 1 s segment
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(Buffer.alloc(20000, 0x47));
      let n = 0;
      const iv = setInterval(() => {
        if (++n > 15) {
          clearInterval(iv);
          return res.end();
        }
        res.write(Buffer.alloc(1000, 0x47));
      }, 100);
      res.on('close', () => clearInterval(iv));
    },
    async (base) => {
      const slow = await checkUrl(`${base}/slow.m3u8`, { measureSpeed: true });
      assert.equal(slow.working, false);
      assert.equal(slow.tooSlow, true);
      assert.ok(slow.speed.ratio > 0.8, `ratio ${slow.speed.ratio}`);
      assert.match(slow.error, /too slow/);
      const fast = await checkUrl(`${base}/fast.m3u8`, { measureSpeed: true });
      assert.equal(fast.working, true);
      assert.equal(fast.tooSlow, false);
      assert.equal(fast.speed.complete, true);
      const noTest = await checkUrl(`${base}/slow.m3u8`);
      assert.equal(noTest.working, true, 'without measureSpeed only the first bytes are judged');
      assert.equal(noTest.speed, undefined);
    }
  );
});
