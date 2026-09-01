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
// A payment link that's still unconfirmed after this long is treated as
// abandoned — expired rather than left "pending" forever, which used to
// read as "still in progress" indefinitely in the admin transactions list
// even for a checkout the customer walked away from hours ago. 3h is
// generous for even a slow crypto confirmation while still giving a
// reasonably prompt "this didn't go through" signal to admin and client.
const PENDING_EXPIRE_MS = 3 * 60 * 60 * 1000;

let lastRun = { at: 0, checked: 0, settled: 0, expired: 0, error: null };

async function sweepPendingPayments() {
  const now = Date.now();
  let checked = 0;
  let settled = 0;
  let expired = 0;
  try {
    const allPending = (await Payment.listAll()).filter((p) => p.status === 'pending');

    for (const payment of allPending) {
      const age = now - new Date(payment.createdAt).getTime();
      if (age >= PENDING_MAX_AGE_MS) continue; // too old to bother re-checking at all

      if (age >= PENDING_EXPIRE_MS) {
        // One last check before giving up, in case the provider confirms
        // right at the edge of the window — only expire if it's still
        // genuinely pending after that.
        const rechecked = await reconcile(payment, 'background-sweep').catch(() => payment);
        if (rechecked.status !== 'pending') {
          settled += 1;
        } else {
          await Payment.update(payment.id, { status: 'expired' }, {
            source: 'background-sweep',
            message: `Paiement expiré : aucune confirmation reçue en ${Math.round(PENDING_EXPIRE_MS / 3_600_000)}h.`,
          });
          expired += 1;
        }
        checked += 1;
        continue;
      }

      checked += 1;
      const after = await reconcile(payment, 'background-sweep').catch(() => payment);
      if (after.status !== 'pending') settled += 1;
    }
    lastRun = { at: now, checked, settled, expired, error: null };
  } catch (err) {
    lastRun = { at: now, checked, settled, expired, error: err.message };
  }
  return lastRun;
}

function getLastSyncStatus() {
  return lastRun;
}

module.exports = { sweepPendingPayments, getLastSyncStatus };
