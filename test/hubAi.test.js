const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// A stand-in for OpenAI's chat completions, started before hubAi reads OPENAI_BASE_URL
const calls = [];
const fakeOpenAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    calls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '```html\n<h2 class="x">足球直播</h2><p onclick="evil()">在本站观看足球直播，赛程按北京时间排列，多个直播源可以随时切换，全部免费<a href="https://spam">链接</a></p><script>alert(1)</script><h3>问题</h3><p>回答</p>\n```' } }] }));
  });
});

test('AI content', async (t) => {
  await new Promise((r) => fakeOpenAi.listen(0, r));
  process.env.OPENAI_BASE_URL = `http://localhost:${fakeOpenAi.address().port}/v1`;
  const hub = require('../src/hub');
  const hubAi = require('../src/hubAi');
  const { createServer } = require('../src/server');
  const auth = require('../src/auth');

  const SITE = 'hub-ai-test.example';
  const PLAYER = 'hub-ai-player.example';
  const st = hub.getState();
  const savedAi = st.ai;
  auth.upsert({ username: 'test-admin-hubAi', password: 'pw-hubAi-123', role: 'admin' });
  const basic = 'Basic ' + Buffer.from('test-admin-hubAi:pw-hubAi-123').toString('base64');
  const server = await new Promise((r) => { const s = createServer({ getState: () => ({}) }).listen(0, () => r(s)); });
  const base = `http://localhost:${server.address().port}`;

  t.after(() => {
    server.close();
    fakeOpenAi.close();
    st.ai = savedAi;
    hub.forgetSite(SITE);
    hub.forgetSite(PLAYER);
    delete st.commands[SITE];
    auth.remove('test-admin-hubAi');
  });

  hub.recordCheckin(SITE, { home: '', version: '2.5.0', plugin: hub.PLUGIN_SLUG, role: 'schedule', sports: ['Football', 'Basketball'] });
  hub.recordCheckin(PLAYER, { home: '', version: '4.4.0', plugin: hub.PLAYER_SLUG, role: 'player' });

  await t.test('cleanHtml keeps only simple text markup', () => {
    assert.equal(
      hubAi.cleanHtml('<h2 class="x">A</h2><p onclick="e()">B<a href="u">C</a></p><script>bad()</script><img src=x>'),
      '<h2>A</h2><p>BC</p>'
    );
  });

  await t.test('without a key: a clear message, nothing queued', () => {
    st.ai = { model: 'gpt-4o-mini', brief: '', key: '' };
    assert.throws(() => hubAi.startSite(SITE), /Add the OpenAI API key/);
  });

  await t.test('destination sites are refused', () => {
    hub.updateAiSettings({ key: 'sk-test-1234567890abcd' });
    assert.throws(() => hubAi.startSite(PLAYER), /destination site/);
  });

  await t.test('writes every sport page, then queues one content command — the key stays on the hub', async () => {
    const job = hubAi.startSite(SITE);
    assert.equal(job.total, 2);
    for (let i = 0; i < 50 && job.status === 'writing'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(job.status, 'sent');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].auth, 'Bearer sk-test-1234567890abcd');
    assert.match(calls[0].body.messages[1].content, /足球直播/);

    const cmd = hub.commandsFor(SITE).find((c) => c.type === 'content');
    assert.deepEqual(Object.keys(cmd.args.pages), ['Football', 'Basketball']);
    assert.equal(cmd.args.pages.Football, '<h2>足球直播</h2><p>在本站观看足球直播，赛程按北京时间排列，多个直播源可以随时切换，全部免费链接</p><h3>问题</h3><p>回答</p>');
    assert.doesNotMatch(JSON.stringify(cmd), /sk-test/);
  });

  await t.test('the page shows the key masked, never in full', async () => {
    const html = await (await fetch(`${base}/sites`, { headers: { Authorization: basic } })).text();
    assert.match(html, /AI content/);
    assert.match(html, /sk-…abcd/);
    assert.doesNotMatch(html, /sk-test-1234567890abcd/);
  });

  await t.test('saving the form with the key field empty keeps the saved key', async () => {
    const res = await fetch(`${base}/api/hub/ai`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: '', model: 'gpt-4o', brief: '多提世界杯' }),
    });
    assert.equal(res.status, 302);
    assert.deepEqual(hub.aiSettings(), { key: 'sk-test-1234567890abcd', model: 'gpt-4o', brief: '多提世界杯' });
  });
});
