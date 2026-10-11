// Relay integration: unit tests for relay.js plus end-to-end tests of the
// /api/relay/* proxy against a fake relay that follows the documented
// contract (rewrites every playlist URI back to itself WITH the secret,
// serves binary with Range support, 400/401/403/502 errors).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir: auth users for this file only.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-relay-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const relay = require('../src/relay');
const auth = require('../src/auth');
const { createServer } = require('../src/server');
const { getConfig, updateConfig } = require('../src/config');

const SECRET = 'Sup3r-S3cret+/=&x';
const KNOWN = 'https://cdn.example.com/live/master.m3u8?token=abc';
const EXCLUDED = 'https://pirate.example.com/live/index.m3u8';
const UNKNOWN = 'https://elsewhere.example.com/x.m3u8';
const SEGMENT = Buffer.alloc(1000, 7);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const BASIC = 'Basic ' + Buffer.from('relay-test-viewer:pw-123').toString('base64');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// --- fake relay ------------------------------------------------------------
function fakeRelay() {
  const app = express();
  const seen = [];
  app.use((req, res, next) => {
    seen.push(req.originalUrl);
    next();
  });
  app.get(['/', '/health'], (req, res) => res.json({ ok: true, ffmpeg: true, uptime: 5 }));
  const authed = (req, res, next) => (req.query.secret === SECRET ? next() : res.status(401).send(`bad secret ${req.query.secret}`));
  app.get('/stream', authed, (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).send('missing url');
    if (target.includes('upstream-down')) return res.status(502).send(`upstream ${target} unreachable`);
    if (target.includes('upstream-404')) return res.status(404).send(`upstream 404 for ${target}`);
    const back = (u) => `http://${req.headers.host}/stream?secret=${encodeURIComponent(SECRET)}&url=${encodeURIComponent(u)}`;
    if (target.endsWith('.m3u8') || target.includes('.m3u8?')) {
      const origin = new URL(target);
      const abs = (rel) => new URL(rel, origin).toString();
      return res.type('application/vnd.apple.mpegurl').send(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="${back(abs('subs/en.m3u8'))}"`,
          `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="${back(abs('iframes.m3u8'))}"`,
          `#EXT-X-KEY:METHOD=AES-128,URI="${back(abs('keys/k1.key'))}",IV=0x1`,
          `#EXT-X-MAP:URI="${back(abs('init.mp4'))}"`,
          '#EXTINF:6.0,',
          back(abs('seg1.ts')),
          '#EXTINF:6.0,',
          back(abs('seg2.ts')),
          '',
        ].join('\n')
      );
    }
    if (target.endsWith('.ts')) {
      const range = req.headers.range && /bytes=(\d+)-(\d+)/.exec(req.headers.range);
      res.set('Accept-Ranges', 'bytes');
      res.type('video/mp2t');
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])];
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${SEGMENT.length}`);
        return res.send(SEGMENT.subarray(start, end + 1));
      }
      return res.send(SEGMENT);
    }
    if (target.endsWith('.key')) return res.type('application/octet-stream').send(Buffer.alloc(16, 1));
    if (target.endsWith('.vtt')) return res.type('text/vtt').send('WEBVTT\n');
    if (target.endsWith('.mp4')) return res.type('video/mp4').send(Buffer.alloc(32, 2));
    return res.status(403).send('unsupported');
  });
  app.get('/thumb', authed, (req, res) => {
    if (!req.query.url) return res.status(400).send('missing url');
    if (req.query.url.includes('upstream-down')) return res.status(502).send('failed');
    res.type('image/jpeg').send(JPEG);
  });
  return { app, seen };
}

// --- app under test ---------------------------------------------------------
function appDeps(sources) {
  const state = { lastRows: [{ eventId: 'e1', channels: [{ name: 'Ch', sources }] }] };
  return {
    getState: () => state,
    runOnce: async () => {},
    rescheduleCron: () => {},
    runSourceCheck: async () => {},
    getSourceStatus: () => null,
    runTranslate: async () => {},
    getAllTranslations: () => ({}),
    setManualTranslation: () => {},
    getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {},
    runLiveTvFetch: async () => {},
    getAllYouTubeChannels: () => [],
    setChannelStatus: () => {},
    isRelayExcluded: (url) => url === EXCLUDED,
  };
}

async function setup(t, { secret = SECRET, relayUp = true } = {}) {
  const fake = fakeRelay();
  const relayServer = await listen(fake.app);
  const relayBase = `http://127.0.0.1:${relayServer.address().port}`;
  if (!relayUp) relayServer.close();

  const saved = { s: process.env.RELAY_SECRET, i: process.env.RELAY_INTERNAL_URL, u: process.env.RELAY_URL };
  process.env.RELAY_SECRET = secret;
  process.env.RELAY_INTERNAL_URL = relayBase;
  process.env.RELAY_URL = 'https://relay-public.example.com';
  await relay.relayHealth({ force: true }); // reset health cache for this case

  const sources = [KNOWN, EXCLUDED, 'https://cdn.example.com/upstream-down/a.m3u8', 'https://cdn.example.com/upstream-404/a.m3u8'];
  const appServer = await listen(createServer(appDeps(sources)));
  const base = `http://127.0.0.1:${appServer.address().port}`;

  const logs = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));

  t.after(() => {
    console.error = origError;
    console.log = origLog;
    appServer.close();
    if (relayUp) relayServer.close();
    for (const [k, v] of [['RELAY_SECRET', saved.s], ['RELAY_INTERNAL_URL', saved.i], ['RELAY_URL', saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const get = (p, headers = {}) => fetch(base + p, { headers: { Authorization: BASIC, ...headers } });
  return { base, get, logs, fake, relayBase };
}

const enc = encodeURIComponent;

test.before(() => {
  auth.upsert({ username: 'relay-test-admin', password: 'pw-admin', role: 'admin' });
  auth.upsert({ username: 'relay-test-viewer', password: 'pw-123', role: 'viewer' });
});

// --- unit -------------------------------------------------------------------
test('assertRelayConfig: fails fast without RELAY_SECRET', () => {
  const saved = process.env.RELAY_SECRET;
  delete process.env.RELAY_SECRET;
  try {
    assert.throws(() => relay.assertRelayConfig(), /RELAY_SECRET is not set/);
  } finally {
    if (saved !== undefined) process.env.RELAY_SECRET = saved;
  }
});

test('validateTarget: http(s) + allowed extension only, returned verbatim', () => {
  assert.equal(relay.validateTarget(KNOWN), KNOWN);
  for (const ext of relay.ALLOWED_EXTENSIONS) assert.ok(relay.validateTarget(`https://a.b/x${ext.toUpperCase()}`), ext);
  for (const bad of ['', 'nope', 'ftp://a.b/x.m3u8', 'file:///etc/x.m3u8', 'https://a.b/x.php', 'https://a.b/x.m3u8.exe', 'javascript:alert(1)//.m3u8']) {
    assert.equal(relay.validateTarget(bad), null, bad);
  }
});

test('redact: removes the secret by value, URL-encoded, and as a query param', () => {
  process.env.RELAY_SECRET = SECRET;
  const out = relay.redact(`x ${SECRET} y ${encodeURIComponent(SECRET)} http://h/stream?secret=zzz&url=1`);
  assert.ok(!out.includes(SECRET) && !out.includes(encodeURIComponent(SECRET)) && !/secret=zzz/.test(out), out);
});

test('signatures: verify only for the exact URL they were made for', () => {
  const sig = relay.sign(KNOWN);
  assert.ok(relay.verifySignature(KNOWN, sig));
  assert.ok(!relay.verifySignature(UNKNOWN, sig));
  assert.ok(!relay.verifySignature(KNOWN, undefined));
  assert.ok(!relay.verifySignature(KNOWN, sig.slice(1)));
});

// --- acceptance -------------------------------------------------------------
test('AC2: playlist is rewritten — every URI local, no secret, no relay host', async (t) => {
  const { get, relayBase } = await setup(t);
  const res = await get(`/api/relay/stream?url=${enc(KNOWN)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /mpegurl/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  const body = await res.text();

  assert.ok(!/secret/i.test(body), 'no "secret" anywhere');
  assert.ok(!body.includes(new URL(relayBase).host), 'no relay host');
  assert.ok(!body.includes('relay-public.example.com'), 'no public relay host');

  const uris = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) for (const m of line.matchAll(/URI="([^"]*)"/g)) uris.push(m[1]);
    else uris.push(line.trim());
  }
  assert.equal(uris.length, 6, 'subs, iframes, key, map, 2 segments');
  for (const u of uris) assert.ok(u.startsWith('/api/relay/stream?url='), u);
  const originals = uris.map((u) => new URL(u, 'http://x').searchParams.get('url'));
  assert.deepEqual(originals, [
    'https://cdn.example.com/live/subs/en.m3u8',
    'https://cdn.example.com/live/iframes.m3u8',
    'https://cdn.example.com/live/keys/k1.key',
    'https://cdn.example.com/live/init.mp4',
    'https://cdn.example.com/live/seg1.ts',
    'https://cdn.example.com/live/seg2.ts',
  ]);
});

test('AC3: segments, keys, subtitles, init through the rewritten links: 200/206, Range forwarded', async (t) => {
  const { get } = await setup(t);
  const playlist = await (await get(`/api/relay/stream?url=${enc(KNOWN)}`)).text();
  const local = (needle) => playlist.split(/["\n]/).find((s) => s.startsWith('/api/relay/stream') && s.includes(enc(needle)));

  const seg = await get(local('seg1.ts'));
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/mp2t');
  assert.equal(seg.headers.get('content-length'), String(SEGMENT.length));
  assert.deepEqual(Buffer.from(await seg.arrayBuffer()), SEGMENT);

  const ranged = await get(local('seg2.ts'), { Range: 'bytes=10-19' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${SEGMENT.length}`);
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);

  for (const n of ['keys/k1.key', 'init.mp4']) assert.equal((await get(local(n))).status, 200, n);
  const subs = await get(local('subs/en.m3u8'));
  assert.equal(subs.status, 200);
  assert.ok(!/secret/i.test(await subs.text()));
});

test('AC4: thumb returns the JPEG; bad url / relay failure give a placeholder', async (t) => {
  const { get } = await setup(t);
  const ok = await get(`/api/relay/thumb?url=${enc(KNOWN)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('cache-control'), /max-age=300/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), JPEG);

  for (const [p, code] of [
    [`/api/relay/thumb?url=${enc('not a url')}`, 400],
    [`/api/relay/thumb?url=${enc('https://cdn.example.com/upstream-down/a.m3u8')}`, 404],
  ]) {
    const r = await get(p);
    assert.equal(r.status, code, p);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  }
});

test('AC5: bad extension -> 400; unknown/excluded sources -> 403; upstream errors mapped', async (t) => {
  const { get } = await setup(t);
  assert.equal((await get(`/api/relay/stream?url=${enc('https://cdn.example.com/x.php')}`)).status, 400);
  assert.equal((await get('/api/relay/stream')).status, 400);
  assert.equal((await get(`/api/relay/stream?url=${enc(UNKNOWN)}`)).status, 403, 'not an open proxy');
  assert.equal((await get(`/api/relay/stream?url=${enc(EXCLUDED)}`)).status, 403, 'excluded source');
  assert.equal((await get(`/api/relay/stream?url=${enc(UNKNOWN)}&sig=forged`)).status, 403, 'forged signature');

  const down = await get(`/api/relay/stream?url=${enc('https://cdn.example.com/upstream-down/a.m3u8')}`);
  assert.equal(down.status, 502);
  assert.equal(await down.text(), 'Stream unavailable');
  const notFound = await get(`/api/relay/stream?url=${enc('https://cdn.example.com/upstream-404/a.m3u8')}`);
  assert.equal(notFound.status, 404);
  assert.equal(await notFound.text(), 'Stream unavailable', 'generic body, upstream body not echoed');
});

test('AC5: relay down -> 502 and /health reports it', async (t) => {
  const { get, base } = await setup(t, { relayUp: false });
  const r = await get(`/api/relay/stream?url=${enc(KNOWN)}`);
  assert.equal(r.status, 502);
  assert.equal(await r.text(), 'Stream unavailable');
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.relay, { enabled: true, ok: false, ffmpeg: null });
});

test('AC5: /health reports relay ok + ffmpeg, and nothing else about it', async (t) => {
  const { base } = await setup(t);
  const text = await (await fetch(`${base}/health`)).text();
  assert.deepEqual(JSON.parse(text).relay, { enabled: true, ok: true, ffmpeg: true });
  assert.ok(!/secret|127\.0\.0\.1|relay-public/i.test(text), text);
});

test('AC6: wrong RELAY_SECRET -> generic client error, secret absent from responses and logs', async (t) => {
  const WRONG = 'WrongSecret-123';
  const { get, logs } = await setup(t, { secret: WRONG });
  const r = await get(`/api/relay/stream?url=${enc(KNOWN)}`);
  const body = await r.text();
  assert.equal(r.status, 401);
  assert.equal(body, 'Stream unavailable');
  const thumb = await get(`/api/relay/thumb?url=${enc(KNOWN)}`);
  assert.match(thumb.headers.get('content-type'), /svg/);

  const everything = body + JSON.stringify([...r.headers]) + logs.join('\n');
  for (const s of [WRONG, SECRET, encodeURIComponent(SECRET)]) assert.ok(!everything.includes(s), `leaked ${s}`);
});

test('AC1: HTML pages carry no secret and no relay address', async (t) => {
  const { get, relayBase } = await setup(t);
  for (const p of ['/browse', `/player?url=${enc(KNOWN)}`]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    for (const needle of [SECRET, encodeURIComponent(SECRET), 'secret=', new URL(relayBase).host, 'relay-public.example.com']) {
      assert.ok(!html.includes(needle), `${p} contains ${needle}`);
    }
  }
  const browse = await (await get('/browse')).text();
  assert.ok(browse.includes(`/api/relay/thumb?url=${enc(KNOWN)}`), 'known source gets a relay preview');
  assert.ok(!browse.includes(`/api/relay/thumb?url=${enc(EXCLUDED)}`), 'excluded source gets none');
  assert.ok((await get(`/player?url=${enc(KNOWN)}`).then((r) => r.text())).includes(`/api/relay/stream?url=${enc(KNOWN)}`));
});

test('proxy routes require login', async (t) => {
  const { base } = await setup(t);
  for (const p of [`/api/relay/stream?url=${enc(KNOWN)}`, `/api/relay/thumb?url=${enc(KNOWN)}`, `/player?url=${enc(KNOWN)}`]) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
});

// --- admin on/off switch ------------------------------------------------------
const ADMIN = 'Basic ' + Buffer.from('relay-test-admin:pw-admin').toString('base64');
const postToggle = (base, enabled, authz = ADMIN) =>
  fetch(`${base}/settings/relay`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: authz, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `enabled=${enabled}`,
  });

test('toggle: relay is on by default', () => {
  assert.equal(getConfig().relayEnabled, true);
});

test('toggle: turning off disables proxy, previews and health check; turning on restores them', async (t) => {
  const { base, get, fake } = await setup(t);
  t.after(() => updateConfig({ relayEnabled: true }));

  const off = await postToggle(base, 'false');
  assert.equal(off.status, 302);
  assert.equal(off.headers.get('location'), '/settings?relay=off');
  assert.equal(getConfig().relayEnabled, false);

  const before = fake.seen.length;
  const stream = await get(`/api/relay/stream?url=${enc(KNOWN)}`);
  assert.equal(stream.status, 503);
  assert.equal(await stream.text(), 'Relay is turned off');
  const thumb = await get(`/api/relay/thumb?url=${enc(KNOWN)}`);
  assert.equal(thumb.status, 503);
  assert.match(thumb.headers.get('content-type'), /svg/);
  assert.equal((await get(`/player?url=${enc(KNOWN)}`)).status, 404);
  assert.ok(!(await (await get('/browse')).text()).includes('/api/relay/'), 'no previews while off');
  assert.deepEqual((await (await fetch(`${base}/health`)).json()).relay, { enabled: false });
  assert.equal(fake.seen.length, before, 'relay never contacted while off');

  const settings = await (await fetch(`${base}/settings`, { headers: { Authorization: ADMIN } })).text();
  assert.match(settings, /Turn relay on/);

  const on = await postToggle(base, 'true');
  assert.equal(on.headers.get('location'), '/settings?relay=on');
  assert.equal((await get(`/api/relay/stream?url=${enc(KNOWN)}`)).status, 200);
});

test('toggle: refuses to turn on without relay variables (so the next boot cannot fail)', async (t) => {
  const { base } = await setup(t);
  t.after(() => updateConfig({ relayEnabled: true }));
  await postToggle(base, 'false');
  delete process.env.RELAY_SECRET;
  const r = await postToggle(base, 'true');
  assert.equal(r.headers.get('location'), '/settings?relay=missing');
  assert.equal(getConfig().relayEnabled, false);
});

test('toggle: admin only', async (t) => {
  const { base } = await setup(t);
  assert.equal((await postToggle(base, 'false', BASIC)).status, 401, 'viewer cannot toggle');
  assert.equal(getConfig().relayEnabled, true);
});
