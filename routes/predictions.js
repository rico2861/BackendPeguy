const express = require('express');
const Prediction = require('../models/Prediction');
const { authenticateOptional, authenticate, authorize } = require('../middleware/auth');
const { syncPredictionsWithLiveResults } = require('../services/predictionSync');

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
  const { date, league, country, market, q } = req.query;
  const predictions = (await Prediction.listPredictions({ date, league, country, market, q })).map((p) =>
    Prediction.maskForViewer(p, req.user)
  );
  res.json({ predictions, count: predictions.length });
});

router.get('/predictions/:id', authenticateOptional, async (req, res) => {
  await trySync();
  const pred = await Prediction.getPrediction(req.params.id);
  if (!pred) return res.status(404).json({ error: 'Pronostic introuvable.' });
  res.json({ prediction: Prediction.maskForViewer(pred, req.user) });
});

router.get('/leagues', async (req, res) => {
  res.json({ leagues: await Prediction.listLeagues() });
});

router.get('/daily-bets', authenticateOptional, async (req, res) => {
  await trySync();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({ date, tickets: await Prediction.dailyTickets(date, req.user) });
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
  const pred = await Prediction.createPrediction(data, req.user.id, data.created_by_name || req.user.email);
  res.status(201).json({ prediction: pred });
});

function canEdit(user, pred) {
  if (user.role === 'admin') return true;
  return user.role === 'moderator' && pred.created_by === user.id;
}

router.put('/predictions/:id', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const existing = await Prediction.getPrediction(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pronostic introuvable.' });
  if (!canEdit(req.user, existing)) {
    return res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres pronostics.' });
  }
  const updated = await Prediction.updatePrediction(req.params.id, req.body || {});
  res.json({ prediction: updated });
});

router.delete('/predictions/:id', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const existing = await Prediction.getPrediction(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pronostic introuvable.' });
  if (!canEdit(req.user, existing)) {
    return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres pronostics.' });
  }
  await Prediction.deletePrediction(req.params.id);
  res.status(204).end();
});

module.exports = router;
