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
  } else {
    return payment;
  }

  const updated = await Payment.update(payment.id, { status, ...extra }, {
    source,
    message: `Statut vérifié auprès de ${payment.provider} : ${status}`,
    raw,
  });
  if (status === 'success') {
    await User.setPlan(payment.userId, { type: payment.planType });
    const user = await User.findById(payment.userId);
    if (user) {
      mailer
        .sendPaymentConfirmationEmail(User.toPublic(user), payment)
        .catch((err) => console.error('[mailer] payment confirmation email failed:', err.message));
    }
  }
  return updated;
}

module.exports = { reconcile };
