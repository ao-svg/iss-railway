// Manual channels: playlist files (the M3U text pasted or uploaded) and rules (sources for every game
// that fits a league / sport / word). Its own data dir: the store files are written for real.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-rules-'));
process.env.DATA_DIR = DATA;

const test = require('node:test');
const assert = require('node:assert/strict');
const iptv = require('../src/iptv');
const mc = require('../src/manualChannels');

const SAMPLE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-chno="2" tvg-id="ABC.News.Live.us2" tvg-name="ABC News Live" tvg-logo="https://logos.example/abc.png" group-title="TV",ABC News Live',
  'https://domain.com/video.m3u8',
  '#EXTINF:-1 tvg-id="NFLNetwork.us" tvg-name="NFL Network" group-title="Sports, US",NFL Network (HD)',
  'https://domain.com/nfl.m3u8',
  '#EXTINF:-1 group-title="Sports",NFL RedZone',
  'https://domain.com/redzone.m3u8',
  '#EXTINF:-1 tvg-name="Fallback Name",',
  'https://domain.com/fallback.m3u8',
  '#EXTGRP:Movies',
  '#EXTINF:-1,Some Movie, Part 2',
  'https://domain.com/movie.m3u8',
  '#EXTINF:-1,Not Http',
  'rtmp://domain.com/live',
  '#EXTINF:-1,No Url',
].join('\r\n');

const reset = () => {
  for (const e of Object.values(mc.getAll())) for (let i = e.urls.length - 1; i >= 0; i--) mc.removeManualChannel(e.name, i);
  for (const p of [...mc.getPlaylists()]) mc.removePlaylist(p.url);
  for (const r of [...mc.getRules()]) mc.removeRule(r.id);
};
const game = (over = {}) => ({ eventId: 'g1', league: 'NFL', rawLeague: 'NFL', sportType: 'American Football', homeTeam: 'Green Bay Packers', awayTeam: 'Chicago Bears', channels: [{ name: 'CBS', sources: ['https://auto.example/cbs.m3u8'] }, { name: 'NFL+', sources: [] }], ...over });

test('parseM3UDetailed: the usual IPTV list format (attributes, group, logo, CRLF, titles with commas)', () => {
  const list = iptv.parseM3UDetailed(SAMPLE);
  assert.deepEqual(list[0], { name: 'ABC News Live', url: 'https://domain.com/video.m3u8', group: 'TV', id: 'ABC.News.Live.us2', logo: 'https://logos.example/abc.png' });
  assert.deepEqual(list[1], { name: 'NFL Network (HD)', url: 'https://domain.com/nfl.m3u8', group: 'Sports, US', tvgName: 'NFL Network', id: 'NFLNetwork.us' }, 'a comma inside a quoted attribute does not cut the title');
  assert.deepEqual(list[2], { name: 'NFL RedZone', url: 'https://domain.com/redzone.m3u8', group: 'Sports' });
  assert.deepEqual(list[3], { name: 'Fallback Name', url: 'https://domain.com/fallback.m3u8' }, 'an empty title falls back to tvg-name');
  assert.deepEqual(list[4], { name: 'Some Movie, Part 2', url: 'https://domain.com/movie.m3u8', group: 'Movies' }, '#EXTGRP names the group; a comma in the title stays');
  assert.equal(list.length, 5, 'rtmp:// and an entry without a link are left out');
  assert.deepEqual(iptv.parseM3UDetailed(''), []);
  assert.deepEqual(iptv.parseM3UDetailed('#EXTINF:-1 no comma at all\nhttps://x.example/a.m3u8'), []);
});

