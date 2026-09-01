const express = require('express');
const moncash = require('../services/moncash');
const nowpayments = require('../services/nowpayments');
const bazik = require('../services/bazik');
const { getPlans, priceForPlan, setPlanPrice } = require('../services/plans');
const { reconcile } = require('../services/paymentService');
const { sweepPendingPayments, getLastSyncStatus } = require('../services/paymentSync');
const mailer = require('../services/mailer');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');

const router = express.Router();

// Public: powers the pricing page — one source of truth (services/plans.js)
// instead of duplicating prices in the frontend.
router.get('/plans', async (req, res) => {
  res.json({ plans: await getPlans() });
});

// Admin-only: change what a plan costs, in both currencies at once —
// takes effect immediately (see services/plans.js), no redeploy needed.
router.put('/plans/:type', authenticate, authorize('admin'), async (req, res) => {
  const { usd, htg, days } = req.body || {};
  if (usd === undefined && htg === undefined && days === undefined) {
    return res.status(400).json({ error: 'Fournissez au moins un prix (usd, htg) ou une durée (days) à modifier.' });
  }
  if (usd !== undefined && !(Number(usd) >= 0)) return res.status(400).json({ error: 'Prix USD invalide.' });
  if (htg !== undefined && !(Number(htg) >= 0)) return res.status(400).json({ error: 'Prix HTG invalide.' });
  if (days !== undefined && !(Number(days) > 0)) return res.status(400).json({ error: 'Durée invalide.' });

  const before = await getPlans();
  const plans = await setPlanPrice(req.params.type, { usd, htg, days });
  recordAudit(req, {
    action: 'plan.price_changed',
    target: `plan:${req.params.type}`,
    previousValue: before[req.params.type] || null,
    newValue: plans[req.params.type],
  });
  res.json({ plans });
});

const API_BASE = process.env.PUBLIC_API_URL || 'http://localhost:5000/api';
const APP_BASE = process.env.PUBLIC_APP_URL || 'http://localhost:5173';

// Staff (moderator/admin) already have full VIP access via their role
// (see User.computeIsVip) — blocking this server-side too, not just
// hiding the buttons, so the rule holds even against a direct API call.
function blockStaffPayment(req, res, next) {
  if (req.user.role === 'moderator' || req.user.role === 'admin') {
    return res.status(403).json({ error: "Votre rôle donne déjà un accès complet — aucun paiement n'est nécessaire." });
  }
  next();
}

router.post('/moncash/create', authenticate, blockStaffPayment, async (req, res) => {
  try {
    const { planType } = req.body;
    const price = await priceForPlan(planType);
    if (!price) return res.status(400).json({ error: 'Plan invalide.' });
    if (!moncash.isConfigured()) {
      return res.status(503).json({
        error: 'MonCash pas encore configuré (MONCASH_CLIENT_ID / MONCASH_CLIENT_SECRET manquants dans backend/.env).',
      });
    }

    const payment = await Payment.create({ userId: req.user.id, planType, amountUsd: price.usd, amountHtg: price.htg, provider: 'moncash' });
    const { redirectUrl } = await moncash.createPayment({ orderId: payment.id, amountHtg: price.htg });
    await Payment.update(payment.id, {}, { source: 'system', message: 'Lien de paiement MonCash généré', raw: { redirectUrl } });
    res.json({ redirectUrl, paymentId: payment.id });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Erreur MonCash.' });
  }
});

router.post('/bazik/create', authenticate, blockStaffPayment, async (req, res) => {
  try {
    const { planType } = req.body;
    const price = await priceForPlan(planType);
    if (!price) return res.status(400).json({ error: 'Plan invalide.' });
    if (!bazik.isConfigured()) {
      return res.status(503).json({
        error: 'Bazik pas encore configuré (BAZIK_USER_ID / BAZIK_SECRET_KEY manquants dans backend/.env).',
      });
    }

    const payment = await Payment.create({ userId: req.user.id, planType, amountUsd: price.usd, amountHtg: price.htg, provider: 'bazik' });
    const [customerFirstName, ...rest] = String(req.user.name || '').trim().split(/\s+/);
    const customerLastName = rest.join(' ') || undefined;
    const { redirectUrl, providerOrderId } = await bazik.createPayment({
      referenceId: payment.id,
      amountGdes: price.htg,
      description: `PeguyTbn VIP — ${planType}`,
      customerFirstName: customerFirstName || undefined,
      customerLastName,
      customerEmail: req.user.email,
    });
    await Payment.update(payment.id, { providerOrderId }, { source: 'system', message: 'Lien de paiement Bazik généré', raw: { redirectUrl, providerOrderId } });
    res.json({ redirectUrl, paymentId: payment.id });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Erreur Bazik.' });
  }
});

