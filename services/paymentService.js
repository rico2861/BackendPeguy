// Shared reconciliation logic used by: the return pages' on-demand
// check, the provider webhooks, the admin payments list, and the
// background sweep (services/paymentSync.js) that grants access even
// if the customer is never redirected back to the app at all.
const moncash = require('./moncash');
const nowpayments = require('./nowpayments');
const mailer = require('./mailer');
const Payment = require('../models/Payment');
const User = require('../models/User');

function statusFromMonCashMessage(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('success')) return 'success';
  if (m.includes('partial') || m.includes('pending')) return 'partial';
  return 'failed';
}

// Re-checks a pending payment against the provider's own records — never
// trusts a client-side redirect or an unverified webhook alone — and,
// on success, grants the plan exactly once. Idempotent: calling this on
// an already-settled payment is a no-op (status is no longer 'pending').
async function reconcile(payment, source = 'manual-check') {
  if (!payment || payment.status !== 'pending') return payment;

  let status = 'pending';
  let extra = {};
  let raw = null;

  if (payment.provider === 'moncash') {
    if (!moncash.isConfigured()) return payment;
    const result = await moncash.retrieveByOrderId(payment.id);
    if (!result.found) return payment;
    status = statusFromMonCashMessage(result.payment?.message);
    extra = { transactionId: result.payment?.transaction_id || null, reference: result.payment?.reference || null };
    raw = result.payment;
  } else if (payment.provider === 'nowpayments') {
    // NOWPayments has no orderId/invoiceId status lookup on the plain
    // x-api-key auth tier (the list endpoint that would allow it also
    // requires a JWT from dashboard email+password, which we don't
    // hold) — so until at least one IPN callback has told us the real
    // payment_id, there is nothing to re-check yet. This is why a
    // reachable IPN URL isn't optional for crypto payments the way the
    // background sweep alone is for MonCash.
    if (!nowpayments.isConfigured() || !payment.providerPaymentId) return payment;
    const found = await nowpayments.getPaymentStatus(payment.providerPaymentId).catch(() => null);
    if (!found) return payment;
    status = nowpayments.statusFromNowPayments(found.payment_status);
    extra = {
      payCurrency: found.pay_currency || null,
      payAmount: found.pay_amount || null,
      actuallyPaid: found.actually_paid || null,
    };
    raw = found;
    if (status === 'pending') {
      return await Payment.update(payment.id, extra, {
        source,
        message: `Toujours en attente (statut fournisseur : ${found.payment_status})`,
        raw,
      });
    }
  } else if (payment.provider === 'bazik') {
    // Bazik's public API doesn't document a status-lookup endpoint (only
    // creation + webhooks), so unlike MonCash/NOWPayments there is nothing
    // to actively poll here — settlement can only arrive via the signed
    // webhook (see routes/payments.js POST /bazik/notify).
    return payment;
  } else {
    return payment;
  }

  // Re-check right before granting — the same guard the webhook handlers
  // below use — since the initial `payment.status !== 'pending'` check at
  // the top of this function can be stale by the time the provider network
  // call above resolves: the 2-minute sweep, a client's on-demand check,
  // and a webhook can all be mid-flight on the same payment concurrently.
  // Without this, each caller would append its own duplicate 'success'
  // update, planHistory entry, and confirmation email.
  const fresh = await Payment.findById(payment.id);
  if (!fresh || fresh.status !== 'pending') return fresh || payment;

  const updated = await Payment.update(payment.id, { status, ...extra }, {
    source,
    message: `Statut vérifié auprès de ${payment.provider} : ${status}`,
    raw,
  });
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
  return updated;
}

