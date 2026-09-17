const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRows, normalizeTeamName } = require('../src/matchMerge');

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

test('normalizeTeamName: lowercases, trims, strips common suffixes', () => {
  assert.equal(normalizeTeamName('  Chelsea FC  '), 'chelsea');
  assert.equal(normalizeTeamName('Sporting CF'), 'sporting');
  assert.equal(normalizeTeamName('Rangers'), 'rangers');
  assert.equal(normalizeTeamName(''), '');
});

test('same team pair + times within tolerance merges into one row with unioned channels', () => {
  const rows = [
    row({
      eventId: 'sdb-1',
      source: 'sportsdb',
      matchDateUTC: '2026-09-18T19:00:00Z',
      channels: [{ name: 'Sky Sports', sources: ['https://a.m3u8'] }],
    }),
    row({
      eventId: 'wtm-1',
      source: 'wheresthematch',
      matchDateUTC: '2026-09-18T19:05:00Z', // 5 min later, within tolerance
      channels: [{ name: 'ECB.co.uk', sources: [] }],
    }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].channels.length, 2);
  const names = merged[0].channels.map((c) => c.name).sort();
  assert.deepEqual(names, ['ECB.co.uk', 'Sky Sports']);
});

test('times outside tolerance stay separate', () => {
  const rows = [
    row({ eventId: 'a', matchDateUTC: '2026-09-18T19:00:00Z' }),
    row({ eventId: 'b', matchDateUTC: '2026-09-18T19:30:00Z' }), // 30 min later, outside 15-min tolerance
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});

test('swapped home/away does NOT merge — treated as a different game', () => {
  const rows = [
    row({ eventId: 'a', homeTeam: 'Chelsea', awayTeam: 'Brentford' }),
    row({ eventId: 'b', homeTeam: 'Brentford', awayTeam: 'Chelsea', source: 'sportsdb' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});

test('3-way merge: all three sources reporting the same game merges into one row', () => {
  const rows = [
    row({ eventId: 'sdb', source: 'sportsdb', channels: [{ name: 'CBS', sources: ['url1'] }] }),
    row({ eventId: 'wtm', source: 'wheresthematch', matchDateUTC: '2026-09-18T19:03:00Z', channels: [{ name: 'ESPN', sources: ['url2'] }] }),
    row({ eventId: 'lsotv', source: 'livesportsontv', matchDateUTC: '2026-09-18T18:58:00Z', channels: [{ name: 'FOX', sources: ['url3'] }] }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 1);
  const names = merged[0].channels.map((c) => c.name).sort();
  assert.deepEqual(names, ['CBS', 'ESPN', 'FOX']);
});

test('metadata-source priority: sportsdb > wheresthematch > livesportsontv', () => {
  const rows = [
    row({ eventId: 'wtm', source: 'wheresthematch', homeLogo: '' }),
    row({ eventId: 'sdb', source: 'sportsdb', homeLogo: 'https://logo.png', matchDateUTC: '2026-09-18T19:02:00Z' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].eventId, 'sdb');
  assert.equal(merged[0].homeLogo, 'https://logo.png');
});

test('metadata priority falls back to wheresthematch over livesportsontv when no sportsdb row exists', () => {
  const rows = [
    row({ eventId: 'lsotv', source: 'livesportsontv' }),
    row({ eventId: 'wtm', source: 'wheresthematch', matchDateUTC: '2026-09-18T19:02:00Z' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged[0].eventId, 'wtm');
});

test('channel dedup within the union is case-insensitive, first-seen casing wins', () => {
  const rows = [
    row({ eventId: 'a', channels: [{ name: 'ESPN', sources: ['url1'] }] }),
    row({ eventId: 'b', matchDateUTC: '2026-09-18T19:05:00Z', channels: [{ name: 'espn', sources: ['url2'] }] }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged[0].channels.length, 1);
  assert.equal(merged[0].channels[0].name, 'ESPN');
  assert.deepEqual(merged[0].channels[0].sources.sort(), ['url1', 'url2']);
});

test('different team pairs never merge, even at the exact same kickoff time', () => {
  const rows = [
    row({ eventId: 'a', homeTeam: 'Chelsea', awayTeam: 'Brentford' }),
    row({ eventId: 'b', homeTeam: 'Arsenal', awayTeam: 'Fulham' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});

test('a row with an unparseable matchDateUTC becomes its own singleton cluster', () => {
  const rows = [
    row({ eventId: 'a', matchDateUTC: 'not-a-date' }),
    row({ eventId: 'b', matchDateUTC: 'also-not-a-date' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});

test('cluster anchoring uses the first row, not a chained previous-item comparison (no unbounded drift)', () => {
  // 19:00, 19:12 (12 min after first, merges), 19:24 (24 min after first -> NOT merged into first cluster)
  const rows = [
    row({ eventId: 'a', matchDateUTC: '2026-09-18T19:00:00Z' }),
    row({ eventId: 'b', matchDateUTC: '2026-09-18T19:12:00Z' }),
    row({ eventId: 'c', matchDateUTC: '2026-09-18T19:24:00Z' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2); // {a,b} merged, {c} separate
});

test('regression: SportsDB-format (no tz offset) and wheresthematch-format (explicit offset) rows for the same real kickoff merge correctly', () => {
  // These two strings represent the EXACT same real-world instant (19:00
  // UTC) but in the two different formats these sources actually produce.
  // `new Date(...)` alone would parse the no-offset one as local time,
  // silently breaking this merge on any machine not itself running in
  // UTC — this is exactly the bug found verifying against real data.
  const rows = [
    row({ eventId: 'sdb', source: 'sportsdb', matchDateUTC: '2026-09-18T19:00:00', channels: [{ name: 'Stöð 2 Sport', sources: [] }] }),
    row({ eventId: 'wtm', source: 'wheresthematch', matchDateUTC: '2026-09-18T20:00:00+01:00', channels: [{ name: 'Sky Sports', sources: [] }] }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].channels.length, 2);
});

test('three-team-pair groups each merge independently', () => {
  const rows = [
    row({ eventId: 'a1', homeTeam: 'Chelsea', awayTeam: 'Brentford', source: 'sportsdb' }),
    row({ eventId: 'a2', homeTeam: 'Chelsea', awayTeam: 'Brentford', source: 'wheresthematch', matchDateUTC: '2026-09-18T19:02:00Z' }),
    row({ eventId: 'b1', homeTeam: 'Arsenal', awayTeam: 'Fulham', source: 'sportsdb' }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});
