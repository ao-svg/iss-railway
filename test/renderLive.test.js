const test = require('node:test');
const assert = require('node:assert/strict');
const { renderLive } = require('../src/server');

test('renderLive shows both live and ended badges', () => {
  const state = {
    liveRows: [
      {
        eventId: 'a',
        matchName: 'Team A v Team B',
        league: 'Premier League',
        sportType: 'Football',
        matchDateUTC: '2026-08-24T12:00:00Z',
        status: 'live',
        firstSeenAt: '2026-08-24T12:00:00Z',
        channels: [],
      },
      {
        eventId: 'b',
        matchName: 'Team C v Team D',
        league: 'Premier League',
        sportType: 'Football',
        matchDateUTC: '2026-08-24T10:00:00Z',
        status: 'ended',
        endedAt: '2026-08-24T13:00:00Z',
        channels: [],
      },
    ],
  };
  const html = renderLive(state);
  assert.match(html, /dot-ok/);
  assert.match(html, />Live</);
  assert.match(html, /dot-dead/);
  assert.match(html, />Ended</);
});

test('renderLive with no rows shows empty-state message', () => {
  const html = renderLive({ liveRows: null });
  assert.match(html, /No live games fetched yet/);
});
