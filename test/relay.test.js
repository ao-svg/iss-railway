const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const relay = require('../src/relay');

const SECRET = 's3cr3t&x=1';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

// Minimal stand-in for the Relay service, per its documented contract.
function startFakeRelay() {
  const app = express();
  app.get(['/', '/health'], (req, res) => res.json({ ok: true, ffmpeg: true, uptime: 42 }));
  const auth = (req, res, next) => (req.query.secret === SECRET ? next() : res.status(401).send('bad secret'));
  app.get('/stream', auth, (req, res) => {
    if (!req.query.url) return res.status(400).send('missing url');
    res.type('application/vnd.apple.mpegurl').send('#EXTM3U\n');
  });
  app.get('/thumb', auth, (req, res) => {
    if (!req.query.url) return res.status(400).send('missing url');
    res.type('image/jpeg').send(JPEG);
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function withRelayEnv(env, t) {
  const keys = ['RELAY_URL', 'RELAY_SECRET', 'RELAY_INTERNAL_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('relayStreamUrl/relayThumbUrl: build public URLs with encoded secret and target', (t) => {
  withRelayEnv({ RELAY_URL: 'https://relay.example.com/', RELAY_SECRET: SECRET, RELAY_INTERNAL_URL: 'http://relay.railway.internal:8080' }, t);
  const target = 'https://cdn.example.com/live/index.m3u8?token=a&b=c';
  assert.equal(
    relay.relayStreamUrl(target),
    `https://relay.example.com/stream?secret=${encodeURIComponent(SECRET)}&url=${encodeURIComponent(target)}`
  );
  // Browser-facing URLs always use the public base, never the internal one.
  assert.ok(relay.relayThumbUrl(target).startsWith('https://relay.example.com/thumb?secret='));
});

test('relay helpers return null when not configured', (t) => {
  withRelayEnv({ RELAY_URL: 'https://relay.example.com', RELAY_SECRET: undefined }, t);
  assert.equal(relay.isRelayConfigured(), false);
  assert.equal(relay.relayStreamUrl('https://x/a.m3u8'), null);
  assert.equal(relay.relayThumbUrl('https://x/a.m3u8'), null);
});

test('checkRelay: reachable and secret accepted', async (t) => {
  const server = await startFakeRelay();
  t.after(() => server.close());
  withRelayEnv({ RELAY_URL: `http://127.0.0.1:${server.address().port}`, RELAY_SECRET: SECRET }, t);
  const r = await relay.checkRelay();
  assert.equal(r.configured, true);
  assert.equal(r.reachable, true);
  assert.equal(r.auth, 'ok');
  assert.equal(r.ffmpeg, true);
  assert.equal(r.uptime, 42);
  assert.equal(r.error, null);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'status output must never contain the secret');
});

test('checkRelay: wrong secret is reported as rejected', async (t) => {
  const server = await startFakeRelay();
  t.after(() => server.close());
  withRelayEnv({ RELAY_URL: `http://127.0.0.1:${server.address().port}`, RELAY_SECRET: 'wrong' }, t);
  const r = await relay.checkRelay();
  assert.equal(r.reachable, true);
  assert.equal(r.auth, 'rejected');
  assert.match(r.error, /401/);
});

test('checkRelay: server-side calls prefer RELAY_INTERNAL_URL', async (t) => {
  const server = await startFakeRelay();
  t.after(() => server.close());
  withRelayEnv(
    { RELAY_URL: 'http://unreachable.invalid', RELAY_INTERNAL_URL: `http://127.0.0.1:${server.address().port}`, RELAY_SECRET: SECRET },
    t
  );
  const r = await relay.checkRelay();
  assert.equal(r.usingInternalUrl, true);
  assert.equal(r.reachable, true);
  assert.equal(r.auth, 'ok');
});

test('checkRelay: unreachable relay and missing config fail cleanly', async (t) => {
  withRelayEnv({ RELAY_URL: 'http://127.0.0.1:1', RELAY_SECRET: SECRET }, t);
  const down = await relay.checkRelay({ timeoutMs: 2000 });
  assert.equal(down.reachable, false);
  assert.match(down.error, /health request failed/);

  delete process.env.RELAY_URL;
  const unset = await relay.checkRelay();
  assert.equal(unset.configured, false);
  assert.equal(unset.error, 'RELAY_URL is not set');
});

test('fetchRelayThumb: returns the JPEG, or null on failure', async (t) => {
  const server = await startFakeRelay();
  t.after(() => server.close());
  withRelayEnv({ RELAY_URL: `http://127.0.0.1:${server.address().port}`, RELAY_SECRET: SECRET }, t);
  assert.deepEqual(await relay.fetchRelayThumb('https://cdn.example.com/a.m3u8'), JPEG);

  process.env.RELAY_SECRET = 'wrong';
  assert.equal(await relay.fetchRelayThumb('https://cdn.example.com/a.m3u8'), null);
});
