const express = require('express');
const footballData = require('../services/footballData');
const oddsApi = require('../services/oddsApi');
const COMPETITIONS = require('../services/competitions');
const { authenticateOptional } = require('../middleware/auth');

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
