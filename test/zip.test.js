const test = require('node:test');
const assert = require('node:assert/strict');
const { buildZip, crc32 } = require('../src/zip');

test('crc32: matches the standard check value for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('buildZip: produces a well-formed store-only archive with a readable central directory', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello'), mtime: new Date('2026-09-23T10:00:00Z') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3]) },
  ]);
  // local header of first entry
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(8), 0); // stored
  assert.equal(zip.readUInt32LE(14), crc32(Buffer.from('hello')));
  assert.equal(zip.toString('utf8', 30, 35), 'a.txt');
  assert.equal(zip.toString('utf8', 35, 40), 'hello');
  // end of central directory
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2); // entries
  const cdOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(zip.readUInt32LE(cdOffset), 0x02014b50);
  assert.equal(zip.readUInt32LE(cdOffset + 42), 0); // first local header offset
  assert.equal(zip.toString('utf8', cdOffset + 46, cdOffset + 51), 'a.txt');
});

test('buildZip: empty input is still a valid empty archive', () => {
  const zip = buildZip([]);
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});
