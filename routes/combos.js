const crypto = require('crypto');
const express = require('express');
const Prediction = require('../models/Prediction');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const LEG_REQUIRED_FIELDS = ['home_team', 'away_team', 'match_date', 'match_time', 'market', 'pick', 'odd'];

function canEdit(user, pred) {
  if (user.role === 'admin') return true;
  return user.role === 'moderator' && pred.created_by === user.id;
}

// Builds a bet-builder combo: several Prediction rows (one per leg) that
// share a ticket_group, exactly like the seed data's Double/Risk tickets
// — Prediction.dailyTickets() already knows how to group, price, mask and
// (as of this phase) grade a ticket like this, so nothing else needs to
// change to make a combo created here show up correctly everywhere.
router.post('/', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const { type, legs, is_vip } = req.body || {};
  if (!Array.isArray(legs) || legs.length < 2) {
    return res.status(400).json({ error: 'Un combiné doit contenir au moins 2 sélections.' });
  }
  for (const [i, leg] of legs.entries()) {
    const missing = LEG_REQUIRED_FIELDS.filter((f) => !leg[f]);
    if (missing.length) {
      return res.status(400).json({ error: `Sélection ${i + 1} : champs manquants (${missing.join(', ')}).` });
    }
    if (!(Number(leg.odd) > 1)) {
      return res.status(400).json({ error: `Sélection ${i + 1} : la cote doit être supérieure à 1.` });
    }
  }

  const ticketGroup = crypto.randomUUID();
  const createdLegs = [];
  for (const leg of legs) {
    const pred = await Prediction.createPrediction(
      { ...leg, ticket_group: ticketGroup, ticket_type: type || 'Double', is_vip: !!is_vip },
      req.user.id,
      req.user.name
    );
    createdLegs.push(pred);
  }

  const totalOdd = createdLegs.reduce((acc, leg) => acc * leg.odd, 1);
  res.status(201).json({
    ticket: {
      id: ticketGroup,
      type: type || 'Double',
      date: legs[0].match_date,
      locked: false,
      result: null,
      legs: createdLegs,
      total_odd: Math.round(totalOdd * 100) / 100,
    },
  });
});

router.delete('/:groupId', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const all = await Prediction.listPredictions({});
  const legs = all.filter((p) => p.ticket_group === req.params.groupId);
  if (legs.length === 0) return res.status(404).json({ error: 'Combiné introuvable.' });
  if (!legs.every((leg) => canEdit(req.user, leg))) {
    return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres combinés.' });
  }
  for (const leg of legs) {
    await Prediction.deletePrediction(leg.id);
  }
  res.status(204).end();
});

module.exports = router;
