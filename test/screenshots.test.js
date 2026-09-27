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
