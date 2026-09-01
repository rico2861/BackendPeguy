const express = require('express');
const crypto = require('crypto');
const { verifySignature } = require('../services/crossPlatform');
const { appendCrossPlatformPayment, readCrossPlatformPayments } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Inbound notification FROM DealPam — public (no JWT: DealPam's backend
// calls this directly, no browser/session involved), secured only by the
// HMAC signature, same trust model as the Bazik/NOWPayments webhooks.
router.post('/notify', (req, res) => {
  const signature = req.headers['x-cross-signature'];
  if (!verifySignature(req.body, signature)) {
    console.warn('[cross-platform notify] invalid or unconfigured signature — ignored');
    return res.status(200).json({ ok: true }); // ack anyway, don't let it retry forever
  }
  const body = req.body || {};
  appendCrossPlatformPayment({
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...body,
  }).catch((err) => console.error('[cross-platform notify] failed to store:', err.message));
  res.status(200).json({ ok: true });
});

// Admin/moderator visibility into what the other platform has reported —
// read-only, same shape/pattern as GET /payments and GET /admin/audit-logs.
router.get('/', authenticate, authorize('admin', 'moderator'), async (req, res) => {
  const payments = await readCrossPlatformPayments();
  res.json({ payments });
});

module.exports = router;
