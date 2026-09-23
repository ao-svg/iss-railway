const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsToCsv, HEADER } = require('../src/csv');

function baseRow(overrides = {}) {
  return {
    eventId: 'e1',
    source: 'sportsdb',
    league: 'Premier League',
    rawLeague: 'Premier League',
    homeTeam: 'A',
    awayTeam: 'B',
    matchDateUTC: '2026-08-24T12:00:00Z',
    channels: [],
    ...overrides,
  };
}

// Trailing per-source blocks, in order: 10 Status, 10 Working, 10 Cors, 10 Resolved, 10 Screenshot.
const TRAILING = 50;
const statusBlock = (cols) => cols.slice(-50, -40);
const workingBlock = (cols) => cols.slice(-40, -30);
const corsBlock = (cols) => cols.slice(-30, -20);
const resolvedBlock = (cols) => cols.slice(-20, -10);
const screenshotBlock = (cols) => cols.slice(-10);

test('HEADER has Status followed by 10 each of Source_Status, _Working, _Cors, _Resolved, _Screenshot columns', () => {
  assert.equal(HEADER[HEADER.length - TRAILING - 1], 'Status');
  assert.deepEqual(statusBlock(HEADER), Array.from({ length: 10 }, (_, i) => `Source${i + 1}Status`));
  assert.deepEqual(workingBlock(HEADER), Array.from({ length: 10 }, (_, i) => `Source${i + 1}Working`));
  assert.deepEqual(corsBlock(HEADER), Array.from({ length: 10 }, (_, i) => `Source${i + 1}Cors`));
  assert.deepEqual(resolvedBlock(HEADER), Array.from({ length: 10 }, (_, i) => `Source${i + 1}Resolved`));
  assert.deepEqual(screenshotBlock(HEADER), Array.from({ length: 10 }, (_, i) => `Source${i + 1}Screenshot`));
});

test('sourceScreenshot renders the link in Source_N_Screenshot, blank when none', () => {
  const out = rowsToCsv([
    baseRow({
      channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8'], sourceScreenshot: ['https://app.example/screenshots/aaa.jpg', null] }],
    }),
  ]);
  const cols = out.trim().split('\n')[1].split(',');
  assert.deepEqual(screenshotBlock(cols).slice(0, 2), ['https://app.example/screenshots/aaa.jpg', '']);
});

test('sourceResolved renders the redirected/tokenized URL in Source_N_Resolved, blank when none', () => {
  const out = rowsToCsv([
    baseRow({
      channels: [
        {
          name: 'Sky',
          sources: ['http://a.m3u8', 'http://b.m3u8'],
          sourceResolved: ['http://cdn.example/a.m3u8?token=abc', null],
        },
      ],
    }),
  ]);
  const cols = out.trim().split('\n')[1].split(',');
  assert.deepEqual(resolvedBlock(cols).slice(0, 2), ['http://cdn.example/a.m3u8?token=abc', '']);
});

test('row with no source check data renders blank Status/Working/Cors columns', () => {
  const out = rowsToCsv([baseRow({ channels: [{ name: 'Sky', sources: ['http://a.m3u8'] }] })]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  assert.deepEqual(dataCols.slice(-TRAILING), Array(TRAILING).fill(''));
});

test('row with sourceStatuses renders them in the matching Source_N_Status column', () => {
  const out = rowsToCsv([
    baseRow({ channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8'], sourceStatuses: ['stream', 'dead'] }] }),
  ]);
  const lines = out.trim().split('\n');
  const statusCols = statusBlock(lines[1].split(','));
  assert.equal(statusCols[0], 'stream');
  assert.equal(statusCols[1], 'dead');
  assert.deepEqual(statusCols.slice(2), Array(8).fill(''));
});

test('sourceWorking/sourceCors render as yes/no, null or missing as blank', () => {
  const out = rowsToCsv([
    baseRow({
      channels: [
        {
          name: 'Sky',
          sources: ['http://a.m3u8', 'http://b.m3u8', 'http://c.m3u8'],
          sourceStatuses: ['nocors', 'dead', 'stream'],
          sourceWorking: [true, false, null],
          sourceCors: [false, null, true],
        },
      ],
    }),
  ]);
  const cols = out.trim().split('\n')[1].split(',');
  assert.deepEqual(workingBlock(cols).slice(0, 3), ['yes', 'no', '']);
  assert.deepEqual(corsBlock(cols).slice(0, 3), ['no', '', 'yes']);
});

test('row with no status renders blank Status column', () => {
  const out = rowsToCsv([baseRow()]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  assert.equal(dataCols[dataCols.length - TRAILING - 1], '');
});

test('row with status live/ended renders verbatim', () => {
  const out = rowsToCsv([baseRow({ status: 'live' }), baseRow({ eventId: 'e2', status: 'ended' })]);
  const lines = out.trim().split('\n');
  const liveCols = lines[1].split(',');
  const endedCols = lines[2].split(',');
  assert.equal(liveCols[liveCols.length - TRAILING - 1], 'live');
  assert.equal(endedCols[endedCols.length - TRAILING - 1], 'ended');
});

test('column count matches header count for every data row', () => {
  const out = rowsToCsv([baseRow(), baseRow({ eventId: 'e2', status: 'live' })]);
  const lines = out.trim().split('\n');
  for (const line of lines) {
    assert.equal(line.split(',').length, HEADER.length);
  }
});
