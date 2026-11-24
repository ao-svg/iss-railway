// Manual channels: embeds (iframe sources), JSON import/export, remote playlists.
// Its own data dir: the store files are written for real.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-channels-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../src/manualChannels');
const { enrichRowsWithSourceStatus } = require('../src/sourceChecks');

const row = (channels) => ({ eventId: 'e1', league: 'L', homeTeam: 'A', awayTeam: 'B', sportType: 'Football', channels });
// (a replace with nothing in it is refused on purpose, so the list is emptied by hand)
const reset = () => {
  for (const e of Object.values(mc.getAll())) for (let i = e.urls.length - 1; i >= 0; i--) mc.removeManualChannel(e.name, i);
  for (const p of [...mc.getPlaylists()]) mc.removePlaylist(p.url);
};

test('parseSource: a link, a pasted iframe tag (an embed), and what is refused', () => {
  assert.deepEqual(mc.parseSource('https://x.example/a.m3u8'), { url: 'https://x.example/a.m3u8', embed: false });
  assert.deepEqual(mc.parseSource('https://x.example/p', 'embed'), { url: 'https://x.example/p', embed: true });
  assert.deepEqual(mc.parseSource('<iframe width="560" src="https://player.example/e/1?x=1&y=2" allowfullscreen></iframe>'), { url: 'https://player.example/e/1?x=1&y=2', embed: true });
  assert.deepEqual(mc.parseSource("<IFRAME SRC='//player.example/e/2'></IFRAME>"), { url: 'https://player.example/e/2', embed: true });
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.example/a', 'not a url', '', '   ']) {
    assert.ok(mc.parseSource(bad).error, `refused: ${bad}`);
  }
  assert.ok(mc.parseSource('http://x.example/p', 'embed').error, 'an embed must be https');
  assert.ok(!mc.parseSource('http://x.example/a.m3u8').error, 'a plain http stream is still fine');
  assert.ok(mc.parseSource('<iframe src="javascript:alert(1)"></iframe>').error, 'a javascript: src in a pasted tag');
  assert.ok(mc.parseSource('https://x.example/' + 'a'.repeat(2100)).error, 'too long');
});

test('addManualChannel: embeds are listed in the entry, the type can change, remove clears it', () => {
  reset();
  assert.equal(mc.addManualChannel('Fed TV', 'https://x.example/a.m3u8').ok, true);
  assert.equal(mc.addManualChannel('Fed TV', 'https://p.example/e/1', { type: 'embed' }).ok, true);
  assert.equal(mc.addManualChannel('fed  tv', '<iframe src="https://p.example/e/2"></iframe>').ok, true, 'same channel, another spelling');
  let e = mc.getAll()['fed tv'];
  assert.deepEqual(e.urls, ['https://x.example/a.m3u8', 'https://p.example/e/1', 'https://p.example/e/2']);
  assert.deepEqual(e.embed, ['https://p.example/e/1', 'https://p.example/e/2']);
  assert.equal(mc.isEmbedUrl('https://p.example/e/1'), true);
  assert.equal(mc.isEmbedUrl('https://x.example/a.m3u8'), false);
  mc.addManualChannel('Fed TV', 'https://p.example/e/1', { type: 'stream' });
  assert.deepEqual(mc.getAll()['fed tv'].embed, ['https://p.example/e/2'], 'added again as a stream: no longer an embed');
  mc.removeManualChannel('Fed TV', 2);
  assert.equal(mc.getAll()['fed tv'].embed, undefined);
  assert.ok(mc.addManualChannel('', 'https://x.example/a').error);
  assert.ok(mc.addManualChannel('X', 'javascript:alert(1)').error);
  assert.equal(mc.getAll()['x'], undefined, 'nothing stored for a refused link');
});

test('applyManualChannels: embedUrls only for embeds, idempotent, never added when there are none', () => {
  const store = { 'fed tv': { name: 'Fed TV', urls: ['https://x.example/a.m3u8', 'https://p.example/e/1'], embed: ['https://p.example/e/1'] }, plain: { name: 'Plain', urls: ['https://x.example/b.m3u8'] } };
  const [r] = mc.applyManualChannels([row([{ name: 'Fed TV', sources: [] }, { name: 'Plain', sources: [] }])], store);
  assert.deepEqual(r.channels[0].embedUrls, ['https://p.example/e/1']);
  assert.equal(r.channels[1].embedUrls, undefined);
  const [again] = mc.applyManualChannels([r], store);
  assert.deepEqual(again.channels[0].sources, ['https://x.example/a.m3u8', 'https://p.example/e/1']);
  const [gone] = mc.applyManualChannels([again], {});
  assert.deepEqual(gone.channels[0], { name: 'Fed TV', sources: [] }, 'removed: no manualUrls, no embedUrls left behind');
});

