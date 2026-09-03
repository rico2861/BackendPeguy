// SoccersAPI (soccersapi.com) — a second fixtures source alongside
// football-data.org, added specifically for leagues football-data.org's
// free tier doesn't expose (Europa League, Conference League, Turkey,
// 2nd divisions...). Which leagues are actually usable depends entirely
// on the account's plan (admin.soccersapi.com/leagues) — the Free Plan
// only unlocks 3 unrelated leagues; a paid plan lets you pick the ones
// you actually want.
//
// The Free Plan caps out at 100 requests/DAY (not per-minute like
// football-data.org's 10/min) — there's no bulk date-range endpoint, only
// one fixture-list call per (league, single date), so every cache here is
// long-lived on purpose to avoid burning the daily quota on a handful of
// page loads.
const BASE = 'https://api.soccersapi.com/v2.2';

function isConfigured() {
  return !!(process.env.SOCCERSAPI_USER && process.env.SOCCERSAPI_TOKEN);
}

function authParams() {
  return `user=${encodeURIComponent(process.env.SOCCERSAPI_USER)}&token=${encodeURIComponent(process.env.SOCCERSAPI_TOKEN)}`;
}

let leaguesCache = { at: 0, data: null };
const LEAGUES_TTL_MS = 6 * 60 * 60 * 1000; // 6h — the league list rarely changes

async function listLeagues() {
  if (!isConfigured()) return [];
  if (leaguesCache.data && Date.now() - leaguesCache.at < LEAGUES_TTL_MS) return leaguesCache.data;
  const res = await fetch(`${BASE}/leagues/?${authParams()}&t=list`);
  if (!res.ok) throw new Error(`SoccersAPI a répondu ${res.status}.`);
  const json = await res.json();
  const leagues = (json.data || []).map((l) => ({
    code: `SA-${l.id}`,
    country: l.country?.name || '',
    league: l.name,
    source: 'soccersapi',
    leagueId: l.id,
  }));
  leaguesCache = { at: Date.now(), data: leagues };
  return leagues;
}

const fixturesCache = new Map(); // "leagueId:date" -> { at, data }
const FIXTURES_TTL_MS = 30 * 60 * 1000; // 30 min — conserves the 100 req/day quota

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchFixturesForDate(leagueId, date) {
  const key = `${leagueId}:${date}`;
  const cached = fixturesCache.get(key);
  if (cached && Date.now() - cached.at < FIXTURES_TTL_MS) return cached.data;
  const res = await fetch(`${BASE}/fixtures/?${authParams()}&t=schedule&d=${date}&league_id=${leagueId}`);
  if (!res.ok) throw new Error(`SoccersAPI a répondu ${res.status}.`);
  const json = await res.json();
  const matches = (json.data || []).map((m) => ({
    id: `sa-${m.id}`,
    country: m.league?.country_name || '',
    league: m.league?.name || '',
    home_team: m.teams?.home?.name,
    away_team: m.teams?.away?.name,
    match_date: m.time?.date,
    match_time: (m.time?.time || '').slice(0, 5),
    status: m.status_name === 'Finished' ? 'FT' : m.status === 1 ? 'live' : 'upcoming',
  }));
  fixturesCache.set(key, { at: Date.now(), data: matches });
  return matches;
}

// No bulk range endpoint on this API — capped at 5 days (not the usual
// 10) specifically to keep a single picker load from eating a big chunk
// of the 100/day free-tier quota across several leagues at once.
const MAX_RANGE_DAYS = 5;

async function fetchFixturesForLeagueRange(leagueId, days) {
  if (!isConfigured()) {
    const err = new Error('SOCCERSAPI_USER/SOCCERSAPI_TOKEN manquant.');
    err.notConfigured = true;
    throw err;
  }
  const span = Math.min(Number(days) || MAX_RANGE_DAYS, MAX_RANGE_DAYS);
  const today = new Date();
  const perDay = await Promise.all(
    Array.from({ length: span }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + i);
      return fetchFixturesForDate(leagueId, isoDate(d));
    })
  );
  return perDay.flat();
}

module.exports = { isConfigured, listLeagues, fetchFixturesForLeagueRange };
