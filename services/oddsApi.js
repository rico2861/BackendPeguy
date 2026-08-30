// Thin client for The Odds API (free tier: 500 credits/month, no card
// required). Get a free key at https://the-odds-api.com and set
// ODDS_API_KEY in backend/.env. Each call below costs ~1 credit per
// league queried, so results are cached hard and only fetched for
// leagues that actually have a match today.
const { normalizeTeam } = require('../utils/normalizeTeam');

const BASE = 'https://api.the-odds-api.com/v4';
const CACHE_TTL_MS = 10 * 60_000; // 10 min - keeps monthly credit usage sane

const cache = new Map(); // sportKey -> { at, data }

function isConfigured() {
  return !!process.env.ODDS_API_KEY;
}

async function fetchOddsForSport(sportKey) {
  if (!isConfigured()) {
    const err = new Error('ODDS_API_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }
  const now = Date.now();
  const cached = cache.get(sportKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`the-odds-api.com a repondu ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  cache.set(sportKey, { at: now, data: json });
  return json;
}

// Best-effort match: The Odds API and football-data.org don't share IDs,
// so we pair events by normalized home/away team name within the same
// sport/league.
function findOddsForMatch(oddsEvents, homeTeam, awayTeam) {
  if (!oddsEvents?.length) return null;
  const h = normalizeTeam(homeTeam);
  const a = normalizeTeam(awayTeam);
  const event = oddsEvents.find((e) => {
    const eh = normalizeTeam(e.home_team);
    const ea = normalizeTeam(e.away_team);
    return (eh.includes(h) || h.includes(eh)) && (ea.includes(a) || a.includes(ea));
  });
  if (!event) return null;

  const bookmaker = event.bookmakers?.[0];
  const market = bookmaker?.markets?.find((m) => m.key === 'h2h');
  if (!market) return null;

  const outcome = (name) => market.outcomes.find((o) => normalizeTeam(o.name) === normalizeTeam(name))?.price ?? null;
  return {
    bookmaker: bookmaker.title,
    home: outcome(event.home_team),
    draw: market.outcomes.find((o) => o.name.toLowerCase() === 'draw')?.price ?? null,
    away: outcome(event.away_team),
  };
}

module.exports = { isConfigured, fetchOddsForSport, findOddsForMatch };