test('applyManualChannels: remote playlist entries matching the channel name come after the hand-entered links, before the rest', () => {
  const playlist = [{ name: 'FIFA Plus', url: 'https://pl.example/fifa.m3u8' }, { name: 'Other Channel', url: 'https://pl.example/o.m3u8' }];
  const store = { 'fifa plus': { name: 'FIFA Plus', urls: ['https://x.example/own.m3u8'] } };
  const [r] = mc.applyManualChannels([row([{ name: 'FIFA Plus', sources: ['https://iptv.example/a.m3u8'] }, { name: 'Nothing Like It', sources: [] }])], store, { playlists: [playlist] });
  assert.deepEqual(r.channels[0].sources, ['https://x.example/own.m3u8', 'https://pl.example/fifa.m3u8', 'https://iptv.example/a.m3u8']);
  assert.deepEqual(r.channels[0].manualUrls, ['https://x.example/own.m3u8', 'https://pl.example/fifa.m3u8']);
  assert.deepEqual(r.channels[1].sources, []);
  const [after] = mc.applyManualChannels([r], store, { playlists: [[]] });
  assert.deepEqual(after.channels[0].sources, ['https://x.example/own.m3u8', 'https://iptv.example/a.m3u8'], 'the playlist lost the entry (or was removed): it goes away');
});

test('importManualChannels: the three JSON shapes, types, skipped entries with their reason', () => {
  reset();
  let r = mc.importManualChannels({ channels: [{ name: 'A TV', sources: ['https://x.example/a.m3u8', { url: 'https://p.example/e', type: 'embed' }, { url: 'https://q.example/e', embed: true }, 'javascript:alert(1)'] }] });
  assert.equal(r.ok, true);
  assert.equal(r.added, 3);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['only http(s) links are accepted']);
  assert.deepEqual(mc.getAll()['a tv'].embed, ['https://p.example/e', 'https://q.example/e']);
  r = mc.importManualChannels([{ name: 'B TV', urls: ['https://x.example/b.m3u8'] }]);
  assert.equal(r.added, 1);
  r = mc.importManualChannels({ 'C TV': ['https://x.example/c.m3u8', '<iframe src="https://p.example/c"></iframe>'] });
  assert.equal(r.added, 2);
  assert.deepEqual(mc.getAll()['c tv'].embed, ['https://p.example/c']);
  assert.ok(mc.importManualChannels('{ nope').error.startsWith('not valid JSON'));
  assert.ok(mc.importManualChannels(5).error);
  assert.equal(mc.importManualChannels({ channels: [{ name: '', sources: ['https://x.example/a'] }, { name: 'D', sources: 'https://x.example/a' }] }).skipped.length, 2);
});

test('importManualChannels: replace swaps the list, but never empties it when nothing in the JSON is usable', () => {
  reset();
  mc.importManualChannels({ 'Keep TV': ['https://x.example/k.m3u8'] });
  let r = mc.importManualChannels({ 'New TV': ['https://x.example/n.m3u8'] }, { replace: true });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(mc.getAll()), ['new tv']);
  r = mc.importManualChannels({ 'Bad TV': ['javascript:alert(1)'] }, { replace: true });
  assert.ok(r.error && r.error.includes('kept'));
  assert.deepEqual(Object.keys(mc.getAll()), ['new tv']);
});

test('export and import round-trip, playlists included', () => {
  reset();
  mc.importManualChannels({ playlists: [{ url: 'https://pl.example/list.m3u8', label: 'My list' }], channels: [{ name: 'Z TV', sources: ['https://x.example/z.m3u8', { url: 'https://p.example/z', type: 'embed' }] }] });
  const out = mc.exportManualChannels();
  assert.deepEqual(out.playlists, [{ url: 'https://pl.example/list.m3u8', label: 'My list' }]);
  assert.deepEqual(out.channels, [{ name: 'Z TV', sources: [{ url: 'https://x.example/z.m3u8', type: 'stream' }, { url: 'https://p.example/z', type: 'embed' }] }]);
  const snapshot = JSON.parse(JSON.stringify(out));
  reset();
  assert.equal(mc.importManualChannels(snapshot).ok, true);
  assert.deepEqual(mc.exportManualChannels(), snapshot);
});

