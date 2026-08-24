const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { updateConfig } = require('../src/config');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('/live.csv and /live.json serve the live export', async (t) => {
  const tmpCsv = path.join(os.tmpdir(), `live-test-${Date.now()}.csv`);
  fs.writeFileSync(tmpCsv, 'Date,Time,Status\n2026-08-24,20:00,live\n', 'utf8');
  updateConfig({ outputLiveCsvPath: tmpCsv });

  const fakeRows = [{ eventId: 'a', league: 'Premier League', status: 'live', channels: [] }];
  const app = createServer({
    getState: () => ({ liveRowsNormalized: fakeRows }),
    runOnce: async () => {},
    rescheduleCron: () => {},
    runSourceCheck: async () => {},
    getSourceStatus: () => ({}),
    runTranslate: async () => {},
    getAllTranslations: () => ({}),
    setManualTranslation: () => {},
    getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {},
    runLiveTvFetch: async () => {},
    getAllYouTubeChannels: () => [],
    setChannelStatus: () => {},
  });

  const server = await startServer(app);
  const port = server.address().port;

  t.after(() => {
    server.close();
    fs.rmSync(tmpCsv, { force: true });
  });

  const csvRes = await fetch(`http://localhost:${port}/live.csv`);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csvBody = await csvRes.text();
  assert.match(csvBody, /^Date,Time,Status/);

  const jsonRes = await fetch(`http://localhost:${port}/live.json`);
  assert.equal(jsonRes.status, 200);
  const jsonBody = await jsonRes.json();
  assert.deepEqual(jsonBody, fakeRows);
});

test('/live.csv 404s when no export has been generated yet', async (t) => {
  updateConfig({ outputLiveCsvPath: path.join(os.tmpdir(), `nonexistent-${Date.now()}.csv`) });
  const app = createServer({
    getState: () => ({ liveRowsNormalized: null }),
    runOnce: async () => {},
    rescheduleCron: () => {},
    runSourceCheck: async () => {},
    getSourceStatus: () => ({}),
    runTranslate: async () => {},
    getAllTranslations: () => ({}),
    setManualTranslation: () => {},
    getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {},
    runLiveTvFetch: async () => {},
    getAllYouTubeChannels: () => [],
    setChannelStatus: () => {},
  });

  const server = await startServer(app);
  const port = server.address().port;
  t.after(() => server.close());

  const csvRes = await fetch(`http://localhost:${port}/live.csv`);
  assert.equal(csvRes.status, 404);

  const jsonRes = await fetch(`http://localhost:${port}/live.json`);
  assert.equal(jsonRes.status, 404);
});
