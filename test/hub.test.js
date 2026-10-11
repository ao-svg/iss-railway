const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { buildZip } = require('../src/zip');
const { cleanHost, cleanUrl, targetFor, rotationFor, compareVersions, readZip, pluginVersionFromZip, PLUGIN_SLUG } = require('../src/hub');

const pluginZip = (version, extra = []) =>
  buildZip([
    { name: `${PLUGIN_SLUG}/${PLUGIN_SLUG}.php`, data: Buffer.from(`<?php\n/**\n * Plugin Name: Zhibo Streaming Table\n * Version: ${version}\n */\n`) },
    { name: `${PLUGIN_SLUG}/includes/table.php`, data: Buffer.from('<?php') },
    ...extra,
  ]);

test('cleanHost keeps only the lower-cased host', () => {
  assert.equal(cleanHost('https://WWW.Example.com/path?x=1'), 'www.example.com');
  assert.equal(cleanHost('example.com:8080'), 'example.com');
  assert.equal(cleanHost(''), '');
});

test('cleanUrl accepts http(s) only and drops trailing slashes', () => {
  assert.equal(cleanUrl('https://zhibo82.com/'), 'https://zhibo82.com');
  assert.equal(cleanUrl(' http://a.test/x/ '), 'http://a.test/x');
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('not a url'), null);
});

test('targetFor: own override, then www twin, then the default', () => {
  const settings = { defaultTarget: 'https://zhibo82.com' };
  const overrides = { 'a.com': 'https://one.test', 'www.b.com': 'https://two.test' };
  assert.equal(targetFor('a.com', settings, overrides), 'https://one.test');
  assert.equal(targetFor('www.a.com', settings, overrides), 'https://one.test');
  assert.equal(targetFor('b.com', settings, overrides), 'https://two.test');
  assert.equal(targetFor('c.com', settings, overrides), 'https://zhibo82.com');
});

test('compareVersions orders dotted versions numerically', () => {
  assert.ok(compareVersions('2.0.10', '2.0.9') > 0);
  assert.ok(compareVersions('2.0', '2.0.1') < 0);
  assert.equal(compareVersions('2.0.0', '2.0'), 0);
});

test('readZip reads stored and deflated entries', () => {
  const stored = readZip(buildZip([{ name: 'a/b.txt', data: Buffer.from('hello') }]));
  assert.deepEqual(stored.names, ['a/b.txt']);
  assert.equal(stored.read('a/b.txt').toString(), 'hello');
  assert.equal(stored.read('missing'), null);

  // Hand-built single-entry zip with a deflated body (what Windows tar / zip tools produce)
  const name = Buffer.from('x.txt');
  const body = zlib.deflateRawSync(Buffer.from('deflated text'));
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + body.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  const zip = readZip(Buffer.concat([local, name, body, central, name, eocd]));
  assert.equal(zip.read('x.txt').toString(), 'deflated text');
});

test('readZip rejects non-zips', () => {
  assert.throws(() => readZip(Buffer.from('this is a tar file, not a zip, padded out to be long enough')), /Not a zip/);
});

test('pluginVersionFromZip reads the Version header', () => {
  assert.equal(pluginVersionFromZip(pluginZip('2.3.4')), '2.3.4');
});

test('pluginVersionFromZip rejects zips with files outside the plugin folder', () => {
  assert.throws(() => pluginVersionFromZip(pluginZip('1.0.0', [{ name: 'evil.php', data: Buffer.from('x') }])), /must be inside/);
});

test('pluginVersionFromZip rejects zips without the main plugin file', () => {
  assert.throws(() => pluginVersionFromZip(buildZip([{ name: `${PLUGIN_SLUG}/readme.txt`, data: Buffer.from('x') }])), /Version header/);
});

test('rotationFor: off, on (default first, no duplicates), and never for overridden domains', () => {
  const settings = { defaultTarget: 'https://zhibo82.com', rotationEnabled: false, rotation: ['https://zazhibo82.com', 'https://zhibo82.com'] };
  const overrides = { 'www.fixed.com': 'https://fixed.test' };
  assert.deepEqual(rotationFor('a.com', settings, overrides), []);
  const on = { ...settings, rotationEnabled: true };
  assert.deepEqual(rotationFor('a.com', on, overrides), ['https://zhibo82.com', 'https://zazhibo82.com']);
  assert.deepEqual(rotationFor('fixed.com', on, overrides), []);
  assert.deepEqual(rotationFor('a.com', { ...on, rotation: [] }, overrides), []);   // only one destination: nothing to rotate
});
