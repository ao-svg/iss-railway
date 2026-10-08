// Single home for every file this app persists (users, settings overrides,
// source checks, screenshots, translations, CSV exports...).
//
// Resolution order:
//   1. DATA_DIR — explicit override.
//   2. RAILWAY_VOLUME_MOUNT_PATH — Railway sets this automatically when a
//      volume is attached to the service, so attaching one is all it takes
//      for state to survive redeploys.
//   3. <repo>/data — local default, and what Railway falls back to with no
//      volume (ephemeral: wiped on every redeploy).

const path = require('path');

const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data')
);

const IS_PERSISTENT = Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

module.exports = { DATA_DIR, IS_PERSISTENT, dataPath };