router.post('/nowpayments/create', authenticate, blockStaffPayment, async (req, res) => {
  try {
    const { planType } = req.body;
    const price = await priceForPlan(planType);
    if (!price) return res.status(400).json({ error: 'Plan invalide.' });
    if (!nowpayments.isConfigured()) {
      return res.status(503).json({
        error: 'Paiement crypto pas encore configuré (NOWPAYMENTS_API_KEY manquant dans backend/.env).',
      });
    }

    const payment = await Payment.create({ userId: req.user.id, planType, amountUsd: price.usd, provider: 'nowpayments' });
    const { invoiceId, invoiceUrl } = await nowpayments.createInvoice({
      orderId: payment.id,
      priceAmountUsd: price.usd,
      orderDescription: `PeguyTbn VIP — ${planType} — ${req.user.name}`,
      successUrl: `${APP_BASE}/paiement/succes`,
      cancelUrl: `${APP_BASE}/paiement/echec`,
      ipnCallbackUrl: `${API_BASE}/payments/nowpayments/notify`,
      customerEmail: req.user.email,
    });
    await Payment.update(payment.id, { invoiceId }, { source: 'system', message: 'Facture NOWPayments créée', raw: { invoiceId, invoiceUrl } });
    res.json({ redirectUrl: invoiceUrl, paymentId: payment.id });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Erreur NOWPayments.' });
  }
});

// Polled by the three return pages right after the provider redirects
// the browser back — they don't know which specific transaction just
// happened, only that it's this user's most recent one.
router.get('/status/latest', authenticate, async (req, res) => {
  try {
    let payment = await Payment.findLatestForUser(req.user.id);
    if (!payment) return res.json({ payment: null });
    payment = await reconcile(payment);
    res.json({ payment });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Erreur de vérification du paiement.' });
  }
});

// The MonCash business portal's "Payment notifications link" — a
// server-to-server callback so settlement isn't missed if the customer
// closes their browser before the redirect completes. MonCash's exact
// payload isn't guaranteed by the docs, so whatever it sends, we
// re-verify with MonCash's own API before crediting anything.
router.post('/moncash/notify', async (req, res) => {
  try {
    const { orderId, transactionId } = req.body || {};
    let payment = orderId ? await Payment.findById(orderId) : null;
    if (payment) {
      await Payment.update(payment.id, {}, { source: 'webhook', message: 'Callback MonCash reçu', raw: req.body });
      await reconcile(payment, 'webhook');
    } else if (transactionId && moncash.isConfigured()) {
      const result = await moncash.retrieveByTransactionId(transactionId).catch(() => null);
      if (result?.found) console.log('[moncash notify] unmatched transaction', result.payment);
    }
  } catch (err) {
    console.error('[moncash notify] error', err.message);
  }
  res.status(200).json({ ok: true });
});

// Bazik's webhook — signature-verified (HMAC-SHA256 over
// timestamp.eventId.rawBody, see services/bazik.js) before anything in the
// body is trusted. Payment lookup is by referenceId, which we set to our
// own Payment.id when creating the payment (see POST /bazik/create).
router.post('/bazik/notify', async (req, res) => {
  try {
    const signature = req.headers['x-bazik-signature'];
    const timestamp = req.headers['x-bazik-timestamp'];
    const eventId = req.headers['x-bazik-event-id'];
    if (!bazik.verifyWebhookSignature({ timestamp, eventId, rawBody: req.rawBody, signature })) {
      console.warn('[bazik notify] invalid or unconfigured signature — ignored');
      return res.status(200).json({ ok: true }); // ack anyway, don't let it retry forever
    }

    // Flat payload (per docs), e.g.:
    // { type: "payment.succeeded", orderId, transactionId, status: "successful",
    //   amount, currency, referenceId, timestamp }
    // We only handle payment.* events here — transfer.* events (payouts,
    // not something this app initiates) are acknowledged and ignored.
    const body = req.body || {};
    const { type, referenceId, transactionId, status: bazikStatus } = body;
    if (!String(type || '').startsWith('payment.')) {
      return res.status(200).json({ ok: true });
    }

    const payment = referenceId ? await Payment.findById(referenceId) : null;
    if (payment && payment.status === 'pending') {
      await Payment.update(payment.id, {}, { source: 'webhook', message: `Callback Bazik reçu (${bazikStatus || type})`, raw: body });
      const status = bazikStatus === 'successful' ? 'success' : bazikStatus === 'pending' ? 'pending' : 'failed';
      if (status !== 'pending') {
        // Re-read right before mutating: closes the race window where two
        // webhook retries arrive close together (see the NOWPayments
        // handler below for why this matters).
        const fresh = await Payment.findById(payment.id);
        if (fresh && fresh.status === 'pending') {
          await Payment.update(
            payment.id,
            { status, transactionId: transactionId || null },
            { source: 'webhook', message: `Paiement réglé via webhook Bazik signé : ${status}`, raw: body }
          );
          if (status === 'success') {
            await User.setPlan(payment.userId, {
              type: payment.planType,
              amountUsd: payment.amountUsd,
              amountHtg: payment.amountHtg,
              provider: payment.provider,
            });
            const user = await User.findById(payment.userId);
            if (user) {
              mailer
                .sendPaymentConfirmationEmail(User.toPublic(user), payment)
                .catch((err) => console.error('[mailer] payment confirmation email failed:', err.message));
            }
          }
        }
      }
    } else if (!payment) {
      console.log('[bazik notify] unmatched referenceId', referenceId);
    }
  } catch (err) {
    console.error('[bazik notify] error', err.message);
  }
  res.status(200).json({ ok: true });
});

