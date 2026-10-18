const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { screenshotId, playerHtml, encodeGif } = require('../src/screenshots');
const { enrichRowsWithSourceStatus } = require('../src/sourceChecks');

function solidPng(width, height, r, g, b) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('screenshotId: stable, filesystem-safe, and distinct per URL', () => {
  const a = screenshotId('https://x.example/a.m3u8?token=1');
  assert.equal(a, screenshotId('https://x.example/a.m3u8?token=1'));
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.notEqual(a, screenshotId('https://x.example/a.m3u8?token=2'));
});

test('playerHtml: embeds the URL as a JS string, loads hls.js, and cannot break out of the script tag', () => {
  const html = playerHtml('https://x.example/a.m3u8?a=1&b="2"</script><script>alert(1)');
  assert.ok(html.includes('hls.min.js'));
  assert.ok(html.includes('<video id="v"'));
  assert.ok(html.includes('"https://x.example/a.m3u8?a=1&b=\\"2\\"<\\/script>'));
  assert.ok(!html.includes('</script><script>alert'));
});

test('enrichRowsWithSourceStatus: sourceScreenshot links successful captures with the public base URL, null otherwise', () => {
  const rows = [{ eventId: 'e1', channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8', 'http://c.m3u8'] }] }];
  const shots = {
    'http://a.m3u8': { ok: true, file: 'aaa.jpg' },
    'http://b.m3u8': { ok: false, error: 'timeout (no frame)' },
  };
  const out = enrichRowsWithSourceStatus(rows, () => null, {
    getScreenshot: (url) => shots[url] || null,
    publicBaseUrl: 'https://app.example',
  });
  assert.deepEqual(out[0].channels[0].sourceScreenshot, ['https://app.example/screenshots/aaa.jpg', null, null]);
});

test('enrichRowsWithSourceStatus: without screenshot options every sourceScreenshot is null', () => {
  const rows = [{ eventId: 'e1', channels: [{ name: 'Sky', sources: ['http://a.m3u8'] }] }];
  const out = enrichRowsWithSourceStatus(rows, () => ({ status: 'stream' }));
  assert.deepEqual(out[0].channels[0].sourceScreenshot, [null]);
});

test('enrichRowsWithSourceStatus: sourceGif links successful gif captures separately from sourceScreenshot', () => {
  const rows = [{ eventId: 'e1', channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8'] }] }];
  const shots = {
    'http://a.m3u8': { ok: true, file: 'aaa.jpg', gifOk: true, gifFile: 'aaa.gif' },
    'http://b.m3u8': { ok: true, file: 'bbb.jpg' }, // still captured, no gif (e.g. an HTML-page source)
  };
  const out = enrichRowsWithSourceStatus(rows, () => null, {
    getScreenshot: (url) => shots[url] || null,
    publicBaseUrl: 'https://app.example',
  });
  assert.deepEqual(out[0].channels[0].sourceGif, ['https://app.example/screenshots/aaa.gif', null]);
  assert.deepEqual(out[0].channels[0].sourceScreenshot, [
    'https://app.example/screenshots/aaa.jpg',
    'https://app.example/screenshots/bbb.jpg',
  ]);
});

test('encodeGif: produces a valid GIF89a buffer from a handful of PNG frames', async () => {
  const frames = [solidPng(4, 4, 255, 0, 0), solidPng(4, 4, 0, 255, 0), solidPng(4, 4, 0, 0, 255)];
  const buf = await encodeGif(frames, 4, 4);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(buf.length > 20);
});

test('encodeGif: accepts a plain Uint8Array per frame, not just a Buffer', async () => {
  // page.screenshot() hands back a Uint8Array, not a real Buffer — a
  // Buffer-only frame here would pass while production breaks with
  // "data.readUInt32BE is not a function" on every single capture.
  const frames = [solidPng(4, 4, 255, 0, 0), solidPng(4, 4, 0, 255, 0)].map((buf) => new Uint8Array(buf));
  assert.ok(!Buffer.isBuffer(frames[0]) && frames[0] instanceof Uint8Array);
  const buf = await encodeGif(frames, 4, 4);
  assert.equal(buf.slice(0, 6).toString('ascii'), 'GIF89a');
});

test('playerUrl/playerResponse: the player page is served from the https PLAYER_ORIGIN, 404 for anything else', () => {
  const { playerUrl, playerResponse, PLAYER_ORIGIN } = require('../src/screenshots');
  assert.ok(PLAYER_ORIGIN.startsWith('https://'), 'https, so an http:// stream fails as mixed content like on the real sites');
  const stream = 'https://x.example/a.m3u8?t=1&b=2';
  const url = playerUrl(stream);
  assert.ok(url.startsWith(`${PLAYER_ORIGIN}/player.html?u=`));
  const ok = playerResponse(url);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, playerHtml(stream));
  assert.equal(playerResponse(`${PLAYER_ORIGIN}/favicon.ico`).status, 404);
  assert.equal(playerResponse(`${PLAYER_ORIGIN}/player.html`).status, 404);
  assert.equal(playerResponse('https://other.example/player.html?u=x').status, 404);
});

test('captureAll no longer launches the capture browser with web security disabled', () => {
  const src = require('fs').readFileSync(require.resolve('../src/screenshots'), 'utf8');
  assert.ok(!/'--disable-web-security'/.test(src));
});

test('carryOver: the new URL keeps the old capture until it has its own', () => {
  const screenshots = require('../src/screenshots');
  const from = 'https://carry.example/a.m3u8?token=old';
  const to = 'https://carry.example/a.m3u8?token=new';
  screenshots.getAllScreenshots()[from] = { ok: true, file: 'x.png', gifOk: true, gifFile: 'x.gif' };
  screenshots.carryOver(from, to);
  assert.equal(screenshots.getScreenshot(to).file, 'x.png');
  screenshots.getAllScreenshots()[to] = { ok: false, error: 'own' };
  screenshots.carryOver(from, to);
  assert.equal(screenshots.getScreenshot(to).error, 'own', 'never overwrites');
  delete screenshots.getAllScreenshots()[from];
  delete screenshots.getAllScreenshots()[to];
});
