const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Reports and users persist to the data dir — keep them out of the repo's data/.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'source-report-test-'));
const { categorize, buildReport, addReport, saveReport, getReports, CATEGORIES } = require('../src/sourceReport');

test('categorize: every kind of check result lands in the right category', () => {
  assert.equal(categorize(null), 'neverChecked');
  assert.equal(categorize({ status: 'stream', working: true, cors: true, httpStatus: 200 }), 'live');
  assert.equal(categorize({ status: 'ok', working: true, cors: null, httpStatus: 200 }), 'live');
  assert.equal(categorize({ status: 'nocors', working: true, cors: false, httpStatus: 200 }), 'liveNoCors');
  assert.equal(categorize({ status: 'stream', working: null, cors: true, httpStatus: 200 }), 'responding');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 401 }), 'authError');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 403 }), 'authError');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 404 }), 'notFound');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 502 }), 'serverError');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 429 }), 'otherHttpError');
  assert.equal(categorize({ status: 'dead', working: false, error: 'timeout of 8000ms exceeded' }), 'notResponding');
  assert.equal(categorize({ status: 'dead', working: false, httpStatus: 200 }), 'broken', 'playlist answers but a segment hop is dead');
  assert.equal(categorize({ status: 'blocked', working: true, httpStatus: 200 }), 'blocked');
  assert.equal(categorize({ status: 'dangerous', httpStatus: 200 }), 'dangerous');
});

test('categorize: every key it can return has a label', () => {
  const keys = new Set(CATEGORIES.map((c) => c.key));
  for (const k of ['neverChecked', 'live', 'liveNoCors', 'responding', 'authError', 'notFound', 'serverError', 'otherHttpError', 'notResponding', 'broken', 'blocked', 'dangerous']) {
    assert.ok(keys.has(k), k);
  }
});

test('buildReport: dedupes, counts per category and per host, relay and US-only extras', () => {
  const checks = {
    'https://a.example/1.m3u8': { status: 'stream', working: true, cors: true, httpStatus: 200, relayPlayable: true },
    'https://a.example/2.m3u8': { status: 'dead', working: false, httpStatus: 403 },
    'https://b.example/1.m3u8': { status: 'dead', working: false, error: 'ENOTFOUND' },
  };
  const urls = ['https://a.example/1.m3u8', 'https://a.example/1.m3u8', 'https://a.example/2.m3u8', 'https://b.example/1.m3u8', 'https://c.example/x.m3u8'];
  const r = buildReport(urls, (u) => checks[u] || null, {
    getGeo: (u) => (u.includes('b.example') ? 'us-only' : null),
    now: new Date('2026-11-01T06:00:00Z'),
  });
  assert.equal(r.date, '2026-11-01');
  assert.equal(r.total, 4);
  assert.equal(r.counts.live, 1);
  assert.equal(r.counts.authError, 1);
  assert.equal(r.counts.notResponding, 1);
  assert.equal(r.counts.neverChecked, 1);
  assert.equal(r.relayPlayable, 1);
  assert.equal(r.usOnly, 1);
  assert.equal(r.byHost[0].host, 'a.example');
  assert.equal(r.byHost[0].total, 2);
  assert.equal(r.byHost[0].counts.authError, 1);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.total, 'every source counted exactly once');
});

test('addReport: one snapshot per day (a rerun replaces it), oldest dropped past the limit', () => {
  const day = (d, live) => ({ date: d, at: `${d}T06:00:00Z`, counts: { live } });
  let list = addReport([], day('2026-10-30', 1));
  list = addReport(list, day('2026-10-31', 2));
  list = addReport(list, day('2026-10-31', 3));
  assert.deepEqual(list.map((r) => [r.date, r.counts.live]), [['2026-10-30', 1], ['2026-10-31', 3]]);
  list = addReport(list, day('2026-11-01', 4), 2);
  assert.deepEqual(list.map((r) => r.date), ['2026-10-31', '2026-11-01']);
});

test('saveReport: persists and getReports returns it', () => {
  const r = buildReport(['https://a.example/1.m3u8'], () => null, { now: new Date('2026-11-01T06:00:00Z') });
  saveReport(r);
  assert.equal(getReports().at(-1).date, '2026-11-01');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'source-reports.json'), 'utf8'));
  assert.equal(onDisk.at(-1).total, 1);
});

test('/source-report: admin only; renders today vs yesterday, JSON, and the run button triggers a report', async (t) => {
  const { createServer } = require('../src/server');
  const auth = require('../src/auth');
  auth.upsert({ username: 'report-admin', password: 'pw-report', role: 'admin' });
  const ADMIN = 'Basic ' + Buffer.from('report-admin:pw-report').toString('base64');
  const yesterday = buildReport(['https://a.example/1.m3u8'], () => ({ status: 'dead', httpStatus: 403 }), { now: new Date('2026-10-31T06:00:00Z') });
  const today = buildReport(['https://a.example/1.m3u8'], () => ({ status: 'stream', working: true, cors: true, httpStatus: 200 }), { now: new Date('2026-11-01T06:00:00Z') });
  let ran = 0;
  const app = createServer({
    getState: () => ({}),
    sourceReport: {
      getReports: () => [yesterday, today],
      getSchedule: () => ({ pipelineCron: '0 */6 * * *', sourceCheckCron: '*/3 * * * *', doms9RefreshMinutes: 20, reportCron: '0 6 * * *' }),
      isRunning: () => false,
      runReport: async () => {
        ran++;
      },
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/source-report`)).status, 401);
  const page = await fetch(`${base}/source-report`, { headers: { Authorization: ADMIN } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Source health/);
  assert.match(html, /Live — plays in a browser<\/td><td>1<\/td><td>100%<\/td><td><span class="muted">\+1/);
  assert.match(html, /Authorization error \(401\/403\)<\/td><td>0<\/td>/, 'a category that dropped to 0 still shows, with its change');
  assert.match(html, /0 \*\/6 \* \* \*/, 'shows the pipeline schedule');

  const json = await (await fetch(`${base}/source-report.json`, { headers: { Authorization: ADMIN } })).json();
  assert.equal(json.reports.length, 2);
  assert.equal(json.schedule.doms9RefreshMinutes, 20);

  const post = await fetch(`${base}/api/source-report`, { method: 'POST', headers: { Authorization: ADMIN }, redirect: 'manual' });
  assert.equal(post.status, 302);
  assert.equal(ran, 1);
});
