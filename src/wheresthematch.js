// Second fixture source, ported from the old Google Apps Script pipeline's
// scrapeWheresMatch(). Scrapes the public live-sport-on-tv schedule page —
// broadcaster NAMES only, same as sportsdb.js. Actual stream URLs still come
// from the public iptv-org index (see iptv.js), never from the old script's
// pirate-mirror "channels" sheet, which was deliberately not ported.
//
// The site was redesigned since the old script was written: the old
// itemscope/itemtype HTML table markup is gone, replaced by a per-day
// JSON-LD <script type="application/ld+json"> block (schema.org ItemList),
// capped at 20 events per day. So instead of one range request, this fetches
// one request per day and aggregates.

const axios = require('axios');

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

async function fetchDay(dateStr) {
  const url = `${BASE_URL}?showdatestart=${dateStr}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });

  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return [];

  let json;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return [];
  }

  const items = Array.isArray(json.itemListElement) ? json.itemListElement : [];
  const rows = [];

  for (const li of items) {
    const item = li.item;
    if (!item || !item.name || !item.startDate) continue;

    const broadcast = Array.isArray(item.publication) ? item.publication[0] : null;
    const channel = broadcast && broadcast.publishedOn ? broadcast.publishedOn.name : null;
    if (!channel) continue;

    rows.push({
      isoDate: item.startDate,
      matchName: item.name,
      league: item.description || '',
      channel,
      homeTeam: item.homeTeam ? item.homeTeam.name : null,
      awayTeam: item.awayTeam ? item.awayTeam.name : null,
    });
  }

  return rows;
}

/**
 * Scrape wheresthematch.com's public schedule for the next `days` days.
 * One request per day (the site paginates by day and caps at 20 events/day).
 * Returns raw rows: { isoDate, matchName, league, channel, homeTeam, awayTeam }
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

// The JSON-LD has no explicit sport field, so fall back to keyword matching
// against the league/description text (mirrors the old scraper's text-based
// fallback for when it couldn't find a sport icon).
const SPORT_KEYWORDS = [
  [/premier league|champions league|europa league|la liga|serie a|bundesliga|ligue 1|fa cup|football|soccer/i, 'Football'],
  [/atp|wta|wimbledon|grand slam|french open|us open|tennis/i, 'Tennis'],
  [/cricket|ipl|t20|odi/i, 'Cricket'],
  [/nba|euroleague|basketball/i, 'Basketball'],
  [/formula|f1|motogp|nascar|rally|motorsport/i, 'Motorsport'],
  [/cycling|tour de|vuelta|giro|uci/i, 'Cycling'],
  [/golf|pga|masters|ryder cup/i, 'Golf'],
  [/snooker/i, 'Snooker'],
  [/darts|pdc/i, 'Darts'],
  [/rugby|nrl|super league/i, 'Rugby'],
  [/boxing|ufc|mma/i, 'Boxing'],
  [/race meeting|racing|horse/i, 'Horse Racing'],
  [/baseball|mlb/i, 'Baseball'],
  [/nhl|ice hockey/i, 'Ice Hockey'],
  [/afl|aussie rules|australian rules/i, 'Australian Rules'],
  [/athletics/i, 'Athletics'],
];

function detectSportType(matchName, league) {
  const text = `${matchName} ${league}`;
  const hit = SPORT_KEYWORDS.find(([re]) => re.test(text));
  return hit ? hit[1] : 'Other';
}

/**
 * Normalize a raw scraped row into the same shape sportsdb.normalizeEvent() produces.
 */
function normalizeRow(raw) {
  let homeTeam = raw.homeTeam;
  let awayTeam = raw.awayTeam;
  if (!homeTeam) {
    const parts = raw.matchName.split(/\s+v\s+/i);
    homeTeam = parts[0] ? parts[0].trim() : raw.matchName;
    awayTeam = parts[1] ? parts[1].trim() : '';
  }
  return {
    eventId: `wtm-${raw.isoDate}-${slugify(raw.matchName)}`,
    league: raw.league,
    homeTeam,
    awayTeam: awayTeam || '',
    homeLogo: '',
    awayLogo: '',
    matchDateUTC: raw.isoDate,
    channelName: raw.channel,
    sportType: detectSportType(raw.matchName, raw.league),
  };
}

module.exports = { fetchSchedule, normalizeRow };
