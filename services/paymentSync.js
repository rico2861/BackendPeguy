// The real answer to "how do I know a customer actually paid if they
// never came back to the site?": don't rely on the redirect at all.
// Crypto payments in particular can take anywhere from a couple of
// minutes to over an hour to reach enough confirmations — the customer
// may well close the NOWPayments tab before that finishes. This sweep
// re-checks every still-pending payment against the provider's API on
// a timer, so VIP access gets granted automatically the moment the
// provider confirms it — independent of any redirect or webhook.
const Payment = require('../models/Payment');
const { reconcile } = require('./paymentService');

const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000; // stop polling ancient abandoned payments

let lastRun = { at: 0, checked: 0, settled: 0, error: null };

async function sweepPendingPayments() {
  const now = Date.now();
  let checked = 0;
  let settled = 0;
  try {
    const pending = (await Payment.listAll()).filter(
      (p) => p.status === 'pending' && now - new Date(p.createdAt).getTime() < PENDING_MAX_AGE_MS
    );
    for (const payment of pending) {
      checked += 1;
      const after = await reconcile(payment, 'background-sweep').catch(() => payment);
      if (after.status !== 'pending') settled += 1;
    }
    lastRun = { at: now, checked, settled, error: null };
  } catch (err) {
    lastRun = { at: now, checked, settled, error: err.message };
  }
  return lastRun;
}

function getLastSyncStatus() {
  return lastRun;
}

module.exports = { sweepPendingPayments, getLastSyncStatus };
