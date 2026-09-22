const test = require('node:test');
const assert = require('node:assert/strict');
const { parseM3U, findChannelSources, findChannelSourcesAcrossPlaylists } = require('../src/iptv');

test('parseM3U: parses name + url pairs, splitting #EXTINF on the LAST comma', () => {
  const content = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="a" tvg-name="A",ESPN',
    'https://example.com/espn.m3u8',
    '#EXTINF:-1,Sky Sports',
    '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (KHTML, like Gecko) Chrome/1',
    'https://example.com/sky.m3u8',
  ].join('\n');
  const parsed = parseM3U(content);
  assert.deepEqual(parsed, [
    { name: 'ESPN', url: 'https://example.com/espn.m3u8' },
    { name: 'Sky Sports', url: 'https://example.com/sky.m3u8' },
  ]);
});

test('parseM3U: an embedded comma in an attribute line (e.g. a User-Agent) does not corrupt the title', () => {
  // Regression case for the real bug fixed earlier: naive "split on first
  // comma" would have produced "like Gecko) Chrome/111.0.0.0..." as the name.
  const content = [
    '#EXTINF:-1 tvg-name="ABC",ABC',
    '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
    'https://example.com/abc.m3u8',
  ].join('\n');
  const parsed = parseM3U(content);
  assert.equal(parsed[0].name, 'ABC');
});

function ch(name, url) {
  return { name, url };
}

test('findChannelSources: exact match beats a shorter unrelated substring match', () => {
  const playlist = [ch('Sport', 'https://a/sport.m3u8'), ch('TNT Sports 1', 'https://a/tnt1.m3u8')];
  const sources = findChannelSources('TNT Sports 1', playlist);
  assert.deepEqual(sources, ['https://a/tnt1.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: channel matched only in the first (priority) playlist', () => {
  const doms9 = [ch('ESPN', 'https://doms9/espn.m3u8')];
  const iptvOrg = [ch('Sky Sports', 'https://iptvorg/sky.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('ESPN', [doms9, iptvOrg]);
  assert.deepEqual(sources, ['https://doms9/espn.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: channel matched only in the second playlist', () => {
  const doms9 = [ch('ESPN', 'https://doms9/espn.m3u8')];
  const iptvOrg = [ch('Sky Sports', 'https://iptvorg/sky.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('Sky Sports', [doms9, iptvOrg]);
  assert.deepEqual(sources, ['https://iptvorg/sky.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: channel matched in both playlists is stacked, priority playlist first', () => {
  const doms9 = [ch('ESPN', 'https://doms9/espn.m3u8')];
  const iptvOrg = [ch('ESPN', 'https://iptvorg/espn.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('ESPN', [doms9, iptvOrg]);
  assert.deepEqual(sources, ['https://doms9/espn.m3u8', 'https://iptvorg/espn.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: the same URL appearing in both playlists is only counted once', () => {
  const shared = 'https://mirror.example.com/espn.m3u8';
  const doms9 = [ch('ESPN', shared)];
  const iptvOrg = [ch('ESPN', shared), ch('ESPN', 'https://iptvorg/espn-alt.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('ESPN', [doms9, iptvOrg]);
  assert.deepEqual(sources, [shared, 'https://iptvorg/espn-alt.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: respects limit across the combined, stacked set', () => {
  const doms9 = [ch('ESPN', 'https://doms9/1.m3u8'), ch('ESPN', 'https://doms9/2.m3u8')];
  const iptvOrg = [ch('ESPN', 'https://iptvorg/3.m3u8'), ch('ESPN', 'https://iptvorg/4.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('ESPN', [doms9, iptvOrg], 3);
  assert.deepEqual(sources, ['https://doms9/1.m3u8', 'https://doms9/2.m3u8', 'https://iptvorg/3.m3u8']);
});

test('findChannelSourcesAcrossPlaylists: no match in any playlist returns an empty array', () => {
  const doms9 = [ch('ESPN', 'https://doms9/espn.m3u8')];
  const iptvOrg = [ch('Sky Sports', 'https://iptvorg/sky.m3u8')];
  const sources = findChannelSourcesAcrossPlaylists('HBO Max', [doms9, iptvOrg]);
  assert.deepEqual(sources, []);
});
