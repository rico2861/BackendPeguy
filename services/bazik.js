// Thin client for the Bazik payment API (MonCash aggregator).
// Docs: https://api.bazik.io (see dashboard -> Developers).
// Environment (sandbox/production) is determined by which userID/secretKey
// pair you use — Bazik itself exposes a single base URL for both.
const crypto = require('crypto');

const BASE = process.env.BAZIK_API_URL || 'https://api.bazik.io';

let tokenCache = { value: null, expiresAt: 0 };

function isConfigured() {
  return !!(process.env.BAZIK_USER_ID && process.env.BAZIK_SECRET_KEY);
}

function isWebhookConfigured() {
  return !!process.env.BAZIK_WEBHOOK_SECRET;
}

async function getAccessToken() {
  if (!isConfigured()) {
    const err = new Error('BAZIK_USER_ID / BAZIK_SECRET_KEY manquants.');
    err.notConfigured = true;
    throw err;
  }
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 5000) return tokenCache.value;

  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userID: process.env.BAZIK_USER_ID,
      secretKey: process.env.BAZIK_SECRET_KEY,
    }),
  });
  const json = await res.json().catch(() => ({}));
  // The live API's actual response shape is { success, token, user_id,
  // expires_at } — expires_at is an absolute ms timestamp, not the
  // expires_in-seconds field shown in the docs' example response.
  if (!res.ok || !json.success || !json.token) {
    throw new Error(`Bazik /token a répondu ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  tokenCache = { value: json.token, expiresAt: json.expires_at || now + 55 * 60 * 1000 };
  return tokenCache.value;
}

// amountGdes is in HTG (gourdes) — Bazik's `gdes` field.
// referenceId must be unique per transaction (idempotency); we pass our
// own Payment.id so webhooks/notifications can be matched back to it.
async function createPayment({ referenceId, amountGdes, description, customerFirstName, customerLastName, customerEmail }) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/moncash/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      gdes: amountGdes,
      description,
      referenceId,
      ...(customerFirstName ? { customerFirstName } : {}),
      ...(customerLastName ? { customerLastName } : {}),
      ...(customerEmail ? { customerEmail } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  // The live API's response is flat (no success/data wrapper as shown in
  // the docs): { orderId, redirectUrl, referenceId, status, environment, ... }.
  if (!res.ok || !json.redirectUrl) {
    throw new Error(`Bazik /moncash/token a répondu ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return {
    redirectUrl: json.redirectUrl,
    providerOrderId: json.orderId || null,
    providerReferenceId: json.referenceId || referenceId,
  };
}

// Verifies X-Bazik-Signature against timestamp.eventId.rawBody, HMAC-SHA256
// with the per-partner webhook secret. rawBody must be the exact raw
// request bytes/string — not the re-serialized parsed JSON.
function verifyWebhookSignature({ timestamp, eventId, rawBody, signature }) {
  if (!isWebhookConfigured() || !signature || !timestamp || !eventId || rawBody == null) return false;
  const signingString = `${timestamp}.${eventId}.${rawBody}`;
  const expected = crypto.createHmac('sha256', process.env.BAZIK_WEBHOOK_SECRET).update(signingString).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, isWebhookConfigured, createPayment, verifyWebhookSignature };
