const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { closeBrowser, processStats, formatStats, BASE_ARGS } = require('../src/browser');

test('BASE_ARGS keep crash reporting on (disabling it wedged captures on Linux)', () => {
  for (const flag of ['--disable-crash-reporter', '--disable-breakpad', '--disable-crashpad-for-testing']) {
    assert.ok(!BASE_ARGS.includes(flag), flag);
  }
});

test('closeBrowser: tolerates a missing browser and a rejecting close()', async () => {
  await closeBrowser(null);
  await closeBrowser({ close: () => Promise.reject(new Error('boom')), process: () => null });
});

test('closeBrowser: a hung close() is capped by the timeout', async () => {
  const started = Date.now();
  await closeBrowser({ close: () => new Promise(() => {}), process: () => null }, { timeoutMs: 200 });
  assert.ok(Date.now() - started < 2000);
});

test('closeBrowser: kills the browser process group even when close() hangs', { skip: process.platform === 'win32' }, async () => {
  // Stand-in for Chrome: a detached group leader with a child of its own.
  const leader = spawn('sh', ['-c', 'sleep 60 & sleep 60'], { detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => leader.on('exit', resolve));
  await closeBrowser({ close: () => new Promise(() => {}), process: () => leader }, { timeoutMs: 100 });
  await exited;
  assert.throws(() => process.kill(-leader.pid, 0), /ESRCH/, 'whole process group should be gone');
});

test('processStats/formatStats: Linux snapshot, null elsewhere', () => {
  const s = processStats();
  if (process.platform !== 'linux') {
    assert.equal(s, null);
    assert.equal(formatStats(s), 'n/a');
    return;
  }
  assert.ok(s.total > 0);
  assert.match(formatStats(s), /^procs=\d+ zombies=\d+ chrome=\d+ /);
});
