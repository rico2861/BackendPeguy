const express = require('express');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Tipsters ("pronostiqueur"/moderator) need to see who's VIP and how to
// reach them (phone), e.g. for a VIP Telegram/WhatsApp group — but they
// must not be able to change roles, plans, or delete accounts. Only
// this one read route is opened up to them; everything below stays
// admin-only.
router.get('/', authorize('admin', 'moderator'), (req, res) => {
  res.json({ users: User.findAll() });
});

router.use(authorize('admin'));

router.patch('/:id/role', (req, res) => {
  const { role } = req.body;
  if (req.params.id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'Vous ne pouvez pas retirer vos propres droits admin.' });
  }
  try {
    const updated = User.updateRole(req.params.id, role);
    if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ user: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

// Grants/extends a VIP plan. Body: { type: 'trial'|'vip', days?: number }
// `days` overrides the type's default duration (custom extension).
router.patch('/:id/plan', (req, res) => {
  const { type, days } = req.body;
  if (type && !Object.keys(User.PLAN_DURATIONS_DAYS).includes(type)) {
    return res.status(400).json({ error: 'Type de plan invalide.' });
  }
  const updated = User.setPlan(req.params.id, { type: type || 'vip', days: days !== undefined ? Number(days) : undefined });
  if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user: updated });
});

router.delete('/:id/plan', (req, res) => {
  const updated = User.clearPlan(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user: updated });
});

router.delete('/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }
  const ok = User.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.status(204).end();
});

module.exports = router;
