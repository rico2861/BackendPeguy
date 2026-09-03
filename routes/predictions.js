const express = require('express');
const Prediction = require('../models/Prediction');
const { authenticateOptional, authenticate, authorize } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');
const { syncPredictionsWithLiveResults } = require('../services/predictionSync');
const { notifyPublish } = require('../services/notifyPublish');

const router = express.Router();

const REQUIRED_FIELDS = ['home_team', 'away_team', 'match_date', 'match_time', 'market', 'pick', 'odd'];

// Best-effort: keep predictions in sync with real results before serving
// them. syncPredictionsWithLiveResults() self-throttles, so this is a
// cheap no-op on every call except roughly once every 30s. Never blocks
// the response on a failure (offline, key missing, network-blocked...).
async function trySync() {
  try {
    await syncPredictionsWithLiveResults();
  } catch {
    /* best-effort */
  }
}

router.get('/predictions', authenticateOptional, async (req, res) => {
  await trySync();
  const { date, dateFrom, league, country, market, q } = req.query;
  let predictions = (await Prediction.listPredictions({ date, dateFrom, league, country, market, q })).map((p) =>
    Prediction.withLockState(p, req.user)
  );
  // A text search matches the real (pre-mask) team names in the DB, so a
  // locked VIP pick showing up in results at all — even fully masked —
  // tells a non-VIP visitor that pick exists for that team today. Search
  // results drop locked picks entirely rather than leak that.
  if (q) predictions = predictions.filter((p) => !p.locked);
  res.json({ predictions, count: predictions.length });
});

const STATS_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATS_MAX_RANGE_DAYS = 730;

// Accepts either `?days=N` (the quick filter chips: 7/30/90/180/365) or an
// explicit `?from=YYYY-MM-DD&to=YYYY-MM-DD` (the custom range picker) —
// `from`/`to` win when both are present and valid. Capped at 2 years
// either way so a malformed/huge range can't force an absurd zero-filled
// array.
function resolveStatsRange(req, defaultDays = 30) {
  const { from, to } = req.query;
  if (from && to && STATS_ISO_DATE_RE.test(from) && STATS_ISO_DATE_RE.test(to) && from <= to) {
    const spanDays = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (spanDays > 0 && spanDays <= STATS_MAX_RANGE_DAYS) return { fromIso: from, toIso: to };
  }
  const days = Math.min(Math.max(Number(req.query.days) || defaultDays, 1), STATS_MAX_RANGE_DAYS);
  const toIso = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (days - 1));
  return { fromIso: fromDate.toISOString().slice(0, 10), toIso };
}

// Global track record over a date range — powers the performance chart on
// the frontend. Must be declared before /predictions/:id so "stats"
// doesn't get captured as an :id param.
router.get('/predictions/stats', async (req, res) => {
  const { fromIso, toIso } = resolveStatsRange(req, 30);

  const settled = (await Prediction.listPredictions({})).filter(
    (p) => p.result && p.match_date >= fromIso && p.match_date <= toIso
  );

  const byDate = new Map();
  for (const p of settled) {
    if (!byDate.has(p.match_date)) byDate.set(p.match_date, { date: p.match_date, won: 0, lost: 0 });
    byDate.get(p.match_date)[p.result === 'won' ? 'won' : 'lost'] += 1;
  }
  // Zero-filled for every day in the range — days with no settled
  // prediction get `winRate: null` (not 0) so the chart shows a genuine
  // gap in the line instead of a misleading dip to the floor.
  const dates = [];
  for (const cur = new Date(`${fromIso}T00:00:00Z`), end = new Date(`${toIso}T00:00:00Z`); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    dates.push(cur.toISOString().slice(0, 10));
  }
  const daily = dates.map((date) => {
    const d = byDate.get(date);
    if (!d) return { date, won: 0, lost: 0, total: 0, winRate: null };
    return { ...d, total: d.won + d.lost, winRate: Math.round((d.won / (d.won + d.lost)) * 100) };
  });

  const won = settled.filter((p) => p.result === 'won').length;
  const lost = settled.length - won;
  const overall = { won, lost, total: settled.length, winRate: settled.length ? Math.round((won / settled.length) * 100) : 0 };

  res.json({ daily, overall });
});

router.get('/predictions/:id', authenticateOptional, async (req, res) => {
  await trySync();
  const pred = await Prediction.getPrediction(req.params.id);
  if (!pred) {
    return res.status(404).json({ error: 'Pronostic introuvable.' });
  }
  res.json({ prediction: Prediction.withLockState(pred, req.user) });
});

