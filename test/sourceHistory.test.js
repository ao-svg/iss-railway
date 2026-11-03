const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
// History persists to the data dir — keep it out of the repo's data/.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'source-history-test-'));
const sh = require('../src/sourceHistory');

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-03T10:00:00Z');

test('resolveKnown: current URL plays itself; never-known URL is refused', () => {
  const h = { known: {}, swaps: {} };
  assert.equal(sh.resolveKnown(h, 'https://a/x.m3u8', new Set(['https://a/x.m3u8']), { now: T0 }), 'https://a/x.m3u8');
  assert.equal(sh.resolveKnown(h, 'https://evil.example/', new Set(['https://a/x.m3u8']), { now: T0 }), null);
  assert.equal(sh.resolveKnown(h, undefined, new Set(), { now: T0 }), null);
});

test('resolveKnown: a swapped-out URL follows the chain to the current replacement', () => {
  let h = { known: {}, swaps: {} };
  h = sh.noteSwap(h, 'https://k/fox?token=1', 'https://k/fox?token=2', { now: T0 });
  h = sh.noteSwap(h, 'https://k/fox?token=2', 'https://k/fox?token=3', { now: T0 + 20 * 60 * 1000 });
  const current = new Set(['https://k/fox?token=3']);
  assert.equal(sh.resolveKnown(h, 'https://k/fox?token=1', current, { now: T0 + H }), 'https://k/fox?token=3');
  assert.equal(sh.resolveKnown(h, 'https://k/fox?token=2', current, { now: T0 + H }), 'https://k/fox?token=3');
});

test('resolveKnown: recently known, no replacement -> itself; after the TTL -> refused', () => {
  const { history } = sh.noteUrls({ known: {}, swaps: {} }, ['https://gone/x.m3u8'], { now: T0 });
  assert.equal(sh.resolveKnown(history, 'https://gone/x.m3u8', new Set(), { now: T0 + 5 * H }), 'https://gone/x.m3u8');
  assert.equal(sh.resolveKnown(history, 'https://gone/x.m3u8', new Set(), { now: T0 + sh.KNOWN_TTL_MS + H }), null);
});

test('resolveKnown: a swap cycle cannot loop forever', () => {
  let h = { known: {}, swaps: {} };
  h = sh.noteSwap(h, 'https://a/1', 'https://a/2', { now: T0 });
  h = sh.noteSwap(h, 'https://a/2', 'https://a/1', { now: T0 });
  assert.equal(sh.resolveKnown(h, 'https://a/1', new Set(), { now: T0 }), 'https://a/2');
});

test('noteUrls: remembers doms9 (relay-excluded) URLs, and only rewrites a stale timestamp', () => {
  const r1 = sh.noteUrls({ known: {}, swaps: {} }, ['https://d9/a', 'https://other/b'], { now: T0, isExcluded: (u) => u.includes('d9') });
  assert.equal(r1.changed, true);
  assert.equal(sh.wasExcluded(r1.history, 'https://d9/a'), true);
  assert.equal(sh.wasExcluded(r1.history, 'https://other/b'), false);
  const r2 = sh.noteUrls(r1.history, ['https://d9/a'], { now: T0 + 60 * 1000, isExcluded: () => false });
  assert.equal(r2.changed, false, 'seen a minute ago: no write');
  assert.equal(sh.wasExcluded(r2.history, 'https://d9/a'), true, 'still excluded once it leaves the doms9 list');
  const swapped = sh.noteSwap(r1.history, 'https://d9/a', 'https://d9/a2', { now: T0 });
  assert.equal(sh.wasExcluded(swapped, 'https://d9/a2'), true, 'a replacement inherits the exclusion');
});

test('prune: drops entries older than the TTL', () => {
  const h = { known: { old: { seen: T0 }, fresh: { seen: T0 + 47 * H } }, swaps: { old: { to: 'fresh', at: T0 } } };
  const p = sh.prune(h, T0 + 49 * H);
  assert.deepEqual(Object.keys(p.known), ['fresh']);
  assert.deepEqual(p.swaps, {});
});

test('/go: an old swapped URL redirects to its replacement; a never-known one is still 404', async (t) => {
  const origin = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n'));
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => origin.close());
  const src = `http://127.0.0.1:${origin.address().port}`;
  const oldUrl = `${src}/fox/index.m3u8?token=expired`;
  const newUrl = `${src}/fox/index.m3u8?token=fresh`;
  const gone = `${src}/ended/index.m3u8?token=x`;
  sh.rememberCurrent([oldUrl, gone]);
  sh.rememberSwaps([[oldUrl, newUrl]]);

  const { createServer } = require('../src/server');
  const state = { lastRows: [{ channels: [{ name: 'FOX', sources: [newUrl] }] }] };
  const app = createServer({ getState: () => state });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const go = (u) => fetch(`${base}/go?u=${encodeURIComponent(u)}`, { redirect: 'manual' });

  const swappedRes = await go(oldUrl);
  assert.equal(swappedRes.status, 302);
  assert.equal(swappedRes.headers.get('location'), newUrl);
  const goneRes = await go(gone);
  assert.equal(goneRes.status, 302, 'known within the window, no replacement: plays itself');
  assert.equal(goneRes.headers.get('location'), gone);
  assert.equal((await go('https://evil.example/x.m3u8')).status, 404);

  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'source-history.json'), 'utf8'));
  assert.equal(onDisk.swaps[oldUrl].to, newUrl, 'persisted, so a redeploy keeps it');
});
