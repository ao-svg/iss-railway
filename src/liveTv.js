// "What's live right now" source. Domain is entirely operator-configured
// (LIVETV_DOMAIN / config.liveTvDomain, empty = feature disabled) since this
// kind of live-sports aggregator site rotates domains — pointing this at any
// particular domain is a deliberate choice made by whoever configures it,
// not something this code defaults to.
//
// For each live game found, every stream link on its page is classified:
//   - 'youtube': a youtube.com/watch?v=ID link. Its uploading channel is
//     looked up via YouTube's own public oEmbed endpoint (no scraping, no
//     API key) and checked against a manual allowlist (youtubeChannels.js).
//     oEmbed only tells us WHO uploaded it, never whether they're
//     authorized to broadcast the content — that's why a human has to
//     approve each channel once before its videos count as usable.
//   - 'other': anything else. Deliberately NOT resolved any further — the
//     original mechanism for this (fetch a webplayer wrapper page, scrape
//     whatever third-party CDN iframe it points to) is exactly the
//     pirate-mirror-resolution pattern this project has consistently
//     declined to port. 'other' entries are counted so you know a stream
//     exists, but no URL for it is ever produced or stored.

const axios = require('axios');
const youtubeChannels = require('./youtubeChannels');
const { splitTeams } = require('./teamSplit');
const leagues = require('./leagues');
const translate = require('./translate');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
};
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RUNTIME_MS = 4.5 * 60 * 1000;
const SITE_GMT_OFFSET = 1; // hours; the source site displays times in this zone

const SPORTS = [
  { id: 1, name: 'Football' },
  { id: 3, name: 'Basketball' },
  { id: 2, name: 'Ice Hockey' },
  { id: 4, name: 'Tennis' },
  { id: 5, name: 'Volleyball' },
  { id: 13, name: 'Handball' },
  { id: 22, name: 'Water Polo' },
  { id: 30, name: 'Darts' },
  { id: 39, name: 'Table Tennis' },
  { id: 40, name: 'Cycling' },
  { id: 41, name: 'Cricket' },
  { id: 48, name: 'Weightlifting' },
  { id: 31, name: 'Badminton' },
  { id: 7, name: 'Racing' },
  { id: 33, name: 'Rugby Union' },
  { id: 17, name: 'Rugby League' },
  { id: 38, name: 'Field Hockey' },
  { id: 9, name: 'Athletics' },
  { id: 19, name: 'Baseball' },
  { id: 27, name: 'American Football' },
  { id: 21, name: 'Beach Volleyball' },
  { id: 52, name: 'Aussie Rules' },
  { id: 12, name: 'Futsal' },
  { id: 37, name: 'Golf' },
  { id: 29, name: 'Billiard' },
  { id: 58, name: 'Gymnastics' },
];

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  return text
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '');
}

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
    return res.status === 200 ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * Convert the site's local date/time text into a UTC ISO string.
 * `dateStr` like "24 Aug", `timeStr` like "18:30" — or just a bare time
 * (today, or tomorrow if it's already past in the site's zone).
 */
function convertDateTime(dateStr, timeStr) {
  try {
    if (dateStr) {
      const year = new Date().getUTCFullYear();
      const sign = SITE_GMT_OFFSET >= 0 ? '+' : '-';
      const off = String(Math.abs(SITE_GMT_OFFSET)).padStart(2, '0');
      const d = new Date(`${dateStr} ${year} ${timeStr} GMT${sign}${off}00`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    const siteNowHour = now.getUTCHours() + SITE_GMT_OFFSET;
    let dayOffset = 0;
    if (h < siteNowHour - 12) dayOffset = 1; // time already passed today in site zone -> tomorrow
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h - SITE_GMT_OFFSET, m || 0)
    );
    return d.toISOString();
  } catch {
    return null;
  }
}

