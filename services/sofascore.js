// Sofascore search via RapidAPI — lets the moderator match picker find
// any team/match worldwide (not just the 8 football-data.org leagues),
// as a free-text complement to the country/league cascade. Get a key at
// https://rapidapi.com and set SOFASCORE_RAPIDAPI_KEY in backend/.env.
const HOST = 'sofascore-api6.p.rapidapi.com';
const BASE = `https://${HOST}`;
const CACHE_TTL_MS = 60_000;

const cache = new Map(); // query -> { at, data }

function isConfigured() {
  return !!process.env.SOFASCORE_RAPIDAPI_KEY;
}

function unixToDateTime(ts) {
  if (!ts) return { date: null, time: null };
  const d = new Date(ts * 1000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

// Sofascore's search results mix teams, tournaments and events in one
// list. We only care about entries that can seed a prediction (events
// give the full match; teams alone just seed the team name), so this
// normalizes both shapes defensively — the exact field set isn't
// guaranteed to stay stable across the provider's own versions.
function normalizeResult(r) {
  const type = r.type || r.entity?.type;
  const entity = r.entity || r;

  if (type === 'event' || (entity.homeTeam && entity.awayTeam)) {
    const { date, time } = unixToDateTime(entity.startTimestamp);
    return {
      kind: 'match',
      id: entity.id,
      country: entity.tournament?.category?.name || '',
      league: entity.tournament?.name || '',
      home_team: entity.homeTeam?.name || entity.homeTeam?.shortName,
      away_team: entity.awayTeam?.name || entity.awayTeam?.shortName,
      match_date: date,
      match_time: time,
    };
  }

  if (type === 'team' || entity.sport) {
    return {
      kind: 'team',
      id: entity.id,
      name: entity.name || entity.shortName,
      country: entity.country?.name || '',
    };
  }

  return null;
}

async function search(query) {
  if (!isConfigured()) {
    const err = new Error('SOFASCORE_RAPIDAPI_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }

  const cacheKey = query.trim().toLowerCase();
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  const url = `${BASE}/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': HOST,
      'x-rapidapi-key': process.env.SOFASCORE_RAPIDAPI_KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Sofascore (RapidAPI) a répondu ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const raw = json.results || json.data || (Array.isArray(json) ? json : []);
  const results = raw.map(normalizeResult).filter(Boolean);
  cache.set(cacheKey, { at: now, data: results });
  return results;
}

module.exports = { isConfigured, search };
