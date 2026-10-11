// Shared headless-Chrome launch/teardown for every Puppeteer user
// (screenshots, liveTv, livesportsontv).
//
// Production evidence (2026-10-09..11): after ~2 days of 3-minute capture
// passes every launch failed with
//   posix_spawn .../chrome_crashpad_handler: Resource temporarily unavailable (11)
// i.e. the container's process/thread limit was exhausted. Each pass left
// Chrome helper processes behind (crashpad handler especially — it outlives
// the browser by design), and `browser.close()` alone neither guarantees
// they're gone nor returns at all when the browser is wedged. So:
//   - crash reporting is switched off, so no crashpad handler is spawned;
//   - closeBrowser() caps close() with a timeout, then SIGKILLs the
//     browser's whole process group (Puppeteer launches Chrome detached, as
//     its own group leader), taking every helper down with it;
//   - processStats() is logged around capture passes so a leak shows up as
//     a rising number long before launches start failing.

const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-crashpad-for-testing',
];

const CLOSE_TIMEOUT_MS = 10000;

async function launchBrowser(extraArgs = []) {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [...new Set([...BASE_ARGS, ...extraArgs])],
  });
}

function killGroup(pid) {
  if (!pid || process.platform === 'win32') return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // ESRCH: already gone — the normal case after a clean close().
    }
  }
}

// Never throws, never hangs longer than timeoutMs.
async function closeBrowser(browser, { timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  const pid = proc && proc.pid;
  let timer;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  killGroup(pid);
}

function readFirst(paths) {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Snapshot of this container's processes (Linux only, null elsewhere):
 * { total, zombies, chrome, pidsCurrent, pidsMax, pid1 }.
 * pidsCurrent/pidsMax come from the cgroup and count threads too — that's
 * the limit posix_spawn hit.
 */
function processStats() {
  if (process.platform !== 'linux') return null;
  let total = 0;
  let zombies = 0;
  let chrome = 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of entries) {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue; // exited mid-scan
    }
    // Format: pid (comm) state ... — comm can contain spaces/parens.
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const state = stat.slice(close + 2, close + 3);
    total++;
    if (state === 'Z') zombies++;
    if (/chrom|crashpad/i.test(comm)) chrome++;
  }
  const pid1 = readFirst(['/proc/1/comm']);
  return {
    total,
    zombies,
    chrome,
    pidsCurrent: readFirst(['/sys/fs/cgroup/pids.current', '/sys/fs/cgroup/pids/pids.current']),
    pidsMax: readFirst(['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max']),
    pid1,
  };
}

function formatStats(s) {
  if (!s) return 'n/a';
  return `procs=${s.total} zombies=${s.zombies} chrome=${s.chrome} cgroupPids=${s.pidsCurrent ?? '?'}/${s.pidsMax ?? '?'} pid1=${s.pid1 ?? '?'}`;
}

module.exports = { launchBrowser, closeBrowser, processStats, formatStats, BASE_ARGS };