// Human-readable reason for a NOWPayments status, using whatever extra
// detail the provider gave us (amount actually received vs. expected is
// the most common one — an underpaid crypto transfer never completes).
function nowPaymentsReason(paymentStatus, found) {
  switch (paymentStatus) {
    case 'finished':
      return 'Paiement confirmé et crédité intégralement.';
    case 'partially_paid':
      return `Montant insuffisant reçu : ${found.actually_paid ?? '?'} ${found.pay_currency || ''} reçu sur ${found.pay_amount ?? '?'} attendu.`;
    case 'expired':
      return "La fenêtre de paiement a expiré avant réception des fonds (le client n'a pas envoyé les fonds à temps).";
    case 'failed':
      return "Le fournisseur a explicitement marqué la transaction comme échouée.";
    case 'refunded':
      return 'Les fonds reçus ont été remboursés au client.';
    case 'waiting':
      return "En attente que le client envoie les fonds.";
    case 'confirming':
      return 'Fonds envoyés, en attente de confirmations blockchain.';
    case 'confirmed':
      return 'Confirmations blockchain suffisantes, en attente de crédit final.';
    case 'sending':
      return 'Conversion/versement en cours côté NOWPayments.';
    default:
      return `Statut fournisseur : ${paymentStatus}.`;
  }
}

// Read-only live check against the provider's own API — never mutates the
// stored payment (unlike reconcile, which only re-checks 'pending'
// payments and grants access on success). This is what powers the admin
// "vérifier un paiement" lookup: get the provider's *current* truth for a
// payment regardless of what status we last recorded, and a plain-language
// reason when it's not a success. Distinct from reconcile() so a lookup on
// an already-settled or already-expired payment can still ask the
// provider "so what actually happened here?" instead of being a no-op.
async function liveCheck(payment) {
  if (!payment) return { checked: false, reason: 'Paiement introuvable.' };

  if (payment.provider === 'moncash') {
    if (!moncash.isConfigured()) {
      return { checked: false, provider: 'moncash', reason: 'MonCash direct non configuré sur ce serveur.' };
    }
    const result = await moncash.retrieveByOrderId(payment.id).catch((err) => ({ error: err.message }));
    if (result?.error) {
      return { checked: false, provider: 'moncash', reason: `Erreur MonCash : ${result.error}` };
    }
    if (!result?.found) {
      return {
        checked: true,
        provider: 'moncash',
        status: null,
        reason: "MonCash n'a aucune trace de cette transaction — le client n'a probablement jamais complété le paiement sur leur page.",
        raw: null,
      };
    }
    const status = statusFromMonCashMessage(result.payment?.message);
    return {
      checked: true,
      provider: 'moncash',
      status,
      // MonCash's own `message` field IS the human-readable explanation —
      // surfaced verbatim rather than re-worded, since it's already their
      // authoritative account of what happened (insufficient funds,
      // cancelled, etc.).
      reason: result.payment?.message || `Statut fournisseur : ${status}.`,
      raw: result.payment,
    };
  }

  if (payment.provider === 'nowpayments') {
    if (!nowpayments.isConfigured()) {
      return { checked: false, provider: 'nowpayments', reason: 'NOWPayments non configuré sur ce serveur.' };
    }
    if (!payment.providerPaymentId) {
      return {
        checked: false,
        provider: 'nowpayments',
        reason:
          "Aucun paiement crypto n'a été initié côté NOWPayments (le client n'a jamais reçu de callback IPN — probablement jamais ouvert la page de paiement ou choisi une crypto).",
      };
    }
    const found = await nowpayments.getPaymentStatus(payment.providerPaymentId).catch((err) => ({ error: err.message }));
    if (found?.error) {
      return { checked: false, provider: 'nowpayments', reason: `Erreur NOWPayments : ${found.error}` };
    }
    const status = nowpayments.statusFromNowPayments(found.payment_status);
    return {
      checked: true,
      provider: 'nowpayments',
      status,
      reason: nowPaymentsReason(found.payment_status, found),
      raw: found,
    };
  }

  if (payment.provider === 'bazik') {
    // No documented status-lookup endpoint on Bazik's public API — only
    // creation + webhooks exist, so there is nothing to actively poll
    // here (see the same limitation noted in reconcile() above). Honest
    // about the limitation rather than pretending to check.
    return {
      checked: false,
      provider: 'bazik',
      reason:
        "Bazik ne fournit pas d'API de vérification à la demande — le statut affiché reflète le dernier webhook reçu (voir l'historique ci-dessous), pas une vérification en direct.",
    };
  }

  return { checked: false, reason: 'Fournisseur inconnu.' };
}

module.exports = { reconcile, liveCheck };
