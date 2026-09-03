const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Payment = require('../models/Payment');
const mailer = require('../services/mailer');
const { reconcile } = require('../services/paymentService');
const { authenticate } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// At least 8 characters, one lowercase, one uppercase, one digit — the
// same rule enforced on every path that sets a password (register,
// forgot/reset-password, settings reset), so the frontend's live
// checklist can't drift out of sync with what the server actually accepts.
const STRONG_PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
const WEAK_PASSWORD_MSG =
  'Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule et un chiffre.';

// Shared by /register and /admin/bootstrap — same required fields, same
// shape of account being created.
function validateContact({ name, email, phone, password }) {
  if (!name || !email || !phone || !password) return 'Nom, email, téléphone et mot de passe sont requis.';
  if (name.length > 200 || email.length > 200 || phone.length > 50) return 'Un des champs dépasse la longueur autorisée.';
  if (!EMAIL_RE.test(email)) return 'Adresse email invalide.';
  if (!STRONG_PASSWORD_RE.test(password)) return WEAK_PASSWORD_MSG;
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
    const { name, email, phone, password, lang } = req.body;
    const validationError = validateContact({ name, email, phone, password });
    if (validationError) return res.status(400).json({ error: validationError });
    // Public self-registration is always a plain 'user' — role upgrades
    // to moderator/admin can only be granted by an admin afterwards. The
    // phone number is required so admins/tipsters can reach paying VIP
    // members (see GET /api/users). `lang` is whichever language the
    // signup form was in — used later to send transactional emails (VIP
    // pick notifications etc.) in the member's own language.
    const user = await User.create({ name, email, phone, password, role: 'user', lang });
    const { token, refreshToken } = await issueTokenPair(user);
    mailer.sendWelcomeEmail(user).catch((err) => console.error('[mailer] welcome email failed:', err.message));
    res.status(201).json({ token, refreshToken, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

router.post('/login', async (req, res) => {
  // Accepts email, username, or phone — the frontend sends it as
  // `identifier`; `email` is still accepted for backward compatibility.
  const identifier = req.body.identifier || req.body.email;
  const { password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe sont requis.' });
  }
  const user = await User.findByIdentifier(identifier);
  if (!user || !User.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  if (user.blocked) {
    return res.status(403).json({ error: 'Ce compte a été bloqué. Contactez le support.' });
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
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(payload.sub);
    if (!user || !User.verifyRefreshToken(user, refreshToken)) {
      if (user) await User.clearRefreshToken(user.id);
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    }
    if (user.blocked) {
      await User.clearRefreshToken(user.id);
      return res.status(403).json({ error: 'Ce compte a été bloqué. Contactez le support.' });
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

// Name/phone/lang only — email is never editable here (it's the login
// identifier and ties together payments/audit history). `lang` is synced
// silently by the frontend whenever the platform language switcher is
// used (see FrontendPeguyTBN LocaleContext) — it's what transactional
// emails (VIP pick notifications etc.) are sent in.
router.put('/me', authenticate, async (req, res) => {
  const { name, phone, username, lang } = req.body || {};
  if (name !== undefined && (!name.trim() || name.length > 200)) {
    return res.status(400).json({ error: 'Nom invalide.' });
  }
  if (phone !== undefined && (!phone.trim() || phone.length > 50)) {
    return res.status(400).json({ error: 'Téléphone invalide.' });
  }
  if (username !== undefined && (!username.trim() || username.length > 50 || !/^[a-zA-Z0-9_.]+$/.test(username.trim()))) {
    return res.status(400).json({ error: 'Nom d’utilisateur invalide (lettres, chiffres, point ou underscore uniquement).' });
  }
  try {
    const updated = await User.updateProfile(req.user.id, { name, phone, username, lang });
    res.json({ user: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

// Logged-in OTP reset flow for the Paramètres page — distinct from
// /forgot-password (logged-out, link-based): this one is tied to the
// authenticated account, so no email has to be typed/guessed.
router.post('/settings/request-otp', authenticate, async (req, res) => {
  const otp = await User.setResetOtp(req.user.id);
  mailer
    .sendOtpEmail(req.user, otp)
    .catch((err) => console.error('[mailer] otp email failed:', err.message));
  res.json({ message: `Code envoyé à ${req.user.email}.` });
});

router.post('/settings/reset-password', authenticate, async (req, res) => {
  const { otp, password } = req.body || {};
  if (!otp || !password) return res.status(400).json({ error: 'Code et mot de passe sont requis.' });
  if (!STRONG_PASSWORD_RE.test(password)) return res.status(400).json({ error: WEAK_PASSWORD_MSG });
  const user = await User.findByResetToken(otp);
  if (!user || user.id !== req.user.id) return res.status(400).json({ error: 'Code invalide ou expiré.' });
  await User.setPassword(user.id, password);
  res.json({ message: 'Mot de passe mis à jour.' });
});

// Called right after logging in with a password an admin set directly
// (see POST /users/:id/set-password) — req.user.mustChangePassword gates
// it so it can't be used as a general "change my password" shortcut.
// Takes effect immediately: new hash written, flag cleared, and a fresh
// token pair issued since the old refresh token was invalidated the
// moment the admin set the temporary password.
router.post('/force-change-password', authenticate, async (req, res) => {
  if (!req.user.mustChangePassword) {
    return res.status(400).json({ error: 'Aucun changement de mot de passe requis.' });
  }
  const { password } = req.body || {};
  if (!STRONG_PASSWORD_RE.test(password || '')) {
    return res.status(400).json({ error: WEAK_PASSWORD_MSG });
  }
  const updated = await User.completeForcedPasswordChange(req.user.id, password);
  const { token, refreshToken } = await issueTokenPair(updated);
  res.json({ token, refreshToken, user: updated });
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
  let user = req.user;
  const now = Date.now();

  let payments = await Payment.listForUser(user.id);
  // Opportunistic re-check: on Render's free tier the background sweep
  // (services/paymentSync.js) only runs while the server happens to be
  // awake — a payment left pending during a period nobody visited the
  // site could otherwise sit unresolved indefinitely even long after the
  // provider actually settled it. Every time the client loads their own
  // subscription page, re-verify every one of their own still-pending
  // payments against the provider right now, not just the most recent one.
  const stillPending = payments.filter((p) => p.status === 'pending');
  if (stillPending.length) {
    await Promise.all(stillPending.map((p) => reconcile(p, 'client-visit').catch(() => null)));
    payments = await Payment.listForUser(user.id);
    // Re-fetch: a reconcile() above may have just granted the plan, and
    // req.user is a snapshot from before that write — without this, a
    // payment that settles successfully during this very request would
    // still report status:'pending' back to the client that just paid.
    const fresh = await User.findById(user.id);
    if (fresh) user = User.toPublic(fresh);
  }

  const plan = user.plan || null;
  let status = 'none';
  if (plan && new Date(plan.expiresAt).getTime() > now) status = 'active';
  else if (plan) status = 'expired';
  if (status === 'none' && payments.some((p) => p.status === 'pending')) status = 'pending';

  const daysRemaining = status === 'active' ? Math.ceil((new Date(plan.expiresAt).getTime() - now) / 86_400_000) : 0;

  // Client-facing payment history never includes the internal reference
  // (`id`, sent as orderId/referenceId to gateways) or the gateway's own
  // transaction/payment id (transactionId, providerPaymentId, invoiceId,
  // providerOrderId, reference) — only admin sees those (GET /payments,
  // /payments/lookup). The client gets `displayId`: a short id tied to
  // the same record for support lookups, but not usable to correlate
  // with MonCash/NOWPayments dashboards or guess other payments' ids.
  const clientPayments = payments.map((p) => ({
    displayId: p.displayId,
    planType: p.planType,
    amountUsd: p.amountUsd,
    amountHtg: p.amountHtg,
    status: p.status,
    provider: p.provider,
    createdAt: p.createdAt,
  }));

  // The client sees THAT a plan was cancelled (and when) so the history
  // reads honestly instead of looking like it simply ran its course, but
  // never the admin's stated reason or who cancelled it — those are
  // admin/audit-log-only (see User.clearPlan, routes/users.js DELETE
  // /:id/plan).
  const clientPlanHistory = (user.planHistory || []).map((p) => ({
    type: p.type,
    startedAt: p.startedAt,
    expiresAt: p.expiresAt,
    amountUsd: p.amountUsd,
    amountHtg: p.amountHtg,
    provider: p.provider,
    cancelled: !!p.cancelled,
    cancelledAt: p.cancelledAt || null,
  }));

  res.json({
    status,
    plan: plan ? { ...plan, daysRemaining } : null,
    planHistory: clientPlanHistory,
    payments: clientPayments,
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
  if (!STRONG_PASSWORD_RE.test(password)) return res.status(400).json({ error: WEAK_PASSWORD_MSG });
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
