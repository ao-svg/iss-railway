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

test('HEADER has Status followed by 10 Source_Status columns', () => {
  assert.equal(HEADER[HEADER.length - 11], 'Status');
  assert.deepEqual(HEADER.slice(-10), [
    'Source1Status', 'Source2Status', 'Source3Status', 'Source4Status', 'Source5Status',
    'Source6Status', 'Source7Status', 'Source8Status', 'Source9Status', 'Source10Status',
  ]);
});

test('row with no sourceStatuses renders blank Source_Status columns', () => {
  const out = rowsToCsv([baseRow({ channels: [{ name: 'Sky', sources: ['http://a.m3u8'] }] })]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  assert.deepEqual(dataCols.slice(-10), Array(10).fill(''));
});

test('row with sourceStatuses renders them in the matching Source_N_Status column', () => {
  const out = rowsToCsv([
    baseRow({ channels: [{ name: 'Sky', sources: ['http://a.m3u8', 'http://b.m3u8'], sourceStatuses: ['stream', 'dead'] }] }),
  ]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  const statusCols = dataCols.slice(-10);
  assert.equal(statusCols[0], 'stream');
  assert.equal(statusCols[1], 'dead');
  assert.deepEqual(statusCols.slice(2), Array(8).fill(''));
});

test('row with no status renders blank Status column', () => {
  const out = rowsToCsv([baseRow()]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  assert.equal(dataCols[dataCols.length - 11], '');
});

test('row with status live/ended renders verbatim', () => {
  const out = rowsToCsv([baseRow({ status: 'live' }), baseRow({ eventId: 'e2', status: 'ended' })]);
  const lines = out.trim().split('\n');
  const liveCols = lines[1].split(',');
  const endedCols = lines[2].split(',');
  assert.equal(liveCols[liveCols.length - 11], 'live');
  assert.equal(endedCols[endedCols.length - 11], 'ended');
});

test('column count matches header count for every data row', () => {
  const out = rowsToCsv([baseRow(), baseRow({ eventId: 'e2', status: 'live' })]);
  const lines = out.trim().split('\n');
  for (const line of lines) {
    assert.equal(line.split(',').length, HEADER.length);
  }
});