async function fetchGameList(domain, sportId, sportName) {
  const html = await fetchHtml(`${domain}/enx/allupcomingsports/${sportId}/`);
  if (!html) return null;

  const games = [];
  const parts = html.split('<a class="live"');

  for (let p = 1; p < parts.length; p++) {
    const chunk = parts[p];
    if (chunk.indexOf('/img/live.gif') === -1) continue; // only currently-live games

    const hrefMatch = chunk.match(/href="(\/enx\/eventinfo\/[^"]+)"/);
    if (!hrefMatch) continue;

    const nameMatch = chunk.match(/^[^>]*>([\s\S]*?)<\/a>/);
    if (!nameMatch) continue;
    const name = decodeEntities(stripTags(nameMatch[1]));
    if (!name) continue;

    const descMatch = chunk.match(/<span class="evdesc">([\s\S]*?)<\/span>/);
    if (!descMatch) continue;
    const descText = decodeEntities(stripTags(descMatch[1]));

    const leagueM = descText.match(/\(([^)]+)\)/);
    const league = leagueM ? leagueM[1].trim() : '';

    const fullDT = descText.match(/(\d{1,2}\s+\w+)\s+at\s+([\d:]+)/i);
    const timeOnly = descText.match(/^([\d:]+)/);

    let isoDate = null;
    if (fullDT) isoDate = convertDateTime(fullDT[1], fullDT[2]);
    else if (timeOnly) isoDate = convertDateTime(null, timeOnly[1]);
    if (!isoDate) continue;

    games.push({
      sport: sportName,
      league,
      matchName: name,
      isoDate,
      eventUrl: domain + hrefMatch[1],
    });
  }

  return games;
}

/**
 * Classify every stream link on a live game's event page. Returns
 * { youtubeIds: string[], otherCount: number } — 'other' links are counted,
 * never resolved to an actual URL (see module comment).
 */
