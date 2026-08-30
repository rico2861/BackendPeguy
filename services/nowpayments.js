// Thin client for NOWPayments (crypto payments).
// Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
const crypto = require('crypto');

const MODE = (process.env.NOWPAYMENTS_MODE || 'live').toLowerCase();
const BASE = MODE === 'sandbox' ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';

function isConfigured() {
  return !!process.env.NOWPAYMENTS_API_KEY;
}

function isIpnConfigured() {
  return !!process.env.NOWPAYMENTS_IPN_SECRET;
}

async function apiCall(method, path, body) {
  if (!isConfigured()) {
    const err = new Error('NOWPAYMENTS_API_KEY manquant.');
    err.notConfigured = true;
    throw err;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NOWPayments ${path} a répondu ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

const LOOKS_LIKE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// Hosted checkout page: the customer picks their crypto of choice on
// NOWPayments' own page, we never handle wallet addresses ourselves.
// customer_email is passed through so the transaction is identifiable
// by customer on NOWPayments' own dashboard too, not just ours — but
// NOWPayments validates it strictly (rejects e.g. .local dev/test
// domains with a 400), so a payment must never fail to be created just
// because the account's email doesn't pass their validator.
async function createInvoice({ orderId, priceAmountUsd, successUrl, cancelUrl, ipnCallbackUrl, orderDescription, customerEmail }) {
  const body = {
    price_amount: priceAmountUsd,
    price_currency: 'usd',
    order_id: orderId,
    order_description: orderDescription,
    success_url: successUrl,
    cancel_url: cancelUrl,
    ipn_callback_url: ipnCallbackUrl,
    // Network/exchange fees are billed to the customer so the merchant
    // receives the full price_amount net — requires a fixed rate.
    is_fixed_rate: true,
    is_fee_paid_by_user: true,
  };
  if (customerEmail && LOOKS_LIKE_EMAIL_RE.test(customerEmail) && !customerEmail.endsWith('.local')) {
    body.customer_email = customerEmail;
  }
  const json = await apiCall('POST', '/invoice', body);
  return { invoiceId: json.id, invoiceUrl: json.invoice_url };
}

// Needs a real `payment_id` (x-api-key only, no JWT) — NOT the invoice
// id from createInvoice(). A payment_id only exists once the customer
// has opened the hosted invoice page and picked a coin; we only learn
// it from the first IPN callback we receive for that order (see
// routes/payments.js). There is no invoice-id or order-id lookup
// available on the x-api-key auth tier: NOWPayments' only endpoint for
// that (GET /v1/payment/ with an orderId filter) additionally requires
// a JWT obtained via dashboard email+password, which we don't hold.
async function getPaymentStatus(paymentId) {
  return apiCall('GET', `/payment/${paymentId}`);
}

// NOWPayments signs the IPN body with HMAC-SHA512 over the JSON
// serialization of the body with keys sorted alphabetically — not the
// raw request bytes — then sends it in the x-nowpayments-sig header.
function verifyIpnSignature(body, signatureHeader) {
  if (!isIpnConfigured() || !signatureHeader) return false;
  const sortedJson = JSON.stringify(body, Object.keys(body).sort());
  const expected = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(sortedJson).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signatureHeader), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// finished = fully confirmed & credited. partially_paid = underpaid.
// waiting/confirming/confirmed/sending = still in flight (not final).
// failed/expired/refunded = dead.
function statusFromNowPayments(paymentStatus) {
  if (paymentStatus === 'finished') return 'success';
  if (paymentStatus === 'partially_paid') return 'partial';
  if (['failed', 'expired', 'refunded'].includes(paymentStatus)) return 'failed';
  return 'pending';
}

module.exports = {
  isConfigured,
  isIpnConfigured,
  mode: MODE,
  createInvoice,
  getPaymentStatus,
  verifyIpnSignature,
  statusFromNowPayments,
};
