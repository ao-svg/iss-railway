const test = require('node:test');
const assert = require('node:assert/strict');
const { screenshotId, playerHtml } = require('../src/screenshots');
const { enrichRowsWithSourceStatus } = require('../src/sourceChecks');

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