async function fetchStreamRefs(eventUrl) {
  const html = await fetchHtml(eventUrl);
  if (!html || html.indexOf('LiveStreams are currently not available') !== -1) {
    return { youtubeIds: [], otherCount: 0 };
  }

  const start = html.indexOf('id="links_block"');
  if (start === -1) return { youtubeIds: [], otherCount: 0 };
  const chunk = html.substring(start, start + 15000);

  const seenKeys = new Set();
  const youtubeIds = [];
  let otherCount = 0;

  function record(type, id) {
    const key = `${type}|${id}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    if (type === 'youtube') youtubeIds.push(id);
    else otherCount++;
  }

  const wpRe = /show_webplayer\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let m;
  while ((m = wpRe.exec(chunk)) !== null) record(m[1], m[2]);

  // webplayer.php / webplayer2.php hrefs carry the same t=/c= params
  const hrefRe = /webplayer2?\.php\?([^"'\s]+)/g;
  while ((m = hrefRe.exec(chunk)) !== null) {
    const params = new URLSearchParams(m[1]);
    const t = params.get('t');
    const c = params.get('c');
    if (t && c) record(t, c);
  }

  return { youtubeIds, otherCount };
}

/**
 * Look up a YouTube video's uploading channel via the public oEmbed
 * endpoint. Returns { channelName, channelUrl, title } or null if the
 * lookup fails (video removed/private/etc).
 */
async function lookupYouTubeVideo(videoId) {
  try {
    const res = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return {
      channelName: res.data.author_name,
      channelUrl: res.data.author_url,
      title: res.data.title,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch every currently-live game across all sports, with classified
 * streams. `onProgress(done, total)` called per sport processed.
 */
async function fetchLiveStreams(domain, { onProgress } = {}) {
  if (!domain) {
    return { rows: [], failures: [{ sport: null, message: 'liveTvDomain not configured' }], successfulSports: new Set() };
  }

  const startTime = Date.now();
  const rows = [];
  const failures = [];
  const seenEventUrls = new Set();
  // Sports whose game-list fetch itself succeeded this round (regardless of
  // whether it found 0 or more live games) — distinct from a fetch that
  // threw/failed. liveTvStore.js needs this to tell "confirmed not live
  // anymore" apart from "we just didn't get a look this round".
  const successfulSports = new Set();

  for (let s = 0; s < SPORTS.length; s++) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      failures.push({ sport: null, message: 'stopped early: time budget exceeded' });
      break;
    }

    const sport = SPORTS[s];
    let games;
    let alreadyRecordedFailure = false;
    try {
      games = await fetchGameList(domain, sport.id, sport.name);
    } catch (err) {
      games = null;
      failures.push({ sport: sport.name, message: err.message });
      alreadyRecordedFailure = true;
    }
    if (games !== null) {
      successfulSports.add(sport.name);
    } else if (!alreadyRecordedFailure) {
      // fetchGameList can also return null "softly" (fetchHtml swallowed a
      // non-200/network error) without throwing — make sure that shows up
      // as a failure too, not just the thrown-exception case above.
      failures.push({ sport: sport.name, message: 'fetch failed' });
    }
    if (onProgress) onProgress(s + 1, SPORTS.length);
    if (!games || !games.length) continue;

    for (const game of games) {
      if (seenEventUrls.has(game.eventUrl)) continue;
      seenEventUrls.add(game.eventUrl);

      let refs;
      try {
        refs = await fetchStreamRefs(game.eventUrl);
      } catch (err) {
        failures.push({ sport: sport.name, message: `${game.matchName}: ${err.message}` });
        continue;
      }
      if (!refs.youtubeIds.length && !refs.otherCount) continue;

      const channels = [];
      for (const videoId of refs.youtubeIds) {
        const info = await lookupYouTubeVideo(videoId);
        if (!info) continue;
        youtubeChannels.recordChannelSeen(info.channelUrl, info.channelName, info.title);
        channels.push({
          type: 'youtube',
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          channelName: info.channelName,
          channelUrl: info.channelUrl,
          title: info.title,
          approved: youtubeChannels.isApproved(info.channelUrl),
        });
      }
      for (let i = 0; i < refs.otherCount; i++) {
        channels.push({ type: 'other' });
      }

      rows.push({
        eventId: `livetv-${game.eventUrl}`,
        sportType: game.sport,
        league: game.league,
        matchName: game.matchName,
        matchDateUTC: game.isoDate,
        channels,
      });
    }
  }

  return { rows, failures, successfulSports };
}

function normalizeLiveChannel(ch) {
  if (ch.type === 'other') return { name: 'Other source (not shown)', sources: [] };
  if (ch.approved) return { name: ch.channelName || '', sources: [ch.url] };
  return { name: `${ch.channelName || 'Unknown channel'} (pending review)`, sources: [] };
}

/**
 * Normalize one status-tagged liveTvStore row into the same shape
 * src/csv.js's rowsToCsv() expects — the same shape the main pipeline's
 * rows are in. Deps are injectable so this is testable with fakes, without
 * touching the real translation/league cache files.
 */
function normalizeLiveRow(row, { canonicalLeague = leagues.canonicalLeague, getTranslation = translate.getCached } = {}) {
  const { homeTeam, awayTeam } = splitTeams(row.matchName);
  const league = canonicalLeague(row.league);
  return {
    eventId: row.eventId,
    rawLeague: row.league,
    league,
    leagueZH: getTranslation(league)?.zh || null,
    homeTeam,
    homeTeamZH: getTranslation(homeTeam)?.zh || null,
    awayTeam,
    awayTeamZH: awayTeam ? getTranslation(awayTeam)?.zh || null : null,
    matchDateUTC: row.matchDateUTC,
    sportType: row.sportType,
    source: 'livetv',
    status: row.status,
    channels: (row.channels || []).map(normalizeLiveChannel),
  };
}

function normalizeLiveRows(rows, deps) {
  return rows.map((r) => normalizeLiveRow(r, deps));
}

module.exports = { fetchLiveStreams, lookupYouTubeVideo, SPORTS, normalizeLiveRow, normalizeLiveRows };
