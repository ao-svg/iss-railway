const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeLiveFetch, ENDED_RETENTION_MS } = require('../src/liveTvStore');

function row(eventId, sportType = 'Football') {
  return { eventId, sportType, league: 'L', matchName: 'A v B', matchDateUTC: '2026-08-24T12:00:00Z', channels: [] };
}

test('1. first fetch, empty store -> both rows live, firstSeenAt === lastSeenAt', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  const { store, rows } = mergeLiveFetch([row('a'), row('b')], {}, { now, successfulSports: new Set(['Football']) });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'live');
    assert.equal(r.firstSeenAt, r.lastSeenAt);
    assert.equal(r.firstSeenAt, now.toISOString());
  }
  assert.equal(Object.keys(store).length, 2);
});

test('2. later fetch, same ids -> stays live, lastSeenAt advances, firstSeenAt unchanged', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const t2 = new Date('2026-08-24T12:30:00Z');
  const first = mergeLiveFetch([row('a')], {}, { now: t1, successfulSports: new Set(['Football']) });
  const second = mergeLiveFetch([row('a')], first.store, { now: t2, successfulSports: new Set(['Football']) });
  const r = second.rows[0];
  assert.equal(r.status, 'live');
  assert.equal(r.firstSeenAt, t1.toISOString());
  assert.equal(r.lastSeenAt, t2.toISOString());
});

test('3. id missing, sport in successfulSports -> flips to ended', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const t2 = new Date('2026-08-24T12:30:00Z');
  const first = mergeLiveFetch([row('a')], {}, { now: t1, successfulSports: new Set(['Football']) });
  const second = mergeLiveFetch([], first.store, { now: t2, successfulSports: new Set(['Football']) });
  const r = second.rows.find((x) => x.eventId === 'a');
  assert.equal(r.status, 'ended');
  assert.equal(r.endedAt, t2.toISOString());
});

test('4. id missing, sport NOT in successfulSports -> stays live, untouched (critical fix)', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const t2 = new Date('2026-08-24T12:30:00Z');
  const first = mergeLiveFetch([row('a')], {}, { now: t1, successfulSports: new Set(['Football']) });
  const second = mergeLiveFetch([], first.store, { now: t2, successfulSports: new Set() }); // Football fetch failed this round
  const r = second.rows.find((x) => x.eventId === 'a');
  assert.equal(r.status, 'live');
  assert.equal(r.lastSeenAt, t1.toISOString()); // untouched, not advanced
  assert.equal(r.endedAt, null);
});

test('5. now beyond ENDED_RETENTION_MS past endedAt -> pruned', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const t2 = new Date(t1.getTime() + 1000); // ends shortly after
  const t3 = new Date(t2.getTime() + ENDED_RETENTION_MS + 1000); // past retention window
  const first = mergeLiveFetch([row('a')], {}, { now: t1, successfulSports: new Set(['Football']) });
  const ended = mergeLiveFetch([], first.store, { now: t2, successfulSports: new Set(['Football']) });
  const pruned = mergeLiveFetch([], ended.store, { now: t3, successfulSports: new Set(['Football']) });
  assert.equal(pruned.rows.find((x) => x.eventId === 'a'), undefined);
  assert.equal(pruned.store['a'], undefined);
});

test('6. ended event reappears -> flips back to live, endedAt reset, firstSeenAt preserved', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const t2 = new Date('2026-08-24T12:30:00Z');
  const t3 = new Date('2026-08-24T13:00:00Z');
  const first = mergeLiveFetch([row('a')], {}, { now: t1, successfulSports: new Set(['Football']) });
  const ended = mergeLiveFetch([], first.store, { now: t2, successfulSports: new Set(['Football']) });
  const reappeared = mergeLiveFetch([row('a')], ended.store, { now: t3, successfulSports: new Set(['Football']) });
  const r = reappeared.rows.find((x) => x.eventId === 'a');
  assert.equal(r.status, 'live');
  assert.equal(r.endedAt, null);
  assert.equal(r.firstSeenAt, t1.toISOString());
  assert.equal(r.lastSeenAt, t3.toISOString());
});

test('7. mixed batch: some ended within retention, some outside -> only outside dropped', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const first = mergeLiveFetch([row('a'), row('b')], {}, { now: t1, successfulSports: new Set(['Football']) });

  const tEndA = new Date(t1.getTime() + 1000);
  const endedA = mergeLiveFetch([row('b')], first.store, { now: tEndA, successfulSports: new Set(['Football']) });
  // a ends at tEndA; b still live

  const tEndB = new Date(tEndA.getTime() + ENDED_RETENTION_MS - 1000); // b ends just before a would be pruned
  const endedB = mergeLiveFetch([], endedA.store, { now: tEndB, successfulSports: new Set(['Football']) });

  const tCheck = new Date(tEndA.getTime() + ENDED_RETENTION_MS + 1000); // a is now outside its window, b is not
  const final = mergeLiveFetch([], endedB.store, { now: tCheck, successfulSports: new Set(['Football']) });

  assert.equal(final.rows.find((x) => x.eventId === 'a'), undefined);
  const b = final.rows.find((x) => x.eventId === 'b');
  assert.ok(b);
  assert.equal(b.status, 'ended');
});

test('channels are cloned, never alias the previous store objects', () => {
  const t1 = new Date('2026-08-24T12:00:00Z');
  const r = { ...row('a'), channels: [{ type: 'youtube', approved: false }] };
  const first = mergeLiveFetch([r], {}, { now: t1, successfulSports: new Set(['Football']) });
  first.store['a'].channels[0].approved = true;
  assert.equal(r.channels[0].approved, false);
});
