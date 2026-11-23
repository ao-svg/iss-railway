// The hub's copy of the ABS3 Theme Bridge: fetched from ABS3, kept on disk,
// still served when ABS3 is down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mirror-'));
process.env.DATA_DIR = tmp;

const express = require('express');
const { mountBridgeMirror } = require('../src/bridgeMirror');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('serves the release it fetched from ABS3, and keeps serving it when ABS3 is gone', async () => {
  const zip = Buffer.concat([Buffer.from('PK'), Buffer.alloc(2000, 7)]);
  const abs3 = http.createServer((req, res) => {
    if (req.url === '/plugin/update.json') return res.end(JSON.stringify({ name: 'ABS3 Theme Bridge', slug: 'abs3-theme-bridge', version: '2.14.0', download_url: 'http://abs3.invalid/x.zip' }));
    if (req.url === '/plugin/abs3-theme-bridge.zip') return res.end(zip);
    res.statusCode = 404; res.end();
  });
  const abs3Port = await listen(abs3);
  process.env.ABS3_URL = 'http://127.0.0.1:' + abs3Port;

  const app = express();
  mountBridgeMirror(app, () => 'https://hub.example');
  const hub = http.createServer(app);
  const port = await listen(hub);
  const get = (p) => fetch('http://127.0.0.1:' + port + p);

  const meta = await (await get('/bridge/update.json')).json();
  assert.equal(meta.version, '2.14.0');
  // the plugin downloads from the hub, not from the address ABS3 gave
  assert.equal(meta.download_url, 'https://hub.example/bridge/abs3-theme-bridge.zip');
  const got = Buffer.from(await (await get('/bridge/abs3-theme-bridge.zip')).arrayBuffer());
  assert.equal(got.length, zip.length);

  // ABS3 goes away: the cached copy is still served
  await new Promise((r) => abs3.close(r));
  const again = await get('/bridge/update.json');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).version, '2.14.0');

  hub.close();
});

test('refuses an answer that is not a zip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mirror-bad-'));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/bridgeMirror')];
  delete require.cache[require.resolve('../src/dataDir')];
  const fresh = require('../src/bridgeMirror');
  const abs3 = http.createServer((req, res) => {
    if (req.url === '/plugin/update.json') return res.end(JSON.stringify({ version: '9.9.9' }));
    res.end('<html>error page</html>'.repeat(100));
  });
  const abs3Port = await listen(abs3);
  process.env.ABS3_URL = 'http://127.0.0.1:' + abs3Port;
  const app = express();
  fresh.mountBridgeMirror(app, () => 'https://hub.example');
  const hub = http.createServer(app);
  const port = await listen(hub);
  const r = await fetch('http://127.0.0.1:' + port + '/bridge/update.json');
  assert.equal(r.status, 503);
  hub.close(); abs3.close();
});
