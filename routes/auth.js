const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Nom, email, téléphone et mot de passe sont requis.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    // Public self-registration is always a plain 'user' — role upgrades
    // to moderator/admin can only be granted by an admin afterwards. The
    // phone number is required so admins/tipsters can reach paying VIP
    // members (see GET /api/users).
    const user = await User.create({ name, email, phone, password, role: 'user' });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe sont requis.' });
  }
  const user = await User.findByEmail(email);
  if (!user || !User.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }
  const token = signToken(user);
  res.json({ token, user: User.toPublic(user) });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post('/favorites/:predictionId', authenticate, async (req, res) => {
  const updated = await User.toggleFavorite(req.user.id, req.params.predictionId);
  res.json({ user: updated });
});

// Self-service demo activation — no payment gateway wired up yet, this
// simply grants a 7-day trial plan so the gated UI/API can be exercised
// end to end. Replace with a real checkout flow before going to
// production. Access expires on its own (see User.computeIsVip) — no
// separate "cancel" cleanup job needed for expiry, only for early exit.
router.post('/vip/activate-trial', authenticate, async (req, res) => {
  const updated = await User.setPlan(req.user.id, { type: 'trial' });
  res.json({ user: updated });
});

router.post('/vip/cancel', authenticate, async (req, res) => {
  const updated = await User.clearPlan(req.user.id);
  res.json({ user: updated });
});

module.exports = router;
