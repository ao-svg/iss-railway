const test = require('node:test');
const assert = require('node:assert/strict');
const { splitTeams } = require('../src/teamSplit');

test('splits on " v " separator', () => {
  assert.deepEqual(splitTeams('Team A v Team B'), { homeTeam: 'Team A', awayTeam: 'Team B' });
});

test('separator is case-insensitive', () => {
  assert.deepEqual(splitTeams('Team A V Team B'), { homeTeam: 'Team A', awayTeam: 'Team B' });
});

test('trims extra whitespace around teams and separator', () => {
  assert.deepEqual(splitTeams('  Team A   v   Team B  '), { homeTeam: 'Team A', awayTeam: 'Team B' });
});

test('no separator leaves awayTeam empty and homeTeam as the full name', () => {
  assert.deepEqual(splitTeams('Single Event Name'), { homeTeam: 'Single Event Name', awayTeam: '' });
});

test('empty/undefined input returns empty strings', () => {
  assert.deepEqual(splitTeams(''), { homeTeam: '', awayTeam: '' });
  assert.deepEqual(splitTeams(undefined), { homeTeam: '', awayTeam: '' });
});
