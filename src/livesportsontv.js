// Third fixture source. Legitimate TV guide — explicitly does not host or
// link to streams, only lists real broadcaster/platform names (Paramount+,
// CBS, Peacock, NBC, ESPN, Fubo, NFL Sunday Ticket, etc.), confirmed by
// direct inspection this session. Heavily US pro/college sports, which is
// genuinely complementary coverage to wheresthematch.com's UK/global-
// leaning set — not just more of the same.
//
// One page per configured league slug (`/league/<slug>`, e.g. "nfl")
// covers that whole league's upcoming schedule in one request — far more
// efficient than the site's per-team pages. Channel names are rendered
// client-side (confirmed absent from the raw server HTML — only present
// as an <img alt="..."> after the page's JS runs), so this needs a
// headless browser, same as src/liveTv.js already uses for its own
// site's JS challenge — reusing that dependency, not adding a new one.

const puppeteer = require('puppeteer');

const BASE_URL = 'https://www.livesportsontv.com';
const TIME_ZONE = 'America/New_York'; // site's displayed times match real US ET kickoffs (DST-aware, unlike a fixed offset)
const NAV_TIMEOUT_MS = 20000;
const SELECTOR_TIMEOUT_MS = 15000;
const MAX_RUNTIME_MS = 8 * 60 * 1000;

// Sport name per league slug — the site organizes by league, not by a
// per-row sport label, so this is supplied rather than scraped.
const LEAGUE_SPORTS = {
  nfl: 'American Football',
  nba: 'Basketball',
  mlb: 'Baseball',
  nhl: 'Ice Hockey',
  mls: 'Football',
};

/**
 * Convert a wall-clock date/time in `timeZone` to a UTC Date, without a
 * timezone library — standard iterative-refinement trick: treat the wall
 * clock as if it were already UTC, see what that guess actually reads as
 * in the target timezone, and correct by the difference. Converges in a
 * couple of iterations for any real-world timezone (DST-aware).
 */
function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(guess))
      .reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});
    const hour24 = parts.hour === '24' ? 0 : Number(parts.hour);
    const guessedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute));
    guess += target - guessedAsUtc;
  }
  return new Date(guess);
}

/**
 * Parse "Sep 18" + "3:15 AM" into a UTC ISO string. No year is shown, so
 * infer it: current year, rolled to next year if that would land more
 * than a day in the past (handles a season's schedule spanning a
 * calendar-year boundary, e.g. scraping in September but the page also
 * lists January/February games).
 */
function parseGameDateTime(dateStr, timeStr, now = new Date()) {
  const dm = dateStr.match(/([A-Za-z]{3})\s+(\d{1,2})/);
  const tm = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!dm || !tm) return null;

  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = monthNames.indexOf(dm[1].toLowerCase()) + 1;
  if (!month) return null;
  const day = Number(dm[2]);

  let hour = Number(tm[1]) % 12;
  if (/pm/i.test(tm[3])) hour += 12;
  const minute = Number(tm[2]);

  let year = now.getUTCFullYear();
  let d = zonedTimeToUtc(year, month, day, hour, minute, TIME_ZONE);
  if (d.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    d = zonedTimeToUtc(year + 1, month, day, hour, minute, TIME_ZONE);
  }
  return d.toISOString();
}

async function extractGames(page) {
  return page.evaluate(() => {
    const containers = [...document.querySelectorAll('[class*="FixtureItem_container"]')];
    return containers.map((c) => {
      const date = c.querySelector('[class*="FixtureItem_date"]')?.textContent || '';
      const time = c.querySelector('[class*="FixtureItem_time__"]')?.textContent || '';
      const teamEls = [...c.querySelectorAll('[class*="FixtureItem_teamName"]')];
      // DOM order is away-team-first (the one immediately followed by "@"), home second.
      const awayTeam = teamEls[0]?.textContent?.trim() || '';
      const homeTeam = teamEls[1]?.textContent?.trim() || '';
      const channels = [...c.querySelectorAll('[class*="ChannelIcon_image"]')]
        .map((img) => img.alt)
        .filter(Boolean);
      const href = c.querySelector('a')?.getAttribute('href') || '';
      return { date, time, awayTeam, homeTeam, channels, href };
    });
  });
}

/**
 * Fetch one league's full upcoming schedule. Returns an array of raw rows
 * (channels as plain name strings — matched against iptv-org the same way
 * as every other source, by the caller in pipeline.js) or throws.
 */
async function fetchLeagueSchedule(page, slug) {
  await page.goto(`${BASE_URL}/league/${slug}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('[class*="FixtureItem_container"]', { timeout: SELECTOR_TIMEOUT_MS });
  const raw = await extractGames(page);

  const sportType = LEAGUE_SPORTS[slug] || 'Other';
  const rows = [];
  for (const g of raw) {
    if (!g.homeTeam || !g.awayTeam) continue;
    const matchDateUTC = parseGameDateTime(g.date, g.time);
    if (!matchDateUTC) continue;
    rows.push({
      eventId: `lsotv-${g.href || `${slug}-${g.homeTeam}-${g.awayTeam}-${g.date}-${g.time}`}`,
      league: slug.toUpperCase(),
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      matchDateUTC,
      sportType,
      channels: g.channels,
    });
  }
  return rows;
}

/**
 * Fetch every configured league's schedule. One shared browser + page for
 * the whole run (not relaunched per league) — same shape as
 * src/liveTv.js's fetchLiveStreams. `onProgress(done, total)` called per
 * league processed.
 */
async function fetchAllLeagues(leagueSlugs, { onProgress } = {}) {
  if (!leagueSlugs || !leagueSlugs.length) return { rows: [], failures: [] };

  const startTime = Date.now();
  const rows = [];
  const failures = [];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    return { rows: [], failures: [{ league: null, message: `browser launch failed: ${err.message}` }] };
  }

  try {
    const page = await browser.newPage();
    // Do NOT block images here — the channel logos are rendered via
    // Next.js's <Image> component, which appears to gate the final
    // <img alt="..."> (the actual channel name we need) on the image
    // request resolving; blocking it left every row's channels empty.
    // Fonts/media are still safe to block.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    for (let i = 0; i < leagueSlugs.length; i++) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        failures.push({ league: null, message: 'stopped early: time budget exceeded' });
        break;
      }
      const slug = leagueSlugs[i];
      try {
        const leagueRows = await fetchLeagueSchedule(page, slug);
        rows.push(...leagueRows);
      } catch (err) {
        failures.push({ league: slug, message: err.message });
      }
      if (onProgress) onProgress(i + 1, leagueSlugs.length);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { rows, failures };
}

module.exports = { fetchAllLeagues, fetchLeagueSchedule, parseGameDateTime, zonedTimeToUtc };
