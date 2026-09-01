const express = require('express');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');

const router = express.Router();

router.use(authenticate);

// Tipsters ("pronostiqueur"/moderator) need to see who's VIP and how to
// reach them (phone), e.g. for a VIP Telegram/WhatsApp group — but they
// must not be able to change roles, plans, or delete accounts. Only
// this one read route is opened up to them; everything below stays
// admin-only.
router.get('/', authorize('admin', 'moderator'), async (req, res) => {
  res.json({ users: await User.findAll() });
});

router.use(authorize('admin'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lets an admin create an account directly with a chosen role (member,
// moderator, or admin) — self-registration (POST /auth/register) always
// creates a plain 'user'; role escalation there is impossible by design.
router.post('/', async (req, res) => {
  const { name, email, phone, password, role } = req.body || {};
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'Nom, email, téléphone et mot de passe sont requis.' });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  if (role && !User.ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  try {
    const user = await User.create({ name, email, phone, password, role: role || 'user' });
    recordAudit(req, {
      action: 'user.created_by_admin',
      target: `user:${user.id} (${user.email})`,
      newValue: { name: user.name, email: user.email, role: user.role },
    });
    res.status(201).json({ user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

router.patch('/:id/role', async (req, res) => {
  const { role } = req.body;
  if (req.params.id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'Vous ne pouvez pas retirer vos propres droits admin.' });
  }
  try {
    const before = await User.findById(req.params.id);
    const updated = await User.updateRole(req.params.id, role);
    if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    recordAudit(req, {
      action: 'user.role_changed',
      target: `user:${updated.id} (${updated.email})`,
      previousValue: before?.role,
      newValue: role,
    });
    res.json({ user: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

// Grants/extends a VIP plan. Body: { type: 'trial'|'vip', days?: number }
// `days` overrides the type's default duration (custom extension).
router.patch('/:id/plan', async (req, res) => {
  const { type, days } = req.body;
  if (type && !Object.keys(User.PLAN_DURATIONS_DAYS).includes(type)) {
    return res.status(400).json({ error: 'Type de plan invalide.' });
  }
  const before = await User.findById(req.params.id);
  const updated = await User.setPlan(req.params.id, { type: type || 'vip', days: days !== undefined ? Number(days) : undefined });
  if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  recordAudit(req, {
    action: 'user.plan_granted',
    target: `user:${updated.id} (${updated.email})`,
    previousValue: before?.plan,
    newValue: updated.plan,
  });
  res.json({ user: updated });
});

router.delete('/:id/plan', async (req, res) => {
  const before = await User.findById(req.params.id);
  const updated = await User.clearPlan(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  recordAudit(req, {
    action: 'user.plan_revoked',
    target: `user:${updated.id} (${updated.email})`,
    previousValue: before?.plan,
    newValue: null,
  });
  res.json({ user: updated });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }
  const before = await User.findById(req.params.id);
  const ok = await User.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  recordAudit(req, {
    action: 'user.deleted',
    target: `user:${req.params.id} (${before?.email || 'inconnu'})`,
    previousValue: before ? { name: before.name, email: before.email, role: before.role } : null,
    newValue: null,
  });
  res.status(204).end();
});

module.exports = router;
