const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { orderTeams } = require('../src/livesportsontv');

test('orderTeams: US sports read "Away @ Home"', () => {
  assert.deepEqual(orderTeams(['San Jose Sharks', 'Montreal Canadiens'], '@'), {
    homeTeam: 'Montreal Canadiens',
    awayTeam: 'San Jose Sharks',
  });
});

test('orderTeams: soccer reads "Home vs. Away"', () => {
  assert.deepEqual(orderTeams(['Ipswich Town', 'Nottingham Forest'], 'vs.'), {
    homeTeam: 'Ipswich Town',
    awayTeam: 'Nottingham Forest',
  });
});

test('orderTeams: missing teams come back empty', () => {
  assert.deepEqual(orderTeams([], ''), { homeTeam: '', awayTeam: '' });
});

test('the default league list in config.js is every league livesportsontv.js knows', () => {
  // Fresh process with an empty data dir: no config.json override, no env.
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'iss-lsotv-test-')) };
  delete env.LIVESPORTSONTV_LEAGUES;
  const out = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config').getConfig().livesportsontvLeagues))"], {
    cwd: path.join(__dirname, '..'),
    env,
  });
  const { DEFAULT_LEAGUES } = require('../src/livesportsontv');
  assert.deepEqual(JSON.parse(out).sort(), [...DEFAULT_LEAGUES].sort());
});
