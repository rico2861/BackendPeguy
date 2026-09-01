const express = require('express');
const footballData = require('../services/footballData');
const oddsApi = require('../services/oddsApi');
const sofascore = require('../services/sofascore');
const COMPETITIONS = require('../services/competitions');
const Prediction = require('../models/Prediction');
const { teamsLooselyMatch } = require('../utils/normalizeTeam');
const { authenticateOptional, authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const COMPETITION_BY_CODE = new Map(COMPETITIONS.map((c) => [c.code, c]));

// Same masking principle as Prediction.maskForViewer: strip the field
// rather than blur it client-side, and say so with `locked: true` — non-VIP
// visitors (including anonymous ones) see the match but not its odds.
function maskOddsForViewer(match, viewer) {
  const isVip = viewer?.isVip || viewer?.role === 'moderator' || viewer?.role === 'admin';
  if (isVip || !match.odds) return { ...match, locked: false };
  const { odds, ...rest } = match;
  return { ...rest, odds: null, locked: true };
}

// Static country -> league list for the moderator's cascading picker
// (pays -> championnat). Doesn't touch football-data.org, so it's free
// and instant even when the API key/quota is unavailable.
router.get('/live/competitions', (req, res) => {
  res.json({ competitions: COMPETITIONS });
});

// Real upcoming/live/recent fixtures for one competition, used by the
// moderator's match picker so a prediction is built from an actual
// scheduled match (real date/time/teams) instead of free-typed data.
router.get('/live/fixtures', authenticateOptional, async (req, res) => {
  const { competition, days = 10 } = req.query;
  const comp = COMPETITION_BY_CODE.get(competition);
  if (!comp) return res.status(400).json({ error: 'Championnat inconnu.' });

  if (!footballData.isConfigured()) {
    return res.json({
      matches: [],
      message: "Aucune donnée réelle disponible : ajoutez FOOTBALL_DATA_API_KEY dans backend/.env.",
    });
  }

  try {
    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);
    const to = new Date(today);
    to.setUTCDate(to.getUTCDate() + Number(days));
    const matches = (await footballData.fetchMatchesInRange(dateFrom, to.toISOString().slice(0, 10)))
      .filter((m) => m.competition_code === competition);

    let events = null;
    if (comp.oddsSportKey && oddsApi.isConfigured()) {
      try {
        events = await oddsApi.fetchOddsForSport(comp.oddsSportKey);
      } catch {
        events = null;
      }
    }

    const enriched = matches.map((m) => ({
      ...m,
      odds: events ? oddsApi.findOddsForMatch(events, m.home_team, m.away_team) : null,
    }));

    res.json({ matches: enriched });
  } catch (err) {
    res.status(502).json({ matches: [], error: err.message });
  }
});

// Free-text worldwide team/match search (Sofascore via RapidAPI), used
// by the moderator's match picker beyond the 8 fixed football-data.org
// leagues. Moderator/admin only — not a public-facing endpoint.
router.get('/live/search', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const query = (req.query.query || '').trim();
  if (query.length < 2) return res.json({ results: [] });

  if (!sofascore.isConfigured()) {
    return res.json({ results: [], message: 'Recherche indisponible : ajoutez SOFASCORE_RAPIDAPI_KEY dans backend/.env.' });
  }

  try {
    const results = await sofascore.search(query);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ results: [], error: err.message });
  }
});

