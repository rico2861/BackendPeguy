const express = require('express');
const webPush = require('../services/webPush');
const User = require('../models/User');
const AdminNotification = require('../models/AdminNotification');
const MemberNotification = require('../models/MemberNotification');
const { notifyPublish } = require('../services/notifyPublish');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();

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
