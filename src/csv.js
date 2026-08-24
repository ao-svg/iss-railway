const fs = require('fs');
const path = require('path');

const MAX_SOURCES = 10;

// Column order mirrors the old Google Sheet's Source/Feed/Final tabs: one
// row per (match, channel) pair, Date/Time in Beijing to match it exactly,
// up to MAX_SOURCES candidate stream URLs per channel (Source1..Source10 —
// a channel can resolve to more than one mirror, not a strict 1:1 mapping).
// Traceability fields (EventID, Source, team split) trail at the end.
const HEADER = [
  'Date',
  'Time',
  'Match',
  'MatchZH',
  'League',
  'LeagueZH',
  'Channel',
  'Type',
  ...Array.from({ length: MAX_SOURCES }, (_, i) => `Source${i + 1}`),
  'EventID',
  'Source',
  'RawLeague',
  'HomeTeam',
  'AwayTeam',
  'MatchDateUTC',
  'Status', // 'live' | 'ended' for livetv rows; blank for scheduled fixtures
];

function escapeCsvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parse a matchDateUTC string into a Date. SportsDB rows come without a
 * timezone suffix (documented as UTC); wheresthematch rows already carry an
 * explicit offset. Normalize both into a real Date.
 */
function parseMatchDate(matchDateUTC) {
  if (!matchDateUTC) return null;
  let s = matchDateUTC.trim().replace(' ', 'T');
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const TIMEZONES = {
  beijing: 'Asia/Shanghai', // no DST, always UTC+8 — matches the reference sheet's "北京时间"
  jerusalem: 'Asia/Jerusalem', // has DST, so this needs real IANA tz data, not fixed-offset math
};

const _tzFormatters = {};
function getTzFormatter(timeZone) {
  if (!_tzFormatters[timeZone]) {
    _tzFormatters[timeZone] = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return _tzFormatters[timeZone];
}

/**
 * Format a Date in the given IANA timezone (default Beijing, matching the
 * reference sheet's "北京时间" column). `tzKey` is one of TIMEZONES' keys.
 */
function formatInTimezone(matchDateUTC, tzKey = 'beijing') {
  const d = parseMatchDate(matchDateUTC);
  if (!d) return { date: '', time: '' };
  const timeZone = TIMEZONES[tzKey] || TIMEZONES.beijing;
  const parts = getTzFormatter(timeZone).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Beijing time (UTC+8) — always used for CSV/export, regardless of any
 * timezone the web GUI is currently showing.
 */
function formatBeijing(matchDateUTC) {
  return formatInTimezone(matchDateUTC, 'beijing');
}

function matchLabel(r) {
  return r.awayTeam ? `${r.homeTeam} v ${r.awayTeam}` : r.homeTeam;
}

// Only produce a Chinese match label once every needed name is translated —
// a half-translated "曼城 v Liverpool" is worse than leaving it blank until
// the translate job catches up.
function matchLabelZH(r) {
  if (!r.homeTeamZH) return '';
  if (r.awayTeam) return r.awayTeamZH ? `${r.homeTeamZH} v ${r.awayTeamZH}` : '';
  return r.homeTeamZH;
}

function rowsToCsv(rows) {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    const { date, time } = formatBeijing(r.matchDateUTC);
    const channels = r.channels && r.channels.length ? r.channels : [{ name: '', sources: [] }];
    for (const ch of channels) {
      const sources = (ch.sources || []).slice(0, MAX_SOURCES);
      const sourceCols = Array.from({ length: MAX_SOURCES }, (_, i) => sources[i] || '');
      lines.push(
        [
          date,
          time,
          matchLabel(r),
          matchLabelZH(r),
          r.league,
          r.leagueZH || '',
          ch.name || '',
          r.sportType || '',
          ...sourceCols,
          r.eventId,
          r.source,
          r.rawLeague || '',
          r.homeTeam,
          r.awayTeam,
          r.matchDateUTC,
          r.status || '',
        ]
          .map(escapeCsvField)
          .join(',')
      );
    }
  }
  return lines.join('\n') + '\n';
}

function writeCsv(rows, outputPath) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, rowsToCsv(rows), 'utf8');
  const rowCount = rows.reduce((n, r) => n + (r.channels && r.channels.length ? r.channels.length : 1), 0);
  console.log(`[csv] wrote ${rowCount} rows (${rows.length} fixtures) -> ${outputPath}`);
}

module.exports = { rowsToCsv, writeCsv, HEADER, formatBeijing, formatInTimezone, TIMEZONES };