test('playlists: private addresses and odd links are refused, duplicates ignored, the number is capped', () => {
  reset();
  for (const bad of ['http://localhost/a.m3u8', 'http://127.0.0.1/a.m3u8', 'http://10.1.2.3/a.m3u8', 'http://192.168.0.5/a', 'http://169.254.169.254/latest', 'http://172.16.0.1/a', 'http://[::1]/a', 'http://svc.railway.internal/a', 'file:///etc/passwd', 'https://user:pw@x.example/a.m3u8', 'javascript:alert(1)', '']) {
    assert.ok(mc.addPlaylist(bad).error, `refused: ${bad}`);
  }
  assert.equal(mc.addPlaylist('https://pl.example/a.m3u8', 'A').added, true);
  assert.equal(mc.addPlaylist('https://pl.example/a.m3u8', 'A').added, false);
  assert.equal(mc.getPlaylists().length, 1);
  for (let i = 0; i < 25; i++) mc.addPlaylist(`https://pl.example/${i}.m3u8`);
  assert.equal(mc.getPlaylists().length, 20);
  assert.equal(mc.removePlaylist('https://pl.example/a.m3u8'), true);
  assert.equal(mc.removePlaylist('https://pl.example/a.m3u8'), false);
  reset();
});

test('fetchPlaylist: parses an M3U, refuses an empty or private one, and a redirect to a private address', async () => {
  const body = '#EXTM3U\n#EXTINF:-1 tvg-id="x",FIFA Plus\nhttps://s.example/fifa.m3u8\n#EXTINF:-1,Fed TV, HD\nhttps://s.example/fed.m3u8\n';
  const seen = [];
  const http = { get: async (url, opts) => { seen.push({ url, opts }); return { data: body }; } };
  const parsed = await mc.fetchPlaylist('https://pl.example/list.m3u8', http);
  assert.deepEqual(parsed, [{ name: 'FIFA Plus', url: 'https://s.example/fifa.m3u8' }, { name: 'HD', url: 'https://s.example/fed.m3u8' }]);
  assert.equal(seen[0].opts.maxRedirects, 3);
  assert.equal(seen[0].opts.maxContentLength, 30 * 1024 * 1024);
  assert.throws(() => seen[0].opts.beforeRedirect({ hostname: '10.0.0.1', protocol: 'https:' }), /not accepted/);
  assert.throws(() => seen[0].opts.beforeRedirect({ hostname: 'ok.example', protocol: 'ftp:' }), /not accepted/);
  assert.doesNotThrow(() => seen[0].opts.beforeRedirect({ hostname: 'ok.example', protocol: 'https:' }));
  await assert.rejects(mc.fetchPlaylist('https://pl.example/empty.m3u8', { get: async () => ({ data: '<html>not a playlist</html>' }) }), /no channels found/);
  await assert.rejects(mc.fetchPlaylist('http://192.168.1.1/a.m3u8', http), /private or local/);
  assert.equal(seen.length, 1, 'no request went out for the private address');
});

test('export: an embed is listed with its own page link (no /go), flagged sourceEmbed, and judged on being frameable', () => {
  const embed = 'https://p.example/e/1';
  const stream = 'https://x.example/a.m3u8';
  const rows = [{ channels: [{ name: 'Fed TV', sources: [embed, stream], manualUrls: [embed, stream], embedUrls: [embed] }] }];
  const checks = {
    [embed]: { status: 'ok', working: true, isManifest: false, httpStatus: 200 },
    [stream]: { status: 'stream', working: true, cors: true, isManifest: true, visitorWorking: true, visitorPath: 'relay' },
  };
  const ch = enrichRowsWithSourceStatus(rows, (u) => checks[u] || null, { publicBaseUrl: 'https://feed.example' })[0].channels[0];
  // the stream is first (relayed), the embed after it, and every array moved together
  assert.deepEqual(ch.sources, ['https://feed.example/go?u=' + encodeURIComponent(stream), embed]);
  assert.deepEqual(ch.sourceEmbed, [false, true]);
  assert.deepEqual(ch.sourceWorking, [true, true]);
  const verdict = (check) => enrichRowsWithSourceStatus(rows, (u) => (u === embed ? check : null), {})[0].channels[0].sourceWorking[1];
  assert.equal(verdict({ status: 'blocked', working: true, isManifest: false }), false, 'forbids framing');
  assert.equal(verdict({ status: 'dead', working: false, isManifest: false, httpStatus: 404 }), false, 'gone');
  assert.equal(verdict({ status: 'dead', working: false, isManifest: false, error: 'ENOTFOUND' }), false, 'unreachable');
  assert.equal(verdict({ status: 'dead', working: false, isManifest: false, httpStatus: 403 }), null, 'a refusal from the US datacenter says nothing about a visitor');
  assert.equal(verdict({ status: 'dead', working: false, isManifest: false, httpStatus: 503 }), null);
  assert.equal(verdict(null), null, 'not checked yet');
});

