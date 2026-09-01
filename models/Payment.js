const crypto = require('crypto');
const { readPayments, writePayments } = require('../db');

function nowIso() {
  return new Date().toISOString();
}

// Every payment carries its own append-only audit trail (like a CDR /
// call-detail-record for a phone call, but for a transaction): who
// triggered each check, what changed, and when. This is what answers
// "prove to me this customer really paid" — a timestamped chain from
// creation to settlement, sourced from the provider's own API/webhook
// responses, not just our own say-so.
function logEvent(payment, { source, message, raw }) {
  const entry = { at: nowIso(), source, message, raw: raw ?? null };
  payment.history = [...(payment.history || []), entry];
  return payment;
}

// "PGY_" prefix on every payment id — this is what we send as `orderId`/
// `referenceId` to every gateway (MonCash/Bazik/NOWPayments), so it's what
// comes back in webhooks/return redirects too. Since DealPam now shares
// its own MonCash return page with this app (their MonCash portal return
// URL can't be app-specific — see routes/payments.js POST /external/confirm),
// they need to recognize at a glance that a reference belongs to PeguyTbn
// rather than one of their own orders, without first trying (and failing)
// a local lookup for every single unknown reference.
const REFERENCE_PREFIX = 'PGY_';

// Short, client-facing transaction id — shown to the customer instead of
// the internal reference (`id`, sent as orderId/referenceId to gateways)
// or the gateway's own transaction/payment id, neither of which the
// client should see (see routes/auth.js GET /subscription, which strips
// both before sending payment history to the client — only admin gets
// the full picture, via GET /payments and /payments/lookup). Never sent
// to any provider, purely a display/support-lookup convenience.
function generateDisplayId() {
  return `PT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function create({ userId, planType, amountUsd, amountHtg, provider }) {
  const payments = await readPayments();
  const payment = {
    id: `${REFERENCE_PREFIX}${crypto.randomUUID()}`, // used as the provider-facing `orderId`
    displayId: generateDisplayId(),
    userId,
    planType,
    amountUsd,
    amountHtg: amountHtg ?? null,
    status: 'pending', // pending | success | failed | partial | expired
    transactionId: null, // MonCash transaction id
    reference: null, // MonCash reference
    invoiceId: null, // NOWPayments invoice id (set at creation)
    providerPaymentId: null, // NOWPayments payment id (only exists once customer sends funds)
    providerOrderId: null, // Bazik's own orderId (distinct from this payment's id, which we send as referenceId)
    payCurrency: null, // e.g. 'btc', 'usdttrc20' — which crypto the customer actually chose
    payAmount: null, // expected amount in that crypto
    actuallyPaid: null, // amount NOWPayments actually received
    provider, // 'moncash' | 'nowpayments' | 'bazik'
    history: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  logEvent(payment, { source: 'system', message: `Paiement créé (${provider}, ${planType})` });
  payments.push(payment);
  await writePayments(payments);
  return payment;
}

async function findById(id) {
  const payments = await readPayments();
  return payments.find((p) => p.id === id) || null;
}

// Most recent pending/just-created payment for a user — used by the
// return pages, which MonCash redirects to without any identifying
// transaction info attached.
async function findLatestForUser(userId) {
  const payments = (await readPayments())
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return payments[0] || null;
}

// `event` (optional) records this update in the payment's audit trail:
// { source: 'webhook'|'manual-check'|'background-sweep'|'admin', message, raw }
async function update(id, data, event) {
  const payments = await readPayments();
  const idx = payments.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  let payment = { ...payments[idx], ...data, updatedAt: nowIso() };
  if (event) payment = logEvent(payment, event);
  payments[idx] = payment;
  await writePayments(payments);
  return payments[idx];
}

async function listAll() {
  return [...(await readPayments())].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Full payment history for one user (most recent first) — powers the
// "Mon abonnement" page's payment history section.
async function listForUser(userId) {
  return (await readPayments())
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { create, findById, findLatestForUser, update, listAll, listForUser, REFERENCE_PREFIX };
