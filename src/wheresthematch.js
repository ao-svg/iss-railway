// Second fixture source, ported from the old Google Apps Script pipeline's
// scrapeWheresMatch(). Scrapes the public live-sport-on-tv schedule page —
// broadcaster NAMES only, same as sportsdb.js. Actual stream URLs still come
// from the public iptv-org index (see iptv.js), never from the old script's
// pirate-mirror "channels" sheet, which was deliberately not ported.

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

function extractByClass(html, className) {
  const m = html.match(new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[a-z]+>`, 'i'));
  return m ? m[1] : null;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractChannel(rowHtml) {
  const sectionMatch = rowHtml.match(/class="[^"]*channel-details[^"]*"[^>]*>([\s\S]*?)(?:<\/td>|<\/div>)/i);
  if (!sectionMatch) return null;
  const section = sectionMatch[1];
  const imgRegex = /<img[^>]*>/gi;
  let img;
  while ((img = imgRegex.exec(section)) !== null) {
    const titleMatch = img[0].match(/title\s*=\s*["']([^"']+)['"]/i);
    if (titleMatch) return titleMatch[1].trim();
  }
  return null;
}

const TYPE_ICON_MAP = [
  ['tennis', 'Tennis'],
  ['cricket', 'Cricket'],
  ['horseracing', 'Horse Racing'],
  ['football', 'Football'],
  ['soccer', 'Football'],
  ['basketball', 'Basketball'],
  ['rugby', 'Rugby'],
  ['baseball', 'Baseball'],
  ['golf', 'Golf'],
  ['boxing', 'Boxing'],
  ['motorsport', 'Motorsport'],
  ['motogp', 'Motorsport'],
  ['cycling', 'Cycling'],
  ['snooker', 'Snooker'],
  ['darts', 'Darts'],
  ['icehockey', 'Ice Hockey'],
  ['americanfootball', 'American Football'],
  ['aussierules', 'Australian Rules'],
  ['netball', 'Netball'],
];

function detectType(rowHtml, matchName, league) {
  const iconMatch = rowHtml.match(/(?:src|data-src)="([^"]*\/images\/sports\/[^"]+)"/i);
  if (iconMatch) {
    const src = iconMatch[1];
    const hit = TYPE_ICON_MAP.find(([needle]) => src.includes(needle));
    if (hit) return hit[1];
  }
  const text = `${matchName} ${league}`.toLowerCase();
  if (/premier league|champions league|europa league|la liga|serie a|bundesliga|ligue 1|fa cup/.test(text)) return 'Football';
  if (/atp|wta|wimbledon|grand slam|french open|us open/.test(text)) return 'Tennis';
  if (/cricket|ipl|t20|odi/.test(text)) return 'Cricket';
  if (/nba|euroleague|basketball/.test(text)) return 'Basketball';
  if (/formula|f1|motogp|nascar|rally/.test(text)) return 'Motorsport';
  return 'Other';
}

/**
 * Scrape wheresthematch.com's public schedule for the next `days` days.
 * Returns raw rows: { date, time, matchName, league, channel, type, isoDate }
 */
async function fetchSchedule(days = 31) {
  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);
  const url = `${BASE_URL}?showdatestart=${formatDate(startDate)}&showdateend=${formatDate(endDate)}`;

  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });

  const rows = [];
  const rowRegex = /<tr[^>]*itemscope[^>]*itemtype\s*=\s*["']https:\/\/schema\.org\/BroadcastEvent["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const rowHtml = m[1];

    const dtMatch = rowHtml.match(/content\s*=\s*["'](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"']*)['"]/i);
    if (!dtMatch) continue;
    const isoDate = dtMatch[1];

    const fixtureHtml = extractByClass(rowHtml, 'fixture-details');
    if (!fixtureHtml) continue;
    const matchName = stripTags(fixtureHtml).replace(/\s+v\s+/i, ' v ').trim();
    if (!matchName) continue;

    const leagueHtml = extractByClass(rowHtml, 'competition-name');
    const league = leagueHtml ? stripTags(leagueHtml).trim() : '';

    const channel = extractChannel(rowHtml);
    if (!channel) continue;

    const type = detectType(rowHtml, matchName, league);
    rows.push({ isoDate, matchName, league, channel, type });
  }

  return rows;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Normalize a raw scraped row into the same shape sportsdb.normalizeEvent() produces.
 */
function normalizeRow(raw) {
  const parts = raw.matchName.split(/\s+v\s+/i);
  const homeTeam = parts[0] ? parts[0].trim() : raw.matchName;
  const awayTeam = parts[1] ? parts[1].trim() : '';
  return {
    eventId: `wtm-${raw.isoDate}-${slugify(raw.matchName)}`,
    league: raw.league,
    homeTeam,
    awayTeam,
    homeLogo: '',
    awayLogo: '',
    matchDateUTC: raw.isoDate,
    channelName: raw.channel,
  };
}

module.exports = { fetchSchedule, normalizeRow };
