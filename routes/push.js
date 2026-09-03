const express = require('express');
const webPush = require('../services/webPush');
const User = require('../models/User');
const AdminNotification = require('../models/AdminNotification');
const MemberNotification = require('../models/MemberNotification');
const { notifyPublish } = require('../services/notifyPublish');
const { authenticate, authorize } = require('../middleware/auth');
const mailer = require('../services/mailer');
const router = express.Router();

// TEMPORARY — admin-only manual QA route to visually check every
// transactional email template end to end (real Resend send, real inbox).
// Not linked from any UI. Remove once the redesigned templates
// (see services/mailer.js — logo <img> swap) have been confirmed to look right.
router.post('/_test-emails', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const to = req.body?.to;
  if (!to) return res.status(400).json({ error: 'to requis.' });
  const userFr = { name: 'Richo (test)', email: to, lang: 'fr' };
  const userEn = { name: 'Richo (test)', email: to, lang: 'en' };
  const jobs = [
    ['sendWelcomeEmail', () => mailer.sendWelcomeEmail(userFr)],
    ['sendPasswordResetEmail', () => mailer.sendPasswordResetEmail(userFr, `${process.env.PUBLIC_APP_URL}/reinitialiser-mot-de-passe?token=TEST_TOKEN`)],
    ['sendOtpEmail', () => mailer.sendOtpEmail(userFr, '482913')],
    ['sendPaymentConfirmationEmail (MonCash/HTG)', () => mailer.sendPaymentConfirmationEmail(userFr, { provider: 'moncash', amountHtg: 10, amountUsd: 5, planType: 'vip' })],
    ['sendPaymentConfirmationEmail (crypto/USD)', () => mailer.sendPaymentConfirmationEmail(userFr, { provider: 'nowpayments', amountHtg: null, amountUsd: 5, planType: 'vip' })],
    ["sendVipExpiringEmail (3 jours)", () => mailer.sendVipExpiringEmail(userFr, 3)],
    ["sendVipExpiringEmail (aujourd'hui)", () => mailer.sendVipExpiringEmail(userFr, 0)],
    ['sendNewPicksEmail (FR)', () => mailer.sendNewPicksEmail(userFr, { message: 'Test — Lyon vs Marseille, nouveau pronostic VIP disponible.' })],
    ['sendNewPicksEmail (EN)', () => mailer.sendNewPicksEmail(userEn, { message: 'Test — Lyon vs Marseille, new VIP pick available.' })],
  ];
  const results = [];
  for (const [name, fn] of jobs) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  res.json({ mailerConfigured: mailer.isConfigured(), results });
});

// Public: the frontend needs this before it can call PushManager.subscribe.
router.get('/vapid-public-key', (req, res) => {
  if (!webPush.isConfigured()) return res.status(503).json({ error: 'Notifications push non configurées.' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/subscribe', authenticate, async (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Abonnement push invalide.' });
  }
  const user = await User.addPushSubscription(req.user.id, subscription);
  res.status(201).json({ user });
});

router.post('/unsubscribe', authenticate, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis.' });
  const user = await User.removePushSubscription(req.user.id, endpoint);
  res.json({ user });
});

// Moderator/admin only — used to notify subscribers when new daily picks
// or combos are published. Fans out over three channels: browser push
// (anyone subscribed), e-mail (VIP members only — that's the audience
// who actually gets gated content), and an internal admin-notification
// entry so other moderators/admins see that it happened.
router.post('/broadcast', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const { title, body, url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title et body sont requis.' });
  const result = await notifyPublish({ title, body, url, actorName: req.user.email });
  res.json(result);
});

router.get('/admin/notifications', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  res.json({ notifications: await AdminNotification.list({ limit: 30 }) });
});

// The regular member-facing bell (topbar) — "what have I been sent"
// rather than the staff-only admin feed above. Requires a session (unlike
// most read endpoints) since visibility depends on the viewer's VIP
// status (see MemberNotification.list).
router.get('/notifications', authenticate, async (req, res) => {
  res.json({ notifications: await MemberNotification.list({ limit: 30, viewer: req.user }) });
});

module.exports = router;
