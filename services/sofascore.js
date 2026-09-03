// Sofascore search via RapidAPI — lets the moderator match picker find
// any team/match worldwide (not just the 8 football-data.org leagues),
// as a free-text complement to the country/league cascade. Get a key at
// https://rapidapi.com and set SOFASCORE_RAPIDAPI_KEY in backend/.env.
const HOST = 'sofascore-api6.p.rapidapi.com';
const BASE = `https://${HOST}`;
const CACHE_TTL_MS = 60_000;

// Shotmap comes from a different RapidAPI host than search — same
// account/key, different provider surface (sportapi7 exposes richer
// per-event data than the sofascore-api6 search endpoint does).
const SHOTMAP_HOST = 'sportapi7.p.rapidapi.com';
const SHOTMAP_BASE = `https://${SHOTMAP_HOST}`;
const SHOTMAP_CACHE_TTL_MS = 5 * 60_000;

const cache = new Map(); // query -> { at, data }
const shotmapCache = new Map(); // `${eventId}:${teamId}` -> { at, data }

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
      home_team_id: entity.homeTeam?.id ?? null,
      away_team_id: entity.awayTeam?.id ?? null,
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

// SofaScore's shotmap shape drifts across API versions — defensively pull
// whatever's there and drop anything without usable x/y coordinates.
function normalizeShot(s) {
  const x = s.playerCoordinates?.x ?? s.x;
  const y = s.playerCoordinates?.y ?? s.y;
  if (x === undefined || x === null || y === undefined || y === null) return null;
  return {
    player: s.player?.name || s.player?.shortName || null,
    x: Number(x),
    y: Number(y),
    xg: s.xg ?? s.xG ?? s.expectedGoals ?? null,
    shotType: s.shotType || s.type || null,
    situation: s.situation || null,
    isHome: s.isHome ?? null,
    minute: s.time ?? s.minute ?? null,
  };
}

// Per-team shot chart for one event, VIP-gated (see routes/live.js).
// Cached separately from search() — different TTL, different key shape.
async function getShotmap(eventId, teamId) {
  if (!isConfigured()) {
    const err = new Error('SOFASCORE_RAPIDAPI_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }

  const cacheKey = `${eventId}:${teamId}`;
  const now = Date.now();
  const cached = shotmapCache.get(cacheKey);
  if (cached && now - cached.at < SHOTMAP_CACHE_TTL_MS) return cached.data;

  const url = `${SHOTMAP_BASE}/api/v1/event/${eventId}/shotmap/${teamId}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': SHOTMAP_HOST,
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
  const raw = json.shotmap || json.data || (Array.isArray(json) ? json : []);
  const shots = raw.map(normalizeShot).filter(Boolean);
  shotmapCache.set(cacheKey, { at: now, data: shots });
  return shots;
}

module.exports = { isConfigured, search, getShotmap };
