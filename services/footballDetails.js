// Match statistics (possession, shots, cards, corners...) via RapidAPI
// product "the-fooball-api" — yes, that's really the host's spelling, do
// not "fix" it. Separate RapidAPI product/subscription from Sofascore, so
// it gets its own env var: FOOTBALL_DETAILS_RAPIDAPI_KEY (backend/.env).
//
// This provider's match id is NOT a Sofascore event id and this codebase
// has no lookup to resolve one from the other — a prediction must carry
// its own `external_match_id` (see models/Prediction.js) set by hand by
// whoever publishes the pick.
const HOST = 'the-fooball-api.p.rapidapi.com';
const BASE = `https://${HOST}`;
const CACHE_TTL_MS = 5 * 60_000;

const cache = new Map(); // matchId -> { at, data }

function isConfigured() {
  return !!process.env.FOOTBALL_DETAILS_RAPIDAPI_KEY;
}

// Per-match statistics, VIP-gated (see routes/live.js). Cached in-memory
// like sofascore.js's getShotmap — same TTL, same defensive error handling.
async function getMatchDetails(matchId) {
  if (!isConfigured()) {
    const err = new Error('FOOTBALL_DETAILS_RAPIDAPI_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }

  const cacheKey = String(matchId);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  const url = `${BASE}/football/match_details/${encodeURIComponent(matchId)}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': HOST,
      'x-rapidapi-key': process.env.FOOTBALL_DETAILS_RAPIDAPI_KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`the-fooball-api (RapidAPI) a répondu ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const data = json.response || json.data || json.result || json;
  cache.set(cacheKey, { at: now, data });
  return data;
}

module.exports = { isConfigured, getMatchDetails };
