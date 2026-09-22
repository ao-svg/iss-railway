const test = require('node:test');
const assert = require('node:assert/strict');
const { channelKey, applyManualChannels } = require('../src/manualChannels');

function row(channels) {
  return {
    eventId: 'e1',
    source: 'wheresthematch',
    league: 'World Snooker',
    homeTeam: 'Snooker Scottish Open',
    awayTeam: '',
    matchDateUTC: '2026-09-22T10:00:00+01:00',
    sportType: 'Snooker',
    channels,
  };
}

const store = { 'wst play': { name: 'WST Play', urls: ['https://manual.example/wst.m3u8'] } };

test('channelKey: lowercases, trims, collapses whitespace', () => {
  assert.equal(channelKey('  WST   Play '), 'wst play');
  assert.equal(channelKey(''), '');
  assert.equal(channelKey(undefined), '');
});

test('applyManualChannels: a channel with no playlist match gets the manual URL', () => {
  const [merged] = applyManualChannels([row([{ name: 'WST Play', sources: [] }])], store);
  assert.deepEqual(merged.channels[0].sources, ['https://manual.example/wst.m3u8']);
  assert.deepEqual(merged.channels[0].manualUrls, ['https://manual.example/wst.m3u8']);
});

test('applyManualChannels: name match is case/whitespace-insensitive and applies to every game listing it', () => {
  const rows = [row([{ name: 'wst  play', sources: [] }]), row([{ name: 'WST PLAY', sources: [] }])];
  const merged = applyManualChannels(rows, store);
  assert.equal(merged[0].channels[0].sources.length, 1);
  assert.equal(merged[1].channels[0].sources.length, 1);
});

test('applyManualChannels: manual URL goes first, existing playlist matches are kept after it', () => {
  const [merged] = applyManualChannels([row([{ name: 'WST Play', sources: ['https://iptv.example/a.m3u8'] }])], store);
  assert.deepEqual(merged.channels[0].sources, ['https://manual.example/wst.m3u8', 'https://iptv.example/a.m3u8']);
});

test('applyManualChannels: channels without an entry are untouched (no manualUrls field added)', () => {
  const [merged] = applyManualChannels([row([{ name: 'HBO Max', sources: [] }])], store);
  assert.deepEqual(merged.channels[0], { name: 'HBO Max', sources: [] });
});

test('applyManualChannels: idempotent — applying twice yields the same sources, no duplicates', () => {
  const once = applyManualChannels([row([{ name: 'WST Play', sources: ['https://iptv.example/a.m3u8'] }])], store);
  const twice = applyManualChannels(once, store);
  assert.deepEqual(twice[0].channels[0].sources, ['https://manual.example/wst.m3u8', 'https://iptv.example/a.m3u8']);
});

test('applyManualChannels: removing the entry strips the manual URL and leaves playlist matches', () => {
  const withManual = applyManualChannels([row([{ name: 'WST Play', sources: ['https://iptv.example/a.m3u8'] }])], store);
  const [afterRemoval] = applyManualChannels(withManual, {});
  assert.deepEqual(afterRemoval.channels[0].sources, ['https://iptv.example/a.m3u8']);
  assert.equal(afterRemoval.channels[0].manualUrls, undefined);
});

test('regression: splicing the store urls array in place (what removeManualChannel does) must not leak into already-applied rows', () => {
  const liveStore = { 'wst play': { name: 'WST Play', urls: ['https://manual.example/wst.m3u8'] } };
  const applied = applyManualChannels([row([{ name: 'WST Play', sources: ['https://iptv.example/a.m3u8'] }])], liveStore);
  liveStore['wst play'].urls.splice(0, 1);
  delete liveStore['wst play'];
  assert.deepEqual(applied[0].channels[0].manualUrls, ['https://manual.example/wst.m3u8']);
  const [after] = applyManualChannels(applied, liveStore);
  assert.deepEqual(after.channels[0].sources, ['https://iptv.example/a.m3u8']);
});

test('applyManualChannels: never mutates the input rows', () => {
  const input = row([{ name: 'WST Play', sources: [] }]);
  applyManualChannels([input], store);
  assert.deepEqual(input.channels, [{ name: 'WST Play', sources: [] }]);
});
