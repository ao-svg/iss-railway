require('dotenv').config();
const cron = require('node-cron');
const { runPipeline } = require('./pipeline');
const { createServer } = require('./server');
const { getConfig } = require('./config');
const sourceChecks = require('./sourceChecks');

const port = process.env.PORT || 3000;

const state = {
  running: false,
  lastRunAt: null,
  lastRunCount: null,
  lastRunFailures: [],
  lastError: null,
  lastRows: null,
  checkRunning: false,
  checkProgress: null, // { done, total }
  lastCheckAt: null,
  lastCheckSummary: null,
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

function allSourceUrls() {
  const urls = [];
  for (const row of state.lastRows || []) {
    for (const ch of row.channels || []) {
      for (const url of ch.sources || []) urls.push(url);
    }
  }
  return urls;
}

async function runSourceCheck(force = false) {
  if (state.checkRunning) return state;
  const urls = allSourceUrls();
  if (!urls.length) return state;
  state.checkRunning = true;
  state.checkProgress = { done: 0, total: urls.length };
  try {
    const summary = await sourceChecks.checkAll(urls, {
      force,
      onProgress: (done, total) => {
        state.checkProgress = { done, total };
      },
    });
    state.lastCheckAt = new Date().toISOString();
    state.lastCheckSummary = summary;
  } catch (err) {
    console.error('[sourceChecks] run failed:', err.message);
  } finally {
    state.checkRunning = false;
    state.checkProgress = null;
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
    runSourceCheck,
    getSourceStatus: sourceChecks.getStatus,
  });
  app.listen(port, () => {
    console.log(`[index] server listening on :${port}`);
  });
}
