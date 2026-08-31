const crypto = require('crypto');
const { readPredictions, writePredictions } = require('../db');
const { evaluatePick } = require('../services/settlement');

function nowIso() {
  return new Date().toISOString();
}

async function listPredictions({ date, league, country, market, q, ticketType } = {}) {
  let preds = await readPredictions();
  if (date) preds = preds.filter((p) => p.match_date === date);
  if (league) preds = preds.filter((p) => p.league === league);
  if (country) preds = preds.filter((p) => p.country === country);
  if (market) preds = preds.filter((p) => p.market === market);
  if (ticketType) preds = preds.filter((p) => p.ticket_type === ticketType);
  if (q) {
    const needle = q.toLowerCase();
    preds = preds.filter(
      (p) =>
        p.home_team.toLowerCase().includes(needle) ||
        p.away_team.toLowerCase().includes(needle) ||
        p.league.toLowerCase().includes(needle)
    );
  }
  return [...preds].sort((a, b) =>
    a.match_date === b.match_date
      ? a.match_time.localeCompare(b.match_time)
      : a.match_date.localeCompare(b.match_date)
  );
}

async function getPrediction(id) {
  const preds = await readPredictions();
  return preds.find((p) => p.id === id) || null;
}

async function listLeagues() {
  const preds = await readPredictions();
  const seen = new Map();
  for (const p of preds) {
    const key = `${p.country}-${p.league}`;
    if (!seen.has(key)) seen.set(key, { country: p.country, league: p.league, flag: p.flag });
  }
  return Array.from(seen.values()).sort((a, b) => a.league.localeCompare(b.league));
}

async function createPrediction(data, userId, userName) {
  const preds = await readPredictions();
  const ts = nowIso();
  const pred = {
    id: crypto.randomUUID(),
    country: data.country || '',
    league: data.league || '',
    flag: data.flag || '',
    home_team: data.home_team,
    away_team: data.away_team,
    match_date: data.match_date,
    match_time: data.match_time,
    status: data.status || 'upcoming',
    score_home: data.score_home ?? null,
    score_away: data.score_away ?? null,
    market: data.market || '1X2',
    pick: data.pick,
    probability: data.probability === '' || data.probability === undefined ? null : Number(data.probability),
    odd: Number(data.odd),
    ticket_group: data.ticket_group || null,
    ticket_type: data.ticket_type || null,
    featured: !!data.featured,
    is_vip: !!data.is_vip,
    // Settlement + enrichment — filled in automatically once a real or
    // manually-entered final score is known (see services/settlement.js
    // and services/predictionSync.js).
    result: null, // null (pending) | 'won' | 'lost'
    settled_at: null,
    settled_by: null, // 'auto' | 'manual' | null
    matchday: data.matchday ?? null,
    stage: data.stage ?? null,
    half_time_home: data.half_time_home ?? null,
    half_time_away: data.half_time_away ?? null,
    referee: data.referee ?? null,
    venue: data.venue ?? null,
    external_source: data.external_source ?? null,
    created_by: userId,
    created_by_name: userName,
    created_at: ts,
    updated_at: ts,
  };
  const settled = trySettle(pred);
  preds.push(settled);
  await writePredictions(preds);
  return settled;
}

async function updatePrediction(id, data) {
  const preds = await readPredictions();
  const idx = preds.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = preds[idx];
  // Any manual edit to the pick, market or score re-opens the bet for
  // (re-)grading instead of keeping a stale result around.
  const touchesGrading = ['pick', 'market', 'score_home', 'score_away', 'status'].some((f) => f in data);
  const merged = {
    ...existing,
    ...data,
    probability:
      data.probability === '' || data.probability === undefined
        ? existing.probability
        : Number(data.probability),
    odd: data.odd !== undefined ? Number(data.odd) : existing.odd,
    result: touchesGrading ? null : existing.result,
    settled_at: touchesGrading ? null : existing.settled_at,
    settled_by: touchesGrading ? null : existing.settled_by,
    updated_at: nowIso(),
  };
  const settled = trySettle(merged);
  preds[idx] = settled;
  await writePredictions(preds);
  return settled;
}

// Grades a prediction in place if it has a final score and a market/pick
// combo we know how to read — never overwrites an existing result, and
// never guesses on a market it doesn't recognize (evaluatePick returns
// null in that case, leaving the prediction "pending").
function trySettle(pred, settledBy = 'auto') {
  if (pred.result) return pred;
  if (pred.status !== 'FT') return pred;
  const outcome = evaluatePick(pred);
  if (!outcome) return pred;
  return { ...pred, result: outcome, settled_at: nowIso(), settled_by: settledBy };
}

// Sweeps every unsettled, finished prediction and grades what it can.
// Called after every sync with live results, and safe to call anytime.
async function settleAll() {
  const preds = await readPredictions();
  let changed = 0;
  const next = preds.map((p) => {
    const settled = trySettle(p);
    if (settled !== p) changed += 1;
    return settled;
  });
  if (changed) await writePredictions(next);
  return changed;
}

// Used by the auto-sync job: merges freshly-known real-match facts
// (score, status, matchday, referee...) into a prediction, then attempts
// to grade it. Only ever moves a prediction toward more information —
// never blanks out fields the sync didn't have an answer for.
async function applyLiveFacts(id, facts) {
  const preds = await readPredictions();
  const idx = preds.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const merged = { ...preds[idx], ...facts, updated_at: nowIso() };
  const settled = trySettle(merged);
  preds[idx] = settled;
  await writePredictions(preds);
  return settled;
}

async function deletePrediction(id) {
  const preds = await readPredictions();
  const next = preds.filter((p) => p.id !== id);
  const changed = next.length !== preds.length;
  if (changed) await writePredictions(next);
  return changed;
}

// A prediction/leg marked is_vip has its pick, odd and probability hidden
// from anyone who isn't VIP (or staff) — the caller still learns a bet
// exists, just not which one, mirroring BetMines' "unlock to reveal" cards.
function canReveal(pred, viewer) {
  if (!pred.is_vip) return true;
  if (!viewer) return false;
  return viewer.isVip || viewer.role === 'moderator' || viewer.role === 'admin';
}

function maskForViewer(pred, viewer) {
  if (canReveal(pred, viewer)) return { ...pred, locked: false };
  const { pick, odd, probability, ...rest } = pred;
  return { ...rest, pick: null, odd: null, probability: null, locked: true };
}

async function dailyTickets(date, viewer) {
  const preds = (await listPredictions({ date })).filter((p) => p.ticket_group);
  const groups = new Map();
  for (const p of preds) {
    if (!groups.has(p.ticket_group)) groups.set(p.ticket_group, { type: p.ticket_type, legs: [] });
    groups.get(p.ticket_group).legs.push(p);
  }
  const tickets = [];
  for (const [groupId, g] of groups) {
    const totalOdd = g.legs.reduce((acc, leg) => acc * leg.odd, 1);
    const locked = g.legs.some((leg) => !canReveal(leg, viewer));
    tickets.push({
      id: groupId,
      type: g.type,
      date,
      locked,
      legs: g.legs.map((leg) => maskForViewer(leg, viewer)),
      total_odd: locked ? null : Math.round(totalOdd * 100) / 100,
    });
  }
  return tickets;
}

module.exports = {
  listPredictions,
  getPrediction,
  listLeagues,
  createPrediction,
  updatePrediction,
  deletePrediction,
  dailyTickets,
  canReveal,
  maskForViewer,
  trySettle,
  settleAll,
  applyLiveFacts,
};
