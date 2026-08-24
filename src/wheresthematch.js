// Second fixture source, ported from the old Google Apps Script pipeline's
// scrapeWheresMatch(). Scrapes the public live-sport-on-tv schedule page —
// broadcaster NAMES only, same as sportsdb.js. Actual stream URLs still come
// from the public iptv-org index (see iptv.js), never from the old script's
// pirate-mirror "channels" sheet, which was deliberately not ported.
//
// The site's markup changed since the old script was written: the old
// itemscope/itemtype attributes are gone. There's now also a per-day JSON-LD
// <script type="application/ld+json"> block, but it's capped at 20 events
// and only reflects the single start date even when a date range is
// requested — a red herring. The real, fuller data is still a classic HTML
// table (<tr class="fixture-details">...), just restyled with a
// <time class="sr-only" datetime="..."> instead of microdata. That table is
// also capped (~1 request only reliably covers a handful of days even with
// showdatestart/showdateend spanning more), so this still fetches one
// request per day and aggregates — but each request now yields every
// broadcaster for an event, not just the first one.

const axios = require('axios');
const { splitTeams } = require('./teamSplit');

const BASE_URL = 'https://www.wheresthematch.com/live-sport-on-tv/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const SPORT_ICON_MAP = {
  football: 'Football',
  soccer: 'Football',
  tennis: 'Tennis',
  cricket: 'Cricket',
  basketball: 'Basketball',
  rugby: 'Rugby',
  rugbyleague: 'Rugby',
  rugbyunion: 'Rugby',
  baseball: 'Baseball',
  golf: 'Golf',
  boxing: 'Boxing',
  motorsport: 'Motorsport',
  motogp: 'Motorsport',
  f1: 'Motorsport',
  cycling: 'Cycling',
  snooker: 'Snooker',
  darts: 'Darts',
  icehockey: 'Ice Hockey',
  americanfootball: 'American Football',
  aussierules: 'Australian Rules',
  netball: 'Netball',
  horseracing: 'Horse Racing',
  athletics: 'Athletics',
  ufc: 'UFC/MMA',
  wrestling: 'Wrestling',
  hockey: 'Hockey',
  gymnastics: 'Gymnastics',
};

async function fetchDay(dateStr) {
  const url = `${BASE_URL}?showdatestart=${dateStr}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });

  const rows = [];
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    if (!rowHtml.includes('fixture-details')) continue;

    const dtMatch = rowHtml.match(/<time class="sr-only" datetime="([^"]+)"/);
    if (!dtMatch) continue;
    const isoDate = dtMatch[1];

    const fixtureMatch = rowHtml.match(/class="fixture">([\s\S]*?)<\/span>/);
    if (!fixtureMatch) continue;
    const matchName = stripTags(fixtureMatch[1]).replace(/\s+v\s+/i, ' v ').trim();
    if (!matchName) continue;

    const leagueMatch = rowHtml.match(/class="competition-name">[\s\S]*?<span>([^<]*)<\/span>/);
    const league = leagueMatch ? leagueMatch[1].trim() : '';

    const sportMatch = rowHtml.match(/class="competition-name"><img[^>]*src="[^"]*\/sports\/([a-zA-Z-]+)\.gif"/);
    const sportSlug = sportMatch ? sportMatch[1].toLowerCase().replace(/-/g, '') : '';
    const sportType = SPORT_ICON_MAP[sportSlug] || 'Other';

    const channelBlockMatch = rowHtml.match(/class="channel-details">([\s\S]*?)<\/td>/);
    const channels = channelBlockMatch
      ? [...channelBlockMatch[1].matchAll(/class="sr-only">([^<]+)<\/span>/g)].map((m) => m[1].trim())
      : [];
    if (!channels.length) continue;

    rows.push({ isoDate, matchName, league, channels: [...new Set(channels)], sportType });
  }

  return rows;
}

/**
 * Scrape wheresthematch.com's public schedule for the next `days` days.
 * One request per day — see the module comment for why.
 * Returns raw rows: { isoDate, matchName, league, channels, sportType }
 */
async function fetchSchedule(days = 31) {
  const rows = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = formatDate(d);
    try {
      const dayRows = await fetchDay(dateStr);
      rows.push(...dayRows);
    } catch (err) {
      console.error(`[wheresthematch] day ${dateStr} failed: ${err.message}`);
    }
    if (i < days - 1) await sleep(250);
  }

  return rows;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Normalize a raw scraped row into the same shape sportsdb.normalizeEvent() produces.
 * channels stays as its own array — pipeline.js matches it against iptv-org directly,
 * same as it does with sportsdb's per-event channel list.
 */
function normalizeRow(raw) {
  const { homeTeam, awayTeam } = splitTeams(raw.matchName);
  return {
    eventId: `wtm-${raw.isoDate}-${slugify(raw.matchName)}`,
    league: raw.league,
    homeTeam,
    awayTeam,
    homeLogo: '',
    awayLogo: '',
    matchDateUTC: raw.isoDate,
    sportType: raw.sportType,
    channels: raw.channels,
  };
}

module.exports = { fetchSchedule, normalizeRow };
