require('dotenv').config();
const cron = require('node-cron');
const { runPipeline } = require('./pipeline');
const { createServer } = require('./server');

const config = {
  apiKey: process.env.SPORTSDB_API_KEY || '1',
  leagueIds: (process.env.SPORTSDB_LEAGUE_IDS || '4790')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  playlistUrl: process.env.IPTV_ORG_PLAYLIST_URL || 'https://iptv-org.github.io/iptv/index.m3u',
  outputCsvPath: process.env.OUTPUT_CSV_PATH || './data/fixtures.csv',
  cronExpr: process.env.PIPELINE_CRON || '0 */6 * * *',
  port: process.env.PORT || 3000,
};

let lastRunRows = null;

async function runOnce() {
  try {
    lastRunRows = await runPipeline(config);
  } catch (err) {
    console.error('[pipeline] run failed:', err.message);
  }
}

const runOnlyFlag = process.argv.includes('--once');

if (runOnlyFlag) {
  runOnce().then(() => process.exit(0));
} else {
  // Kick off an initial run at boot, then follow the cron schedule.
  runOnce();

  if (!cron.validate(config.cronExpr)) {
    console.error(`[index] invalid PIPELINE_CRON "${config.cronExpr}", falling back to every 6h`);
    config.cronExpr = '0 */6 * * *';
  }
  cron.schedule(config.cronExpr, runOnce);
  console.log(`[index] pipeline scheduled: ${config.cronExpr}`);

  const app = createServer({
    outputCsvPath: config.outputCsvPath,
    getLastRun: () => lastRunRows,
  });
  app.listen(config.port, () => {
    console.log(`[index] server listening on :${config.port}`);
  });
}
