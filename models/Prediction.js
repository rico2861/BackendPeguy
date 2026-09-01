const crypto = require('crypto');
const { readPredictions, writePredictions } = require('../db');
const { evaluatePick } = require('../services/settlement');
const COMPETITIONS = require('../services/competitions');

function nowIso() {
  return new Date().toISOString();
}

async function listPredictions({ date, dateFrom, league, country, market, q, ticketType } = {}) {
  let preds = await readPredictions();
  if (date) preds = preds.filter((p) => p.match_date === date);
  // dateFrom (ignored when an exact date is given) is "today or later" —
  // used by the VIP page so a pick published ahead of its match date is
  // never hidden just because it isn't scheduled for exactly today.
  else if (dateFrom) preds = preds.filter((p) => p.match_date >= dateFrom);
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

// Union of every league that actually has a prediction, plus the fixed
// set of competitions the live-scores feed covers (services/
// competitions.js) — so the filter dropdown isn't empty for a league on
// a day nobody's published a pick for yet.
async function listLeagues() {
  const preds = await readPredictions();
  const seen = new Map();
  for (const p of preds) {
    const key = `${p.country}-${p.league}`;
    if (!seen.has(key)) seen.set(key, { country: p.country, league: p.league, flag: p.flag });
  }
  for (const c of COMPETITIONS) {
    const key = `${c.country}-${c.league}`;
    if (!seen.has(key)) seen.set(key, { country: c.country, league: c.league, flag: null });
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
  // A moderator forcing a result explicitly (data.result present) always
  // wins — marked 'manual' and left alone by trySettle() below (which
  // never overwrites an existing result). Otherwise, editing pick/market/
  // score/status re-opens the bet for auto (re-)grading instead of
  // keeping a stale result around.
  const forcingResult = 'result' in data;
  const touchesGrading = !forcingResult && ['pick', 'market', 'score_home', 'score_away', 'status'].some((f) => f in data);
  const merged = {
    ...existing,
    ...data,
    probability:
      data.probability === '' || data.probability === undefined
        ? existing.probability
        : Number(data.probability),
    odd: data.odd !== undefined ? Number(data.odd) : existing.odd,
    result: forcingResult ? data.result : touchesGrading ? null : existing.result,
    settled_at: forcingResult ? (data.result ? nowIso() : null) : touchesGrading ? null : existing.settled_at,
    settled_by: forcingResult ? (data.result ? 'manual' : null) : touchesGrading ? null : existing.settled_by,
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

// A prediction/leg marked is_vip is fully visible to everyone once it's
// SETTLED (result known — a finished pick is proof of track record, no
// edge left in hiding it) or to VIP/staff viewers at any time. A
// non-VIP viewer still sees it while pending — team names and pick are
// blurred client-side as a teaser (see PredictionRow/TicketCard) rather
// than excluded outright, to entice sign-ups. Nothing is ever excluded
// from a list any more; `locked` just tells the frontend to blur it.
function isLocked(pred, viewer) {
  if (!pred.is_vip) return false;
  if (pred.result) return false;
  if (!viewer) return true;
  return !(viewer.isVip || viewer.role === 'moderator' || viewer.role === 'admin');
}

// Real masking, not a frontend CSS trick: when locked, the actual team
// names/market/pick/odd/probability never leave the server — only a
// same-length placeholder does, so the blurred teaser still "looks"
// right (roughly matching text width) without a network-tab peek ever
// revealing the real match. Only called on a prediction already known
// to be locked for this viewer.
function maskFields(pred) {
  const mask = (s) => '•'.repeat(Math.min(String(s ?? '').length || 6, 14));
  return {
    ...pred,
    home_team: mask(pred.home_team),
    away_team: mask(pred.away_team),
    market: mask(pred.market),
    pick: mask(pred.pick),
    odd: null,
    probability: null,
  };
}

// Applies maskFields only when the prediction is actually locked for
// this viewer — the single place every route should call through,
// rather than each one re-deriving the locked check.
function withLockState(pred, viewer) {
  const locked = isLocked(pred, viewer);
  return locked ? { ...maskFields(pred), locked } : { ...pred, locked };
}

async function dailyTickets(date, viewer, dateFrom) {
  const preds = (await listPredictions({ date, dateFrom })).filter((p) => p.ticket_group);
  const groups = new Map();
  for (const p of preds) {
    if (!groups.has(p.ticket_group)) groups.set(p.ticket_group, { type: p.ticket_type, legs: [] });
    groups.get(p.ticket_group).legs.push(p);
  }
  const tickets = [];
  for (const [groupId, g] of groups) {
    const totalOdd = g.legs.reduce((acc, leg) => acc * leg.odd, 1);
    // A combo only ever wins if every leg does — one loss sinks the whole
    // ticket, same as a real accumulator bet. Still pending if nothing has
    // lost yet but at least one leg hasn't been graded.
    let result = null;
    if (g.legs.some((leg) => leg.result === 'lost')) result = 'lost';
    else if (g.legs.every((leg) => leg.result === 'won')) result = 'won';
    // A ticket is locked for this viewer if any leg is — team names/picks
    // on those legs get blurred client-side rather than the whole combo
    // being hidden.
    const locked = g.legs.some((leg) => isLocked(leg, viewer));
    tickets.push({
      id: groupId,
      type: g.type,
      date,
      result,
      locked,
      legs: g.legs.map((leg) => withLockState(leg, viewer)),
      total_odd: Math.round(totalOdd * 100) / 100,
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
  isLocked,
  withLockState,
  trySettle,
  settleAll,
  applyLiveFacts,
};
