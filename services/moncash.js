// Thin client for the MonCash (Digicel Haiti) REST payment API.
// Docs: https://sandbox.moncashbutton.digicelgroup.com/Moncash-business/resources/doc/RestAPI_MonCash_doc.pdf
// Get business (merchant) credentials from the MonCash business portal —
// sandbox first, then live once approved.
const MODE = (process.env.MONCASH_MODE || 'sandbox').toLowerCase();
const IS_LIVE = MODE === 'live';

const HOST_REST_API = IS_LIVE
  ? 'https://moncashbutton.digicelgroup.com/Api'
  : 'https://sandbox.moncashbutton.digicelgroup.com/Api';

const GATEWAY_BASE = IS_LIVE
  ? 'https://moncashbutton.digicelgroup.com/Moncash-middleware'
  : 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware';

let tokenCache = { value: null, expiresAt: 0 };

function isConfigured() {
  return !!(process.env.MONCASH_CLIENT_ID && process.env.MONCASH_CLIENT_SECRET);
}

async function getAccessToken() {
  if (!isConfigured()) {
    const err = new Error('MONCASH_CLIENT_ID / MONCASH_CLIENT_SECRET manquants.');
    err.notConfigured = true;
    throw err;
  }
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 5000) return tokenCache.value;

  const basicAuth = Buffer.from(`${process.env.MONCASH_CLIENT_ID}:${process.env.MONCASH_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${HOST_REST_API}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: 'scope=read,write&grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MonCash oauth/token a répondu ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  tokenCache = { value: json.access_token, expiresAt: now + (json.expires_in || 55) * 1000 };
  return tokenCache.value;
}

async function apiPost(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${HOST_REST_API}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) {
    throw new Error(`MonCash ${path} a répondu ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { status: res.status, json };
}

// amount is in HTG (MonCash processes gourdes, not USD).
async function createPayment({ orderId, amountHtg }) {
  const { json } = await apiPost('/v1/CreatePayment', { amount: amountHtg, orderId });
  const token = json?.payment_token?.token;
  if (!token) throw new Error('MonCash CreatePayment: réponse sans payment_token.');
  return {
    token,
    redirectUrl: `${GATEWAY_BASE}/Payment/Redirect?token=${token}`,
    mode: json.mode || MODE,
  };
}

// Returns { found: false } on a 404 ("transaction not settled/found yet"
// — normal right after redirect, poll again shortly), otherwise the
// payment details from MonCash.
async function retrieveByOrderId(orderId) {
  const { status, json } = await apiPost('/v1/RetrieveOrderPayment', { orderId });
  if (status === 404) return { found: false };
  return { found: true, payment: json.payment };
}

async function retrieveByTransactionId(transactionId) {
  const { status, json } = await apiPost('/v1/RetrieveTransactionPayment', { transactionId });
  if (status === 404) return { found: false };
  return { found: true, payment: json.payment };
}

module.exports = { isConfigured, mode: MODE, createPayment, retrieveByOrderId, retrieveByTransactionId };
