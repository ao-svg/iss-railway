const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLiveRow } = require('../src/liveTv');

const fakeDeps = {
  canonicalLeague: (raw) => (raw === 'EPL' ? 'Premier League' : raw),
  getTranslation: (name) => {
    const table = { 'Premier League': { zh: '英超' }, 'Team A': { zh: '球队A' } };
    return table[name] || null;
  },
};

function baseRow(overrides = {}) {
  return {
    eventId: 'livetv-1',
    league: 'EPL',
    matchName: 'Team A v Team B',
    matchDateUTC: '2026-08-24T12:00:00Z',
    sportType: 'Football',
    status: 'live',
    channels: [],
    ...overrides,
  };
}

test('approved YouTube channel shape', () => {
  const row = baseRow({
    channels: [{ type: 'youtube', approved: true, channelName: 'Sky Sports', url: 'https://www.youtube.com/watch?v=abc' }],
  });
  const out = normalizeLiveRow(row, fakeDeps);
  assert.deepEqual(out.channels[0], { name: 'Sky Sports', sources: ['https://www.youtube.com/watch?v=abc'] });
});

test('pending YouTube channel shape has no source url', () => {
  const row = baseRow({
    channels: [{ type: 'youtube', approved: false, channelName: 'Random Channel', url: 'https://www.youtube.com/watch?v=xyz' }],
  });
  const out = normalizeLiveRow(row, fakeDeps);
  assert.deepEqual(out.channels[0], { name: 'Random Channel (pending review)', sources: [] });
  assert.ok(!('url' in out.channels[0]));
  assert.ok(!('channelUrl' in out.channels[0]));
});

test('other-type channel never leaks a url/channelUrl key', () => {
  const row = baseRow({ channels: [{ type: 'other' }] });
  const out = normalizeLiveRow(row, fakeDeps);
  assert.deepEqual(out.channels[0], { name: 'Other source (not shown)', sources: [] });
  assert.ok(!('url' in out.channels[0]));
  assert.ok(!('channelUrl' in out.channels[0]));
});

test('league canonicalization is delegated to injected dep', () => {
  const out = normalizeLiveRow(baseRow(), fakeDeps);
  assert.equal(out.league, 'Premier League');
  assert.equal(out.rawLeague, 'EPL');
  assert.equal(out.leagueZH, '英超');
});

test('status passes through unchanged', () => {
  const out = normalizeLiveRow(baseRow({ status: 'ended' }), fakeDeps);
  assert.equal(out.status, 'ended');
});

test('no away team splits into empty awayTeam and null awayTeamZH', () => {
  const out = normalizeLiveRow(baseRow({ matchName: 'Solo Event' }), fakeDeps);
  assert.equal(out.homeTeam, 'Solo Event');
  assert.equal(out.awayTeam, '');
  assert.equal(out.awayTeamZH, null);
});

test('homeTeam translation is looked up via injected dep', () => {
  const out = normalizeLiveRow(baseRow(), fakeDeps);
  assert.equal(out.homeTeam, 'Team A');
  assert.equal(out.homeTeamZH, '球队A');
});