router.get('/leagues', async (req, res) => {
  res.json({ leagues: await Prediction.listLeagues() });
});

router.get('/daily-bets', authenticateOptional, async (req, res) => {
  await trySync();
  const { date, dateFrom } = req.query;
  const effectiveDate = date || (dateFrom ? undefined : new Date().toISOString().slice(0, 10));
  res.json({ date: effectiveDate || dateFrom, tickets: await Prediction.dailyTickets(effectiveDate, req.user, dateFrom) });
});

// --- Write endpoints: moderator ("pronostiqueur") and admin only. ---
// Moderators may only edit/delete predictions they created themselves;
// admins may act on any prediction.

router.post('/predictions', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const data = req.body || {};
  const missing = REQUIRED_FIELDS.filter((f) => !data[f]);
  if (missing.length) {
    return res.status(400).json({ error: `Champs manquants : ${missing.join(', ')}` });
  }
  const statusErr = statusDateError(data.status, data.match_date);
  if (statusErr) return res.status(400).json({ error: statusErr });
  const pred = await Prediction.createPrediction(data, req.user.id, data.created_by_name || req.user.email);
  recordAudit(req, {
    action: 'prediction.created',
    target: `prediction:${pred.id} (${pred.home_team} vs ${pred.away_team})`,
    newValue: { market: pred.market, pick: pred.pick, odd: pred.odd },
  });
  // A VIP pick used to only reach subscribers if a moderator remembered to
  // click "Notifier les abonnés" afterwards — publishing one now always
  // fans out (push + VIP e-mail) on its own. Fire-and-forget: never delays
  // or fails the publish itself if push/e-mail is slow or misconfigured.
  if (pred.is_vip) {
    notifyPublish({
      title: 'Nouveau pronostic VIP PeguyTbn',
      body: `${pred.home_team} vs ${pred.away_team} — nouveau pronostic VIP disponible.`,
      url: '/pronostics-vip',
      actorName: data.created_by_name || req.user.email,
      emailMessage: {
        fr: `${pred.home_team} vs ${pred.away_team} — nouveau pronostic VIP disponible.`,
        en: `${pred.home_team} vs ${pred.away_team} — new VIP pick available.`,
      },
    }).catch(() => {});
  }
  res.status(201).json({ prediction: pred });
});

function canEdit(user, pred) {
  if (user.role === 'admin') return true;
  return user.role === 'moderator' && pred.created_by === user.id;
}

// A match can't be "Terminé" before its own kickoff date — this is the
// server-side half of the same check the form does, so a direct API call
// can't produce a finished-looking pick dated in the future either.
function statusDateError(status, matchDate) {
  if (status === 'FT' && matchDate && matchDate > new Date().toISOString().slice(0, 10)) {
    return "Le statut ne peut pas être « Terminé » (FT) pour un match dont la date est dans le futur.";
  }
  return null;
}

router.put('/predictions/:id', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const existing = await Prediction.getPrediction(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pronostic introuvable.' });
  if (!canEdit(req.user, existing)) {
    return res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres pronostics.' });
  }
  const body = req.body || {};
  const statusErr = statusDateError(body.status ?? existing.status, body.match_date ?? existing.match_date);
  if (statusErr) return res.status(400).json({ error: statusErr });
  const updated = await Prediction.updatePrediction(req.params.id, req.body || {});
  recordAudit(req, {
    action: existing.result !== updated.result ? 'prediction.result_changed' : 'prediction.updated',
    target: `prediction:${updated.id} (${updated.home_team} vs ${updated.away_team})`,
    previousValue: { pick: existing.pick, market: existing.market, result: existing.result, score: `${existing.score_home ?? '-'}-${existing.score_away ?? '-'}` },
    newValue: { pick: updated.pick, market: updated.market, result: updated.result, score: `${updated.score_home ?? '-'}-${updated.score_away ?? '-'}` },
  });
  res.json({ prediction: updated });
});

router.delete('/predictions/:id', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const existing = await Prediction.getPrediction(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pronostic introuvable.' });
  if (!canEdit(req.user, existing)) {
    return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres pronostics.' });
  }
  await Prediction.deletePrediction(req.params.id);
  recordAudit(req, {
    action: 'prediction.deleted',
    target: `prediction:${existing.id} (${existing.home_team} vs ${existing.away_team})`,
    previousValue: { market: existing.market, pick: existing.pick, odd: existing.odd },
  });
  res.status(204).end();
});

module.exports = router;
