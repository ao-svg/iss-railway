const test = require('node:test');
const assert = require('node:assert/strict');
const { gameKey, applyManualChannels } = require('../src/manualChannels');

function row(overrides = {}) {
  return {
    eventId: 'e1',
    source: 'wheresthematch',
    league: 'Premier League',
    homeTeam: 'Chelsea',
    awayTeam: 'Brentford',
    matchDateUTC: '2026-09-18T19:00:00Z',
    sportType: 'Football',
    channels: [],
    ...overrides,
  };
}

test('gameKey: normalizes team names and truncates to date-only (ignores exact kickoff time)', () => {
  const a = gameKey(row({ homeTeam: 'Chelsea FC', awayTeam: 'Brentford', matchDateUTC: '2026-09-18T19:00:00Z' }));
  const b = gameKey(row({ homeTeam: 'chelsea', awayTeam: 'Brentford', matchDateUTC: '2026-09-18T20:30:00+01:00' }));
  assert.equal(a, b);
});

test('gameKey: different dates produce different keys, even for the same teams', () => {
  const a = gameKey(row({ matchDateUTC: '2026-09-18T19:00:00Z' }));
  const b = gameKey(row({ matchDateUTC: '2026-10-02T19:00:00Z' }));
  assert.notEqual(a, b);
});

test('applyManualChannels: adds a new channel to a row that had none', () => {
  const r = row({ channels: [] });
  const key = gameKey(r);
  const store = { [key]: { homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, matchDateUTC: r.matchDateUTC, channels: [{ name: 'ESPN', url: 'https://example.com/espn.m3u8', addedAt: 'x' }] } };
  const [merged] = applyManualChannels([r], store);
  assert.equal(merged.channels.length, 1);
  assert.deepEqual(merged.channels[0], { name: 'ESPN', sources: ['https://example.com/espn.m3u8'], manual: true });
});

test('applyManualChannels: merges into an existing same-named channel that has empty sources, rather than duplicating it', () => {
  const r = row({ channels: [{ name: 'Sky Sports', sources: [] }] });
  const key = gameKey(r);
  const store = { [key]: { homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, matchDateUTC: r.matchDateUTC, channels: [{ name: 'sky sports', url: 'https://example.com/sky.m3u8', addedAt: 'x' }] } };
  const [merged] = applyManualChannels([r], store);
  assert.equal(merged.channels.length, 1);
  assert.equal(merged.channels[0].name, 'Sky Sports');
  assert.deepEqual(merged.channels[0].sources, ['https://example.com/sky.m3u8']);
  assert.equal(merged.channels[0].manual, true);
});

test('applyManualChannels: is idempotent — applying twice with the same store produces the same result, no duplicate entries', () => {
  const r = row({ channels: [] });
  const key = gameKey(r);
  const store = { [key]: { homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, matchDateUTC: r.matchDateUTC, channels: [{ name: 'ESPN', url: 'https://example.com/espn.m3u8', addedAt: 'x' }] } };
  const once = applyManualChannels([r], store);
  const twice = applyManualChannels(once, store);
  assert.equal(twice[0].channels.length, 1);
  assert.deepEqual(twice[0].channels[0].sources, ['https://example.com/espn.m3u8']);
});

test('applyManualChannels: a channel no longer present in the store (removed) is dropped on the next apply', () => {
  const r = row({ channels: [] });
  const key = gameKey(r);
  const storeWithEntry = { [key]: { homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, matchDateUTC: r.matchDateUTC, channels: [{ name: 'ESPN', url: 'https://example.com/espn.m3u8', addedAt: 'x' }] } };
  const [withManual] = applyManualChannels([r], storeWithEntry);
  assert.equal(withManual.channels.length, 1);

  const [afterRemoval] = applyManualChannels([withManual], {}); // store no longer has the entry
  assert.equal(afterRemoval.channels.length, 0);
});

test('applyManualChannels: a manual entry for a game not present in rows is simply skipped, no crash', () => {
  const r = row({ channels: [] });
  const store = { 'unrelated|team|pair|2026-01-01': { homeTeam: 'X', awayTeam: 'Y', league: 'Z', matchDateUTC: '2026-01-01T00:00:00Z', channels: [{ name: 'ESPN', url: 'https://example.com/espn.m3u8', addedAt: 'x' }] } };
  const [merged] = applyManualChannels([r], store);
  assert.equal(merged.channels.length, 0);
});

test('applyManualChannels: never mutates the input rows', () => {
  const r = row({ channels: [{ name: 'Sky Sports', sources: [] }] });
  const key = gameKey(r);
  const store = { [key]: { homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, matchDateUTC: r.matchDateUTC, channels: [{ name: 'Sky Sports', url: 'https://example.com/sky.m3u8', addedAt: 'x' }] } };
  applyManualChannels([r], store);
  assert.deepEqual(r.channels, [{ name: 'Sky Sports', sources: [] }]);
});
