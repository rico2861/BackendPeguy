const express = require('express');
const webPush = require('../services/webPush');
const User = require('../models/User');
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
// or combos are published.
router.post('/broadcast', authenticate, authorize('moderator', 'admin'), async (req, res) => {
  const { title, body, url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title et body sont requis.' });
  try {
    const result = await webPush.broadcast({ title, body, url });
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "Échec de l'envoi." });
  }
});

module.exports = router;
