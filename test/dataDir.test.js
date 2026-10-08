const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['dataDir', 'config'].map((m) => require.resolve(path.join(SRC, m)));

// dataDir/config resolve env at require (and update) time, so run each body
// with fresh modules under the given env, restoring everything afterwards.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  MODULES.forEach((m) => delete require.cache[m]);
  try {
    return fn({ dataDir: require(path.join(SRC, 'dataDir')), config: require(path.join(SRC, 'config')) });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    MODULES.forEach((m) => delete require.cache[m]);
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss-data-'));
const readSaved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('dataDir: defaults to <repo>/data and reports not persistent', () => {
  withEnv({ DATA_DIR: undefined, RAILWAY_VOLUME_MOUNT_PATH: undefined }, ({ dataDir }) => {
    assert.strictEqual(dataDir.DATA_DIR, path.resolve(__dirname, '..', 'data'));
    assert.strictEqual(dataDir.IS_PERSISTENT, false);
  });
});

test('dataDir: picks up a Railway volume mount automatically', () => {
  const mount = path.join(os.tmpdir(), 'vol');
  withEnv({ DATA_DIR: undefined, RAILWAY_VOLUME_MOUNT_PATH: mount }, ({ dataDir }) => {
    assert.strictEqual(dataDir.DATA_DIR, path.resolve(mount));
    assert.strictEqual(dataDir.IS_PERSISTENT, true);
    assert.strictEqual(dataDir.dataPath('users.json'), path.join(path.resolve(mount), 'users.json'));
  });
});

test('dataDir: DATA_DIR wins over the Railway volume mount', () => {
  withEnv({ DATA_DIR: '/explicit', RAILWAY_VOLUME_MOUNT_PATH: '/vol' }, ({ dataDir }) => {
    assert.strictEqual(dataDir.DATA_DIR, path.resolve('/explicit'));
  });
});

test('config: CSV outputs default into the data dir', () => {
  const dir = tmpDir();
  withEnv({ DATA_DIR: dir, OUTPUT_CSV_PATH: undefined, OUTPUT_LIVE_CSV_PATH: undefined }, ({ config }) => {
    assert.strictEqual(config.getConfig().outputCsvPath, path.join(dir, 'fixtures.csv'));
    assert.strictEqual(config.getConfig().outputLiveCsvPath, path.join(dir, 'live.csv'));
  });
});

test('config: only fields that differ from env are persisted as overrides', () => {
  const dir = tmpDir();
  withEnv({ DATA_DIR: dir, SPORTSDB_API_KEY: 'envkey', WTM_DAYS: '31' }, ({ config }) => {
    // Settings form posts every field; apiKey unchanged, wtmDays changed.
    config.updateConfig({ apiKey: 'envkey', wtmDays: '7' });
    assert.deepStrictEqual(readSaved(dir), { wtmDays: 7 });
  });
  // A later env change to an un-overridden field takes effect on next boot.
  withEnv({ DATA_DIR: dir, SPORTSDB_API_KEY: 'rotated', WTM_DAYS: '31' }, ({ config }) => {
    assert.strictEqual(config.getConfig().apiKey, 'rotated');
    assert.strictEqual(config.getConfig().wtmDays, 7);
  });
});

test('config: setting a field back to its env value drops the override', () => {
  const dir = tmpDir();
  withEnv({ DATA_DIR: dir, WTM_DAYS: '31' }, ({ config }) => {
    config.updateConfig({ wtmDays: '7' });
    config.updateConfig({ wtmDays: '31' });
    assert.deepStrictEqual(readSaved(dir), {});
  });
});
