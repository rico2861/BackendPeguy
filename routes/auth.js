const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Payment = require('../models/Payment');
const mailer = require('../services/mailer');
const { authenticate } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared by /register and /admin/bootstrap — same required fields, same
// shape of account being created.
function validateContact({ name, email, phone, password }) {
  if (!name || !email || !phone || !password) return 'Nom, email, téléphone et mot de passe sont requis.';
  if (name.length > 200 || email.length > 200 || phone.length > 50) return 'Un des champs dépasse la longueur autorisée.';
  if (!EMAIL_RE.test(email)) return 'Adresse email invalide.';
  if (password.length < 6) return 'Le mot de passe doit contenir au moins 6 caractères.';
  return null;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
}

// Issues a fresh access+refresh pair and persists the refresh token's hash
// (see User.setRefreshToken) — every login/refresh rotates it, so only the
// most recently issued refresh token is ever valid.
async function issueTokenPair(user) {
  const token = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await User.setRefreshToken(user.id, refreshToken);
  return { token, refreshToken };
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    const validationError = validateContact({ name, email, phone, password });
    if (validationError) return res.status(400).json({ error: validationError });
    // Public self-registration is always a plain 'user' — role upgrades
    // to moderator/admin can only be granted by an admin afterwards. The
    // phone number is required so admins/tipsters can reach paying VIP
    // members (see GET /api/users).
    const user = await User.create({ name, email, phone, password, role: 'user' });
    const { token, refreshToken } = await issueTokenPair(user);
    mailer.sendWelcomeEmail(user).catch((err) => console.error('[mailer] welcome email failed:', err.message));
    res.status(201).json({ token, refreshToken, user });
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
  const { token, refreshToken } = await issueTokenPair(user);
  res.json({ token, refreshToken, user: User.toPublic(user) });
});

// Exchanges a still-valid refresh token for a new access+refresh pair.
// Rotation: presenting a refresh token that doesn't match the one on file
// (already rotated away, or never issued) clears the stored token
// entirely and rejects — the safest assumption is that it was stolen and
// already used, so every device needs to log in again.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken requis.' });
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user || !User.verifyRefreshToken(user, refreshToken)) {
      if (user) await User.clearRefreshToken(user.id);
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    }
    const { token, refreshToken: nextRefreshToken } = await issueTokenPair(user);
    res.json({ token, refreshToken: nextRefreshToken, user: User.toPublic(user) });
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  await User.clearRefreshToken(req.user.id);
  res.status(204).end();
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

// "Mon abonnement" — current status, plan + payment history, all derived
// live (no separate status flag to go stale). Status precedence: an
// active plan wins even if an old payment happens to still say pending
// (e.g. a since-superseded renewal attempt).
router.get('/subscription', authenticate, async (req, res) => {
  const user = req.user;
  const plan = user.plan || null;
  const now = Date.now();

  let status = 'none';
  if (plan && new Date(plan.expiresAt).getTime() > now) status = 'active';
  else if (plan) status = 'expired';

  const payments = await Payment.listForUser(user.id);
  if (status === 'none' && payments.some((p) => p.status === 'pending')) status = 'pending';

  const daysRemaining = status === 'active' ? Math.ceil((new Date(plan.expiresAt).getTime() - now) / 86_400_000) : 0;

  res.json({
    status,
    plan: plan ? { ...plan, daysRemaining } : null,
    planHistory: user.planHistory || [],
    payments,
  });
});

// Always responds the same generic message whether or not the email
// exists, to avoid leaking which emails have an account.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requis.' });
  const user = await User.findByEmail(email);
  if (user) {
    const resetToken = await User.setResetToken(user.id);
    const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
    const resetLink = `${appUrl}/reinitialiser-mot-de-passe?token=${resetToken}`;
    mailer
      .sendPasswordResetEmail(User.toPublic(user), resetLink)
      .catch((err) => console.error('[mailer] reset email failed:', err.message));
  }
  res.json({ message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe sont requis.' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  const user = await User.findByResetToken(token);
  if (!user) return res.status(400).json({ error: 'Lien invalide ou expiré.' });
  await User.setPassword(user.id, password);
  res.json({ message: 'Mot de passe mis à jour, reconnectez-vous.' });
});

// A one-time-secret ("PIN") escape hatch to create an admin account
// without already having one — useful for the very first admin on a
// fresh deploy, or as a break-glass path if every admin account is
// locked out. Requires ADMIN_CREATE_PIN to be set; unset means disabled.
router.post('/admin/bootstrap', async (req, res) => {
  const pin = process.env.ADMIN_CREATE_PIN;
  if (!pin) return res.status(503).json({ error: 'Création admin par PIN non configurée.' });
  const { name, email, phone, password, pin: providedPin } = req.body || {};
  if (providedPin !== pin) return res.status(403).json({ error: 'PIN invalide.' });
  const validationError = validateContact({ name, email, phone, password });
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const user = await User.create({ name, email, phone, password, role: 'admin' });
    const { token, refreshToken } = await issueTokenPair(user);
    recordAudit(req, {
      action: 'admin.bootstrap_created',
      target: `user:${user.id} (${user.email})`,
      newValue: { name: user.name, email: user.email, role: user.role },
    });
    res.status(201).json({ token, refreshToken, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

module.exports = router;