test('addPlaylistFile: stored on disk, cached for matching, listed, refused when empty or not a playlist', () => {
  reset();
  assert.ok(mc.addPlaylistFile('x', '').error);
  assert.ok(mc.addPlaylistFile('x', '<html>nope</html>').error.includes('no channels'));
  assert.ok(mc.addPlaylistFile('x', '#EXTM3U\n#EXTINF:-1,A\nhttps://x.example/a.m3u8\n' + ' '.repeat(5 * 1024 * 1024)).error.includes('5 MB'));
  const r = mc.addPlaylistFile('My list', SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  assert.match(r.url, /^file:[a-z0-9]{10}$/);
  assert.deepEqual(mc.getPlaylists().map((p) => [p.url, p.file, p.label]), [[r.url, true, 'My list']]);
  assert.equal(iptv.getCachedPlaylist(r.url).length, 5);
  assert.ok(fs.existsSync(path.join(DATA, 'manual-playlist-files', `${r.url.slice(5)}.m3u`)));
  assert.equal(mc.removePlaylist(r.url), true);
  assert.equal(fs.existsSync(path.join(DATA, 'manual-playlist-files', `${r.url.slice(5)}.m3u`)), false, 'removing the playlist deletes the file');
});

test('parseRule: what a rule needs, and what is refused', () => {
  reset();
  const pl = mc.addPlaylistFile('My list', SAMPLE);
  const ok = mc.parseRule({ channel: 'NFL Network', when: { league: 'NFL' }, sources: ['https://x.example/a.m3u8', { url: 'https://p.example/e', type: 'embed' }, '<iframe src="https://p.example/f"></iframe>'], playlist: { ref: 'My list', filter: ' NFL , football ', limit: 99 } });
  assert.deepEqual(ok.rule.sources.map((s) => s.type), ['stream', 'embed', 'embed']);
  assert.deepEqual(ok.rule.playlist, { ref: pl.url, filter: 'NFL , football', limit: 20 }, 'a playlist by its label; the limit is capped');
  assert.equal(mc.parseRule({ channel: 'X', when: { sport: 'Football' }, playlist: { ref: pl.url } }).rule.playlist.limit, 5, 'default limit');
  const refusals = [
    [{ when: { league: 'NFL' }, sources: ['https://x.example/a'] }, /channel name/],
    [{ channel: 'X', sources: ['https://x.example/a'] }, /needs a condition/],
    [{ channel: 'X', when: { league: 'NFL' } }, /needs a link/],
    [{ channel: 'X', when: { league: 'NFL' }, sources: ['javascript:alert(1)'] }, /only http/],
    [{ channel: 'X', when: { league: 'NFL' }, sources: [{ url: 'http://x.example/e', type: 'embed' }] }, /https/],
    [{ channel: 'X', when: { league: 'NFL' }, playlist: { ref: 'nope' } }, /has not been added/],
    [{ channel: 'X', when: { league: 'a'.repeat(81) }, sources: ['https://x.example/a'] }, /too long/],
    [null, /object/],
  ];
  for (const [input, re] of refusals) assert.match(mc.parseRule(input).error, re);
  reset();
});

test('ruleMatchesRow: every condition given must fit, ignoring case and spacing', () => {
  const row = game();
  const m = (when) => mc.ruleMatchesRow({ when }, row);
  assert.equal(m({ league: 'nfl' }), true);
  assert.equal(m({ league: 'NFL', sport: ' american  football ' }), true);
  assert.equal(m({ league: 'NFL', sport: 'Football' }), false, 'a sport must be the same, not just contain');
  assert.equal(m({ text: 'packers' }), true);
  assert.equal(m({ text: 'chiefs' }), false);
  assert.equal(m({ league: 'NFL', text: 'chiefs' }), false, 'all conditions');
  assert.equal(m({ league: 'Premier' }), false);
  assert.equal(m({}), false, 'no condition: fits nothing');
});

test('applyManualChannels with rules: the rule channel is added to fitting games only, and rebuilt every time', () => {
  reset();
  const rule = mc.addRule({ channel: 'NFL Network', when: { league: 'NFL' }, sources: ['https://x.example/nfl.m3u8', { url: 'https://p.example/e', type: 'embed' }] }).rule;
  const rows = [game(), game({ eventId: 'g2', league: 'Premier League', rawLeague: 'EPL', sportType: 'Football' })];
  const once = mc.applyManualChannels(rows, {}, { rules: [rule] });
  assert.deepEqual(once[0].channels.map((c) => c.name), ['CBS', 'NFL+', 'NFL Network']);
  assert.deepEqual(once[0].channels[2], { name: 'NFL Network', sources: ['https://x.example/nfl.m3u8', 'https://p.example/e'], manualUrls: ['https://x.example/nfl.m3u8', 'https://p.example/e'], embedUrls: ['https://p.example/e'], fromRule: true });
  assert.deepEqual(once[1].channels.map((c) => c.name), ['CBS', 'NFL+'], 'a game that does not fit is left alone');
  const twice = mc.applyManualChannels(once, {}, { rules: [rule] });
  assert.deepEqual(twice, once, 'idempotent');
  const removed = mc.applyManualChannels(twice, {}, { rules: [] });
  assert.deepEqual(removed.map((r) => r.channels.map((c) => c.name)), [['CBS', 'NFL+'], ['CBS', 'NFL+']], 'the rule is gone: so is its channel');
  assert.deepEqual(rows[0].channels.length, 2, 'the input is never changed');
  reset();
});

test('applyManualChannels with rules: a game that already has that channel gets the links in it; links it already has are not repeated', () => {
  const rule = { channel: 'cbs', when: { sport: 'American Football' }, sources: [{ url: 'https://auto.example/cbs.m3u8', type: 'stream' }, { url: 'https://x.example/new.m3u8', type: 'stream' }] };
  const [r] = mc.applyManualChannels([game()], {}, { rules: [rule] });
  assert.deepEqual(r.channels.map((c) => c.name), ['CBS', 'NFL+'], 'no second CBS');
  assert.deepEqual(r.channels[0].sources, ['https://x.example/new.m3u8', 'https://auto.example/cbs.m3u8']);
  assert.deepEqual(r.channels[0].manualUrls, ['https://x.example/new.m3u8']);
  const [again] = mc.applyManualChannels([r], {}, { rules: [rule] });
  assert.deepEqual(again, r);
  const [off] = mc.applyManualChannels([again], {}, { rules: [] });
  assert.deepEqual(off.channels[0], { name: 'CBS', sources: ['https://auto.example/cbs.m3u8'] });
});

test('applyManualChannels with rules: a playlist\'s entries, filtered by name or group, capped per game', () => {
  const list = iptv.parseM3UDetailed(SAMPLE);
  const byRef = new Map([['file:abc1234567', list]]);
  const base = { channel: 'Sports Feeds', when: { league: 'NFL' }, sources: [] };
  const names = (playlist) => {
    const [r] = mc.applyManualChannels([game()], {}, { rules: [{ ...base, playlist }], playlistsByRef: byRef });
    const c = r.channels.find((x) => x.name === 'Sports Feeds');
    return c ? c.sources.map((u) => list.find((e) => e.url === u).name) : [];
  };
  assert.deepEqual(names({ ref: 'file:abc1234567', filter: 'nfl', limit: 5 }), ['NFL Network (HD)', 'NFL RedZone'], 'the name');
  assert.deepEqual(names({ ref: 'file:abc1234567', filter: 'sports', limit: 5 }), ['NFL Network (HD)', 'NFL RedZone'], 'the group');
  assert.deepEqual(names({ ref: 'file:abc1234567', filter: 'abc news, redzone', limit: 5 }), ['ABC News Live', 'NFL RedZone'], 'any of several words');
  assert.deepEqual(names({ ref: 'file:abc1234567', filter: 'nfl', limit: 1 }), ['NFL Network (HD)'], 'the limit');
  assert.deepEqual(names({ ref: 'file:abc1234567', filter: 'tvg-nothing-like-it', limit: 5 }), [], 'nothing passes: no channel is added');
  assert.deepEqual(names({ ref: 'file:abc1234567', limit: 2 }), ['ABC News Live', 'NFL Network (HD)'], 'no filter: the first entries');
  assert.deepEqual(names({ ref: 'file:missing0000', limit: 5 }), [], 'a playlist that is not cached');
});

test('export and import keep playlist files and rules together (the file ids too)', () => {
  reset();
  const pl = mc.addPlaylistFile('My list', SAMPLE);
  assert.equal(mc.addRule({ channel: 'NFL Network', when: { league: 'NFL' }, sources: ['https://x.example/a.m3u8'], playlist: { ref: pl.url, filter: 'nfl' } }).ok, true);
  mc.addManualChannel('Fed TV', 'https://x.example/f.m3u8');
  const out = JSON.parse(JSON.stringify(mc.exportManualChannels()));
  assert.equal(out.playlists[0].id, pl.url);
  assert.equal(out.playlists[0].content, SAMPLE);
  assert.equal(out.rules[0].playlist.ref, pl.url);
  reset();
  const back = mc.importManualChannels(out);
  assert.equal(back.ok, true);
  assert.deepEqual([back.added, back.playlistsAdded, back.rulesAdded], [1, 1, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(mc.exportManualChannels())), out, 'round trip');
  // replace: the old file goes, and a replace with nothing usable keeps everything
  const bad = mc.importManualChannels({ rules: [{ channel: 'X' }] }, { replace: true });
  assert.ok(bad.error && bad.error.includes('kept'));
  assert.equal(mc.getRules().length, 1);
  assert.equal(mc.importManualChannels({ playlists: [{ label: 'Other', content: '#EXTINF:-1,B\nhttps://x.example/b.m3u8' }], rules: [] }, { replace: true }).ok, true);
  assert.deepEqual(mc.getPlaylists().map((p) => p.label), ['Other']);
  assert.equal(mc.getRules().length, 0);
  assert.equal(fs.readdirSync(path.join(DATA, 'manual-playlist-files')).length, 1, 'the replaced playlist file was removed from disk');
  reset();
});

test('removing a playlist: a rule keeps its own links, loses the playlist part; a rule that had only the playlist goes', () => {
  reset();
  const pl = mc.addPlaylistFile('My list', SAMPLE);
  mc.addRule({ channel: 'Both', when: { league: 'NFL' }, sources: ['https://x.example/a.m3u8'], playlist: { ref: pl.url } });
  mc.addRule({ channel: 'Only list', when: { league: 'NFL' }, playlist: { ref: pl.url } });
  mc.removePlaylist(pl.url);
  assert.deepEqual(mc.getRules().map((r) => [r.channel, !!r.playlist]), [['Both', false]]);
  reset();
});

test('everything survives a restart: rules and playlist files are read from disk again', () => {
  reset();
  const pl = mc.addPlaylistFile('My list', SAMPLE);
  mc.addRule({ channel: 'NFL Network', when: { league: 'NFL' }, playlist: { ref: pl.url } });
  for (const key of Object.keys(require.cache)) if (/src[\\/](manualChannels|iptv)\.js$/.test(key)) delete require.cache[key];
  const iptv2 = require('../src/iptv');
  const mc2 = require('../src/manualChannels');
  assert.equal(mc2.getRules().length, 1);
  assert.equal(mc2.getPlaylists()[0].url, pl.url);
  assert.equal(iptv2.getCachedPlaylist(pl.url).length, 5, 'the file was parsed and cached at start');
  for (const r of [...mc2.getRules()]) mc2.removeRule(r.id);
  for (const p of [...mc2.getPlaylists()]) mc2.removePlaylist(p.url);
});

test('the page: file upload, rules, and their routes (admin only)', async (t) => {
  const auth = require('../src/auth');
  const { createServer } = require('../src/server');
  const m = require('../src/manualChannels');
  auth.upsert({ username: 'mr-admin', password: 'mr-admin-pass', role: 'admin' });
  auth.upsert({ username: 'mr-viewer', password: 'mr-viewer-pass', role: 'viewer' });
  const app = createServer({
    getState: () => ({ lastRows: [game()] }),
    runOnce: async () => {}, rescheduleCron: () => {}, runSourceCheck: async () => {}, getSourceStatus: () => ({}),
    runTranslate: async () => {}, getAllTranslations: () => ({}), setManualTranslation: () => {}, getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {}, runLiveTvFetch: async () => {}, getAllYouTubeChannels: () => [], setChannelStatus: () => {},
    getManualChannelsAll: m.getAll, addManualChannel: m.addManualChannel, removeManualChannel: m.removeManualChannel,
    getPlaylists: m.getPlaylists, addPlaylistFile: async (l, c) => m.addPlaylistFile(l, c), removePlaylist: m.removePlaylist,
    getRules: m.getRules, addRule: (i) => m.addRule(i), removeRule: (id) => m.removeRule(id),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => { server.close(); });
  const base = `http://localhost:${server.address().port}`;
  const admin = 'Basic ' + Buffer.from('mr-admin:mr-admin-pass').toString('base64');
  const viewer = 'Basic ' + Buffer.from('mr-viewer:mr-viewer-pass').toString('base64');
  const form = (p, body, a = admin) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { Authorization: a, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json = (p, body, a = admin) => fetch(base + p, { method: 'POST', headers: { Authorization: a, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  reset();

  assert.equal((await fetch(`${base}/api/manual-playlist/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: SAMPLE }) })).status, 401, 'no login');
  assert.equal((await json('/api/manual-playlist/file', { content: SAMPLE }, viewer)).status, 401, 'a viewer');
  assert.equal((await form('/api/manual-rule', { channel: 'X', league: 'NFL', url: 'https://x.example/a.m3u8' }, viewer)).status, 401);

  // a file: small, big (about 2 MB), and refused ones
  const ok = await json('/api/manual-playlist/file', { label: 'Mine', content: SAMPLE });
  assert.equal(ok.status, 200);
  const added = await ok.json();
  assert.equal(added.count, 5);
  const big = '#EXTM3U\n' + Array.from({ length: 20000 }, (_, i) => `#EXTINF:-1 group-title="G",Channel ${i}\nhttps://s.example/${i}.m3u8`).join('\n');
  assert.ok(big.length > 1024 * 1024);
  const bigRes = await json('/api/manual-playlist/file', { label: 'Big', content: big });
  assert.equal(bigRes.status, 200);
  assert.equal((await bigRes.json()).count, 20000);
  assert.equal((await json('/api/manual-playlist/file', { content: 'nothing here' })).status, 400);
  m.removePlaylist(m.getPlaylists().find((p) => p.label === 'Big').url);

  // rules
  const rule = await form('/api/manual-rule', { channel: 'NFL Network', league: 'NFL', sport: '', text: '', url: '', type: '', playlist: added.url, filter: 'nfl', limit: '3' });
  assert.equal(rule.status, 200);
  assert.match(await rule.text(), /Rule added: NFL Network/);
  const bad = await form('/api/manual-rule', { channel: 'X', league: '', url: 'https://x.example/a.m3u8' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Rule not added: the rule needs a condition/);
  const embed = await form('/api/manual-rule', { channel: 'Fed TV', text: 'packers', url: '<iframe src="https://p.example/e"></iframe>', type: '' });
  assert.equal(embed.status, 200);
  assert.deepEqual(m.getRules().map((r) => r.channel), ['NFL Network', 'Fed TV']);
  assert.equal(m.getRules()[1].sources[0].type, 'embed');

  // the page: the example format, the upload form with its script, the rules and playlists listed, names escaped
  m.addRule({ channel: '<b>Bold</b>', when: { league: 'NFL' }, sources: ['https://x.example/b.m3u8'] });
  const page = await (await fetch(`${base}/manual-channels`, { headers: { Authorization: admin } })).text();
  assert.match(page, /Rules — sources for every game that fits/);
  assert.match(page, /id="playlist-file-form"/);
  assert.match(page, /tvg-chno="2" tvg-id="ABC.News.Live.us2"/);
  assert.match(page, /FileReader/);
  assert.match(page, /league contains “NFL”/);
  assert.match(page, /only entries with “nfl”/);
  assert.match(page, /<option value="American Football">/, 'the sports the games have, for the sport field');
  assert.ok(!page.includes('<b>Bold</b>'));
  assert.match(page, /name="id" value="[0-9a-f]{8}"/);

  const id = m.getRules()[0].id;
  assert.equal((await form('/api/manual-rule/remove', { id })).status, 302);
  assert.equal(m.getRules().some((r) => r.id === id), false);
  reset();
});