// Every real fixture on a given date across the 12 covered competitions
// (not just the ones we've published a pick on), each optionally
// carrying our own prediction when one exists and is visible to this
// viewer — powers the Matchs page's "show all matches" upcoming/finished
// views, which used to only ever show our own picks.
router.get('/live/day', authenticateOptional, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  if (!footballData.isConfigured()) {
    return res.json({
      matches: [],
      message: "Aucune donnée réelle disponible : ajoutez une clé FOOTBALL_DATA_API_KEY dans backend/.env.",
    });
  }

  let realMatches;
  try {
    realMatches = await footballData.fetchMatchesForDate(date);
  } catch (err) {
    return res.status(502).json({ matches: [], error: err.message });
  }

  const predictions = (await Prediction.listPredictions({ date })).filter((p) =>
    Prediction.isVisible(p, req.user)
  );

  const matchedPredictionIds = new Set();
  const matches = realMatches.map((m) => {
    const pred = predictions.find(
      (p) => teamsLooselyMatch(p.home_team, m.home_team) && teamsLooselyMatch(p.away_team, m.away_team)
    );
    if (pred) matchedPredictionIds.add(pred.id);
    return {
      id: pred?.id || m.id,
      country: m.country,
      league: m.league,
      flag: null,
      home_team: m.home_team,
      away_team: m.away_team,
      match_date: m.match_date,
      match_time: m.match_time,
      status: m.status,
      score_home: m.score_home,
      score_away: m.score_away,
      hasPick: !!pred,
      market: pred?.market ?? null,
      pick: pred?.pick ?? null,
      odd: pred?.odd ?? null,
      probability: pred?.probability ?? null,
      result: pred?.result ?? null,
      is_vip: pred?.is_vip ?? false,
    };
  });

  // A published pick whose match isn't in football-data.org's fixture
  // list (uncovered competition, or a name that didn't fuzzy-match)
  // must still show up — never silently drop a real, visible pick.
  for (const p of predictions) {
    if (matchedPredictionIds.has(p.id)) continue;
    matches.push({
      id: p.id,
      country: p.country,
      league: p.league,
      flag: p.flag || null,
      home_team: p.home_team,
      away_team: p.away_team,
      match_date: p.match_date,
      match_time: p.match_time,
      status: p.status,
      score_home: p.score_home ?? null,
      score_away: p.score_away ?? null,
      hasPick: true,
      market: p.market,
      pick: p.pick,
      odd: p.odd,
      probability: p.probability,
      result: p.result ?? null,
      is_vip: !!p.is_vip,
    });
  }

  res.json({ matches });
});

router.get('/live/matches', authenticateOptional, async (req, res) => {
  const status = {
    scores: { configured: footballData.isConfigured(), source: 'football-data.org' },
    odds: { configured: oddsApi.isConfigured(), source: 'the-odds-api.com' },
  };

  if (!footballData.isConfigured()) {
    return res.json({
      matches: [],
      status,
      message:
        "Aucune donnée réelle disponible : ajoutez une clé FOOTBALL_DATA_API_KEY (gratuite) dans backend/.env pour activer les scores en direct.",
    });
  }

  let matches;
  try {
    matches = await footballData.fetchTodayMatches();
  } catch (err) {
    return res.status(502).json({ matches: [], status, error: err.message });
  }

  // Only pull odds for leagues that actually have a match today, and only
  // once per league per request batch, to spend as few odds-api credits
  // as possible.
  const oddsByLeague = new Map();
  let oddsBlocked = false;
  if (oddsApi.isConfigured()) {
    const codesToday = new Set(matches.map((m) => m.competition_code).filter(Boolean));
    await Promise.all(
      Array.from(codesToday).map(async (code) => {
        const comp = COMPETITION_BY_CODE.get(code);
        if (!comp?.oddsSportKey) return;
        try {
          const events = await oddsApi.fetchOddsForSport(comp.oddsSportKey);
          oddsByLeague.set(code, events);
        } catch (err) {
          // A 403 with no useful JSON body from a corporate proxy (e.g.
          // Zscaler) means the domain itself is blocked by network
          // policy — surface that distinctly from "rate limited" or
          // "no odds for this match", which are both fine to stay silent.
          if (err.status === 403) oddsBlocked = true;
        }
      })
    );
  }

  let enriched = matches.map((m) => {
    const events = oddsByLeague.get(m.competition_code);
    const odds = events ? oddsApi.findOddsForMatch(events, m.home_team, m.away_team) : null;
    return { ...m, odds };
  });

  if (req.query.status === 'live') {
    enriched = enriched.filter((m) => m.status === 'live');
  }

  enriched = enriched.map((m) => maskOddsForViewer(m, req.user));

  if (oddsBlocked) {
    status.odds.blocked = true;
    status.odds.message =
      'the-odds-api.com est joignable mais renvoie une erreur réseau (403) — probablement bloqué par le proxy/pare-feu de ce réseau (ex. Zscaler), pas un problème de clé ou de code.';
  }

  res.json({ matches: enriched, status, count: enriched.length });
});

module.exports = router;
