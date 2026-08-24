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

test('HEADER ends with Status', () => {
  assert.equal(HEADER[HEADER.length - 1], 'Status');
});

test('row with no status renders blank Status column', () => {
  const out = rowsToCsv([baseRow()]);
  const lines = out.trim().split('\n');
  const dataCols = lines[1].split(',');
  assert.equal(dataCols[dataCols.length - 1], '');
});

test('row with status live/ended renders verbatim', () => {
  const out = rowsToCsv([baseRow({ status: 'live' }), baseRow({ eventId: 'e2', status: 'ended' })]);
  const lines = out.trim().split('\n');
  const liveCols = lines[1].split(',');
  const endedCols = lines[2].split(',');
  assert.equal(liveCols[liveCols.length - 1], 'live');
  assert.equal(endedCols[endedCols.length - 1], 'ended');
});

test('column count matches header count for every data row', () => {
  const out = rowsToCsv([baseRow(), baseRow({ eventId: 'e2', status: 'live' })]);
  const lines = out.trim().split('\n');
  for (const line of lines) {
    assert.equal(line.split(',').length, HEADER.length);
  }
});
