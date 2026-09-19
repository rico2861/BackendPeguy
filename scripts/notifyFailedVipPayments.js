// One-off: emails every user whose most recent VIP payment attempt is
// still sitting at status 'failed', telling them to retry so they don't
// miss this weekend's VIP coupons. Not wired into the API — this is a
// manual nudge run by hand when it's actually needed, not a recurring job.
//
// Usage (from BackendPeguy/, with the same env this app runs with):
//   node scripts/notifyFailedVipPayments.js        # sends for real
//   node scripts/notifyFailedVipPayments.js --dry-run   # lists recipients only
require('dotenv').config();

// Same corporate-proxy TLS workaround as server.js/scripts/resend-domain.js.
const fs = require('fs');
const path = require('path');
const { Agent, setGlobalDispatcher } = require('undici');
const winCaBundle = path.join(__dirname, '..', 'windows-root-ca.pem');
if (fs.existsSync(winCaBundle)) {
  setGlobalDispatcher(new Agent({ connect: { ca: fs.readFileSync(winCaBundle, 'utf8') } }));
}

const Payment = require('../models/Payment');
const User = require('../models/User');
const mailer = require('../services/mailer');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const payments = await Payment.listAll();
  // Only the failed VIP attempts, and only the LATEST one per user — a
  // user who failed twice then succeeded, or failed twice in a row,
  // should get exactly one e-mail, not one per failed record. listAll()
  // is already sorted newest-first, so the first failed payment seen per
  // userId is that user's latest one.
  const latestFailedByUser = new Map();
  for (const p of payments) {
    if (p.status !== 'failed' || p.planType !== 'vip') continue;
    if (!latestFailedByUser.has(p.userId)) latestFailedByUser.set(p.userId, p);
  }

  if (latestFailedByUser.size === 0) {
    console.log('No failed VIP payment found — nothing to send.');
    return;
  }

  let sent = 0;
  let skipped = 0;
  for (const [userId, payment] of latestFailedByUser) {
    const user = await User.findById(userId);
    if (!user?.email) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would email ${user.email} (payment ${payment.displayId}, ${payment.provider})`);
      continue;
    }
    try {
      await mailer.sendPaymentFailedEmail(user, payment);
      console.log(`Sent to ${user.email} (payment ${payment.displayId})`);
      sent += 1;
    } catch (err) {
      console.error(`Failed to email ${user.email}:`, err.message);
      skipped += 1;
    }
  }

  console.log(dryRun ? `\n${latestFailedByUser.size} recipient(s) found.` : `\nDone: ${sent} sent, ${skipped} skipped.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
