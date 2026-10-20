const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRows, sameTeam } = require('../src/matchMerge');

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

test('sameTeam: tolerant of punctuation, accents, club-form words and short forms', () => {
  assert.ok(sameTeam('  Chelsea FC  ', 'Chelsea'));
  assert.ok(sameTeam('Sporting CF', 'Sporting'));
  assert.ok(sameTeam('St. Louis Blues', 'St Louis Blues'));
  assert.ok(sameTeam('AFC Bournemouth', 'Bournemouth AFC'));
  assert.ok(sameTeam('Brighton & Hove Albion', 'Brighton'));
  assert.ok(sameTeam('Man City', 'Manchester City'));
  assert.ok(sameTeam('Man Utd', 'Manchester United'));
  assert.ok(sameTeam('Atlético Madrid', 'Atletico Madrid'));
  assert.ok(sameTeam('Tottenham Hotspur U18', 'Tottenham Hotspur U18s'));
});

test('sameTeam: different clubs and different sides of one club stay apart', () => {
  assert.ok(!sameTeam('Manchester United', 'Manchester City'));
  assert.ok(!sameTeam('Arsenal Women', 'Arsenal'));
  assert.ok(!sameTeam('Tottenham Hotspur U18', 'Tottenham Hotspur'));
  assert.ok(!sameTeam('Real Madrid', 'Real Sociedad'));
  assert.ok(!sameTeam('', 'Rangers'));
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
  // A loose name match (Munich / München) only merges within 15 min; the
  // same teams exactly would merge up to an hour apart (tested below).
  const rows = [
    row({ eventId: 'a', homeTeam: 'Bayern Munich', awayTeam: 'Arsenal', matchDateUTC: '2026-09-18T19:00:00Z' }),
    row({ eventId: 'b', homeTeam: 'Bayern München', awayTeam: 'Arsenal', matchDateUTC: '2026-09-18T19:30:00Z' }), // 30 min later
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
});

test('swapped home/away at the same kickoff is the same game (sources disagree on home side)', () => {
  const rows = [
    row({ eventId: 'a', homeTeam: 'Pittsburgh Steelers', awayTeam: 'New Orleans Saints', sportType: 'American Football' }),
    row({ eventId: 'b', homeTeam: 'New Orleans Saints', awayTeam: 'Pittsburgh Steelers', sportType: 'American Football', source: 'livesportsontv' }),
  ];
  assert.equal(mergeRows(rows).length, 1);
});

test('the return fixture (swapped, weeks later) stays a separate game', () => {
  const rows = [
    row({ eventId: 'a', homeTeam: 'Chelsea', awayTeam: 'Brentford' }),
    row({ eventId: 'b', homeTeam: 'Brentford', awayTeam: 'Chelsea', matchDateUTC: '2027-02-18T19:00:00Z' }),
  ];
  assert.equal(mergeRows(rows).length, 2);
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
  // Loose name matches, so the 15-min window applies.
  const rows = [
    row({ eventId: 'a', homeTeam: 'Bayern Munich', awayTeam: 'Arsenal', matchDateUTC: '2026-09-18T19:00:00Z' }),
    row({ eventId: 'b', homeTeam: 'Bayern München', awayTeam: 'Arsenal', matchDateUTC: '2026-09-18T19:12:00Z' }),
    row({ eventId: 'c', homeTeam: 'Bayern Muenchen', awayTeam: 'Arsenal', matchDateUTC: '2026-09-18T19:24:00Z' }),
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

test('the same game spelled differently by two sources merges into one row', () => {
  const rows = [
    row({ eventId: 'w', source: 'wheresthematch', homeTeam: 'St Louis Blues', awayTeam: 'Winnipeg Jets', sportType: 'Ice Hockey',
      matchDateUTC: '2026-10-21T01:00:00+01:00', channels: [{ name: 'Sky Sports+', sources: [] }] }),
    row({ eventId: 'l', source: 'livesportsontv', homeTeam: 'St. Louis Blues', awayTeam: 'Winnipeg Jets', sportType: 'Ice Hockey',
      matchDateUTC: '2026-10-21T00:00:00.000Z', channels: [{ name: 'ESPN', sources: ['https://a/espn.m3u8'] }] }),
  ];
  const merged = mergeRows(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'wheresthematch');
  assert.deepEqual(merged[0].channels.map((c) => c.name), ['Sky Sports+', 'ESPN']);
});

test("a women's game at the same time as the men's game stays a separate row", () => {
  const rows = [
    row({ eventId: 'm', homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
    row({ eventId: 'w', homeTeam: 'Arsenal Women', awayTeam: 'Chelsea Women' }),
  ];
  assert.equal(mergeRows(rows).length, 2);
});

test('the same game merges across spelling variants when kickoff and one team match', () => {
  const pairs = [
    [['Napoli', 'Bodo Glimt'], ['Napoli', 'Bodø / Glimt']],
    [['FC Cincinnati', 'DC United'], ['FC Cincinnati', 'D.C. United']],
    [['Wolves', 'Portsmouth'], ['Wolverhampton Wanderers', 'Portsmouth']],
    [['Bayern Munich', 'Arsenal'], ['Bayern München', 'Arsenal FC']],
    [['Real Madrid', 'Red Bull Leipzig'], ['Real Madrid', 'RB Leipzig']],
    [['Fenerbahçe', 'Slavia Prague'], ['Fenerbahce', 'Slavia Praha']],
    [['Paris Saint Germain', 'Barcelona'], ['PSG', 'FC Barcelona']],
  ];
  for (const [[h1, a1], [h2, a2]] of pairs) {
    const merged = mergeRows([
      row({ eventId: 'w', source: 'wheresthematch', homeTeam: h1, awayTeam: a1 }),
      row({ eventId: 'l', source: 'livesportsontv', homeTeam: h2, awayTeam: a2 }),
    ]);
    assert.equal(merged.length, 1, `${h1} v ${a1} / ${h2} v ${a2}`);
  }
});

test('games at the same kickoff stay apart when only a common word is shared, or the sport differs', () => {
  assert.equal(mergeRows([
    row({ eventId: 'a', homeTeam: 'Real Madrid', awayTeam: 'RB Leipzig' }),
    row({ eventId: 'b', homeTeam: 'Real Betis', awayTeam: 'Feyenoord' }),
  ]).length, 2);
  assert.equal(mergeRows([
    row({ eventId: 'a', homeTeam: 'Atlanta', awayTeam: 'Boston', sportType: 'Basketball' }),
    row({ eventId: 'b', homeTeam: 'Atlanta', awayTeam: 'Boston', sportType: 'Ice Hockey' }),
  ]).length, 2);
});

test('events without an away side merge on the name alone', () => {
  const merged = mergeRows([
    row({ eventId: 'a', homeTeam: 'Live Racing', awayTeam: '', sportType: 'Horse Racing', channels: [{ name: 'ITV1', sources: [] }] }),
    row({ eventId: 'b', homeTeam: 'Live Racing', awayTeam: '', sportType: 'Horse Racing', channels: [{ name: 'RacingTV', sources: [] }] }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].channels.length, 2);
});

test('the same two teams 20 minutes apart (sources disagree on kickoff) merge; other games that far apart do not', () => {
  const nfl = { sportType: 'American Football', homeTeam: 'Las Vegas Raiders', awayTeam: 'Los Angeles Rams' };
  assert.equal(mergeRows([
    row({ eventId: 'w', ...nfl, matchDateUTC: '2026-10-25T20:05:00Z' }),
    row({ eventId: 'l', ...nfl, source: 'livesportsontv', matchDateUTC: '2026-10-25T20:25:00.000Z' }),
  ]).length, 1);
  assert.equal(mergeRows([
    row({ eventId: 'a', homeTeam: 'Bayern Munich', awayTeam: 'Arsenal', matchDateUTC: '2026-10-21T19:00:00Z' }),
    row({ eventId: 'b', homeTeam: 'Bayern München', awayTeam: 'Arsenal', matchDateUTC: '2026-10-21T19:40:00Z' }),
  ]).length, 2, 'a looser name match needs the kickoff to agree');
});

test('an MLB doubleheader (same teams, hours apart) stays two games', () => {
  const mlb = { sportType: 'Baseball', homeTeam: 'Tampa Bay Rays', awayTeam: 'Milwaukee Brewers' };
  assert.equal(mergeRows([
    row({ eventId: 'g1', ...mlb, matchDateUTC: '2026-10-21T17:05:00Z' }),
    row({ eventId: 'g2', ...mlb, matchDateUTC: '2026-10-21T21:10:00Z' }),
  ]).length, 2);
});
