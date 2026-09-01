// Thin client for football-data.org (free tier: 12 top competitions,
// fixtures/results/live scores, 10 requests/minute). Get a free token at
// https://www.football-data.org/client/register and set
// FOOTBALL_DATA_API_KEY in backend/.env.
const BASE = 'https://api.football-data.org/v4';
const CACHE_TTL_MS = 45_000; // stays well under the 10 req/min free-tier cap

const rangeCache = new Map(); // "from:to" -> { at, data }

function isConfigured() {
  return !!process.env.FOOTBALL_DATA_API_KEY;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Raw range fetch, cached per exact (dateFrom, dateTo) pair. Callers
// should prefer fetchTodayMatches()/fetchRecentMatches() below, which
// pick sane, cache-friendly windows.
async function fetchMatchesInRange(dateFrom, dateTo) {
  if (!isConfigured()) {
    const err = new Error('FOOTBALL_DATA_API_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }

  const cacheKey = `${dateFrom}:${dateTo}`;
  const now = Date.now();
  const cached = rangeCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  const url = `${BASE}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`football-data.org a répondu ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const matches = (json.matches || []).map(normalizeMatch);
  rangeCache.set(cacheKey, { at: now, data: matches });
  return matches;
}

// football-data.org's /matches returns an empty list when dateFrom
// equals dateTo (same-day queries), so we always request a wider window
// and filter down ourselves.
async function fetchTodayMatches() {
  const today = new Date();
  const todayStr = isoDate(today);
  const matches = await fetchMatchesInRange(todayStr, isoDate(addDays(today, 1)));
  return matches.filter((m) => m.match_date === todayStr);
}

// Same same-day-empty-range workaround as fetchTodayMatches, for an
// arbitrary date — powers the Matchs page's "show every real fixture
// that day" view (GET /live/day), not just the ones we've published a
// pick on.
async function fetchMatchesForDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const matches = await fetchMatchesInRange(dateStr, isoDate(addDays(date, 1)));
  return matches.filter((m) => m.match_date === dateStr);
}

// Today + the last `daysBack` days — used by the prediction auto-settle
// sync so a match that finished yesterday still gets picked up today.
async function fetchRecentMatches(daysBack = 2) {
  const today = new Date();
  const matches = await fetchMatchesInRange(isoDate(addDays(today, -daysBack)), isoDate(addDays(today, 1)));
  return matches;
}

const STATUS_MAP = {
  SCHEDULED: 'upcoming',
  TIMED: 'upcoming',
  IN_PLAY: 'live',
  PAUSED: 'live',
  LIVE: 'live',
  FINISHED: 'FT',
  SUSPENDED: 'live',
  POSTPONED: 'upcoming',
  CANCELLED: 'cancelled',
  AWARDED: 'FT',
};

function normalizeMatch(m) {
  return {
    id: `fd-${m.id}`,
    source: 'football-data.org',
    competition_code: m.competition?.code,
    country: m.area?.name || m.competition?.area?.name || '',
    league: m.competition?.name || '',
    home_team: m.homeTeam?.shortName || m.homeTeam?.name,
    away_team: m.awayTeam?.shortName || m.awayTeam?.name,
    home_crest: m.homeTeam?.crest || null,
    away_crest: m.awayTeam?.crest || null,
    match_date: (m.utcDate || '').slice(0, 10),
    match_time: (m.utcDate || '').slice(11, 16),
    status: STATUS_MAP[m.status] || 'upcoming',
    raw_status: m.status,
    matchday: m.matchday ?? null,
    stage: m.stage ?? null,
    score_home: m.score?.fullTime?.home ?? null,
    score_away: m.score?.fullTime?.away ?? null,
    half_time_home: m.score?.halfTime?.home ?? null,
    half_time_away: m.score?.halfTime?.away ?? null,
    winner: m.score?.winner ?? null,
    referee: m.referees?.[0]?.name || null,
  };
}

module.exports = { isConfigured, fetchTodayMatches, fetchMatchesForDate, fetchRecentMatches, fetchMatchesInRange };