// NOWPayments' IPN callback — signature-verified (HMAC-SHA512, see
// services/nowpayments.js) before anything in the body is trusted.
router.post('/nowpayments/notify', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!nowpayments.verifyIpnSignature(req.body, signature)) {
      console.warn('[nowpayments notify] invalid signature — ignored');
      return res.status(200).json({ ok: true }); // ack anyway, don't let it retry forever
    }

    const { order_id: orderId, payment_id: providerPaymentId, payment_status: paymentStatus, pay_currency: payCurrency, actually_paid: actuallyPaid } = req.body || {};
    const payment = orderId ? await Payment.findById(orderId) : null;
    if (payment && payment.status === 'pending') {
      await Payment.update(payment.id, {}, { source: 'webhook', message: `Callback NOWPayments reçu (${paymentStatus})`, raw: req.body });
      // Capture the real payment_id on the very first callback (even a
      // "waiting"/"confirming" one) — it's the only way we can later
      // re-verify this payment ourselves if a subsequent IPN is missed
      // (see services/paymentService.js for why).
      if (providerPaymentId && !payment.providerPaymentId) {
        await Payment.update(payment.id, { providerPaymentId, payCurrency: payCurrency || null });
      }
      const status = nowpayments.statusFromNowPayments(paymentStatus);
      if (status !== 'pending') {
        // Re-read right before mutating: closes the race window where two
        // IPN retries arrive close together and both pass the `pending`
        // check made at the top of this handler — only the one that sees
        // 'pending' *here* is allowed to grant the plan.
        const fresh = await Payment.findById(payment.id);
        if (fresh && fresh.status === 'pending') {
          await Payment.update(
            payment.id,
            { status, actuallyPaid: actuallyPaid || null },
            { source: 'webhook', message: `Paiement réglé via webhook signé : ${status}`, raw: req.body }
          );
          if (status === 'success') {
            await User.setPlan(payment.userId, {
              type: payment.planType,
              amountUsd: payment.amountUsd,
              amountHtg: payment.amountHtg,
              provider: payment.provider,
            });
            const user = await User.findById(payment.userId);
            if (user) {
              mailer
                .sendPaymentConfirmationEmail(User.toPublic(user), payment)
                .catch((err) => console.error('[mailer] payment confirmation email failed:', err.message));
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[nowpayments notify] error', err.message);
  }
  res.status(200).json({ ok: true });
});

// Admin-only visibility into every payment ever created, across both
// providers — this is the direct answer to "how do I know a customer
// really paid": check here. Status reflects the provider's own records
// (see reconcile above), not just what the browser reported.
router.get('/', authenticate, authorize('admin', 'moderator'), async (req, res) => {
  const users = new Map((await User.findAll()).map((u) => [u.id, u]));
  const payments = (await Payment.listAll()).map((p) => ({
    ...p,
    userName: users.get(p.userId)?.name || 'Compte supprimé',
    userEmail: users.get(p.userId)?.email || null,
    userPhone: users.get(p.userId)?.phone || null,
  }));
  res.json({ payments, lastSync: getLastSyncStatus() });
});

// Manually kick the background sweep instead of waiting up to 2 minutes
// — useful right after telling a customer "I just paid, check now".
router.post('/sync-now', authenticate, authorize('admin'), async (req, res) => {
  const result = await sweepPendingPayments();
  res.json(result);
});

// Full detail + audit trail for one payment — the actual "proof of
// payment": every timestamped event from creation to settlement,
// sourced from provider webhooks/API checks. Accessible to the admin
// or to the customer the payment belongs to (their own receipt).
router.get('/:id', authenticate, async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  if (req.user.role !== 'admin' && payment.userId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  res.json({ payment });
});

module.exports = router;
