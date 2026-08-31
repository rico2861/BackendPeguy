const express = require('express');
const webPush = require('../services/webPush');
const mailer = require('../services/mailer');
const User = require('../models/User');
const AdminNotification = require('../models/AdminNotification');
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

  let pushResult = { sent: 0 };
  try {
    pushResult = await webPush.broadcast({ title, body, url });
  } catch (err) {
    // Push failure shouldn't block the VIP e-mail fan-out below.
  }

  let vipEmailsSent = 0;
  if (mailer.isConfigured()) {
    const users = await User.findAll();
    const vipUsers = users.filter((u) => User.computeIsVip(u));
    const results = await Promise.allSettled(
      vipUsers.map((u) => mailer.sendNewPicksEmail(u, { message: body }))
    );
    vipEmailsSent = results.filter((r) => r.status === 'fulfilled').length;
  }

  await AdminNotification.create({
    title: `${req.user.email} a notifié les abonnés`,
    body: `"${title}" — push: ${pushResult.sent ?? 0}, e-mails VIP: ${vipEmailsSent}.`,
    actorName: req.user.email,
  });

  res.json({ ...pushResult, vipEmailsSent });
});

router.get('/admin/notifications', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  res.json({ notifications: await AdminNotification.list({ limit: 30 }) });
});

module.exports = router;
