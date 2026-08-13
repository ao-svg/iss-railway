require('dotenv').config();
const cron = require('node-cron');
const { runPipeline } = require('./pipeline');
const { createServer } = require('./server');
const { getConfig } = require('./config');

const port = process.env.PORT || 3000;

const state = {
  running: false,
  lastRunAt: null,
  lastRunCount: null,
  lastRunFailures: [],
  lastError: null,
  lastRows: null,
};

let cronTask = null;

async function runOnce() {
  if (state.running) return state;
  state.running = true;
  try {
    const { apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays } = getConfig();
    const { rows, failures } = await runPipeline({ apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays });
    state.lastRunAt = new Date().toISOString();
    state.lastRunCount = rows.length;
    state.lastRunFailures = failures;
    state.lastRows = rows;
    state.lastError = null;
  } catch (err) {
    console.error('[pipeline] run failed:', err.message);
    state.lastError = err.message;
  } finally {
    state.running = false;
  }
  return state;
}

function scheduleCron() {
  if (cronTask) cronTask.stop();
  const { cronExpr } = getConfig();
  if (!cron.validate(cronExpr)) {
    console.error(`[index] invalid PIPELINE_CRON "${cronExpr}", falling back to every 6h`);
    getConfig().cronExpr = '0 */6 * * *';
  }
  cronTask = cron.schedule(getConfig().cronExpr, runOnce);
  console.log(`[index] pipeline scheduled: ${getConfig().cronExpr}`);
}

const runOnlyFlag = process.argv.includes('--once');

if (runOnlyFlag) {
  runOnce().then(() => process.exit(0));
} else {
  runOnce();
  scheduleCron();

  const app = createServer({
    getState: () => state,
    runOnce,
    rescheduleCron: scheduleCron,
  });
  app.listen(port, () => {
    console.log(`[index] server listening on :${port}`);
  });
}