test('the manual channels page and its JSON API', async (t) => {
  const auth = require('../src/auth');
  const { createServer } = require('../src/server');
  reset();
  auth.upsert({ username: 'mc-admin', password: 'mc-admin-pass', role: 'admin' });
  auth.upsert({ username: 'mc-viewer', password: 'mc-viewer-pass', role: 'viewer' });
  const adds = [];
  const app = createServer({
    getState: () => ({ lastRows: [row([{ name: 'No Stream TV', sources: [] }])] }),
    runOnce: async () => {}, rescheduleCron: () => {}, runSourceCheck: async () => {}, getSourceStatus: () => ({}),
    runTranslate: async () => {}, getAllTranslations: () => ({}), setManualTranslation: () => {}, getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {}, runLiveTvFetch: async () => {}, getAllYouTubeChannels: () => [], setChannelStatus: () => {},
    getManualChannelsAll: mc.getAll,
    addManualChannel: (n, u, o) => { adds.push([n, u, o]); return mc.addManualChannel(n, u, o); },
    removeManualChannel: mc.removeManualChannel,
    addPlaylist: async (u, l) => mc.addPlaylist(u, l),
    removePlaylist: mc.removePlaylist,
    getPlaylists: mc.getPlaylists,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const admin = 'Basic ' + Buffer.from('mc-admin:mc-admin-pass').toString('base64');
  const viewer = 'Basic ' + Buffer.from('mc-viewer:mc-viewer-pass').toString('base64');
  const form = (path, body, auth_ = admin) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Authorization: auth_, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json = (path, body, auth_ = admin) => fetch(base + path, { method: 'POST', headers: { Authorization: auth_, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // login required, admins only
  assert.equal((await fetch(`${base}/api/manual-channels`)).status, 401);
  assert.equal((await fetch(`${base}/api/manual-channels`, { headers: { Authorization: viewer } })).status, 401);
  assert.equal((await json('/api/manual-channels', {}, viewer)).status, 401);

  // the add form: an embed with its type, a pasted iframe, and a refused link shown on the page
  assert.equal((await form('/api/manual-channel', { name: 'Fed TV', url: 'https://p.example/e/1', type: 'embed' })).status, 302);
  assert.deepEqual(adds[0], ['Fed TV', 'https://p.example/e/1', { type: 'embed' }]);
  assert.equal((await form('/api/manual-channel', { name: 'Fed TV', url: '<iframe src="https://p.example/e/2"></iframe>', type: '' })).status, 302);
  const refused = await form('/api/manual-channel', { name: 'Bad TV', url: 'javascript:alert(1)', type: '' });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Not added: only http\(s\) links are accepted/);
  assert.deepEqual(mc.getAll()['fed tv'].embed, ['https://p.example/e/1', 'https://p.example/e/2']);

  // JSON out and in
  const exported = await (await fetch(`${base}/api/manual-channels`, { headers: { Authorization: admin } })).json();
  assert.deepEqual(exported.channels[0].sources.map((s) => s.type), ['embed', 'embed']);
  const imp = await json('/api/manual-channels', { playlists: ['https://pl.example/a.m3u8'], channels: [{ name: 'J TV', sources: ['https://x.example/j.m3u8'] }] });
  assert.equal(imp.status, 200);
  assert.deepEqual((await imp.json()).added, 1);
  const bad = await json('/api/manual-channels?replace=1', { 'Only Bad': ['ftp://x'] });
  assert.equal(bad.status, 400);
  assert.ok(mc.getAll()['j tv'], 'a failed replace changed nothing');
  const pasted = await form('/api/manual-channels/import', { json: '{"K TV": ["https://x.example/k.m3u8"]}' });
  assert.equal(pasted.status, 200);
  assert.match(await pasted.text(), /Imported 1 source/);
  assert.equal((await form('/api/manual-channels/import', { json: '{ nope' })).status, 400);

  // playlists
  const refusedPl = await form('/api/manual-playlist', { url: 'http://127.0.0.1/a.m3u8' });
  assert.equal(refusedPl.status, 400);
  assert.match(await refusedPl.text(), /private or local/);
  assert.equal((await form('/api/manual-playlist', { url: 'https://pl.example/b.m3u8', label: 'B' })).status, 200);
  assert.equal((await form('/api/manual-playlist/remove', { url: 'https://pl.example/b.m3u8' })).status, 302);
  assert.equal(mc.getPlaylists().some((p) => p.url === 'https://pl.example/b.m3u8'), false);

  // the page shows types, playlists, the JSON box, and escapes what was typed
  mc.addManualChannel('<b>x</b>', 'https://x.example/x.m3u8');
  const page = await (await fetch(`${base}/manual-channels`, { headers: { Authorization: admin } })).text();
  assert.match(page, /badge-manual">embed</);
  assert.match(page, /Remote playlists/);
  assert.match(page, /Import JSON/);
  assert.match(page, /No Stream TV/);
  assert.ok(!page.includes('<b>x</b>'), 'a channel name is escaped');
  reset();
});
