// Real-time, best-effort payment sharing between PeguyTbn and DealPam —
// two separate products/backends run by the same owner, on different
// frameworks (this is plain Express, DealPam is NestJS). No shared
// database, no message queue: a signed HTTP POST fired the moment a
// payment settles here, and a signed endpoint (routes/crossPlatform.js)
// accepting the same from DealPam. Read-only on both ends — this never
// changes plan/VIP state, it only logs what happened on the other
// platform for admin visibility.
//
// Signing is over the SORTED-KEY JSON serialization of the payload object
// (same trick as NOWPayments' own IPN signature in services/nowpayments.js)
// rather than the raw request bytes — deliberately, so neither side needs
// raw-body-capturing middleware wired in just for this one endpoint;
// Express's default JSON body parser and Nest's are both enough since we
// sign/verify the *parsed* object, not its exact byte representation.
const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.CROSS_PLATFORM_WEBHOOK_SECRET && process.env.CROSS_PLATFORM_DEALPAM_URL);
}

function canonicalSign(payload) {
  const sortedJson = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHmac('sha256', process.env.CROSS_PLATFORM_WEBHOOK_SECRET).update(sortedJson).digest('hex');
}

// Verifies X-Cross-Signature against the sorted-key JSON of the (already
// parsed) request body — timing-safe comparison like every other webhook
// verifier in this codebase.
function verifySignature(body, signatureHeader) {
  if (!process.env.CROSS_PLATFORM_WEBHOOK_SECRET || !signatureHeader || !body || typeof body !== 'object') return false;
  const expected = canonicalSign(body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signatureHeader), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Fire-and-forget — a network hiccup or DealPam being down must never
// affect the PeguyTbn payment flow this is attached to. Called right
// alongside the existing confirmation-email calls, so it fires exactly
// when a payment settles (success or failure), from every settlement path
// (reconcile(), and the Bazik/NOWPayments webhook handlers that update
// status directly without going through reconcile()).
async function notifyDealPam(payment, user) {
  if (!isConfigured()) return;
  const payload = {
    source: 'peguytbn',
    referenceId: payment.id,
    provider: payment.provider,
    status: payment.status,
    planType: payment.planType,
    amountUsd: payment.amountUsd,
    amountHtg: payment.amountHtg,
    userName: user?.name || null,
    userEmail: user?.email || null,
    userPhone: user?.phone || null,
    at: new Date().toISOString(),
  };
  try {
    const res = await fetch(`${process.env.CROSS_PLATFORM_DEALPAM_URL.replace(/\/$/, '')}/cross-platform/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cross-signature': canonicalSign(payload) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`DealPam a répondu ${res.status}`);
  } catch (err) {
    console.error('[crossPlatform] notify DealPam failed:', err.message);
  }
}

module.exports = { isConfigured, verifySignature, notifyDealPam };
