// VIP expiry reminders (7/3/1/0 days before). No cron library needed —
// access itself is already derived live from plan.expiresAt
// (User.computeIsVip), so this job only sends heads-up notifications, it
// never has to "expire" anything itself.
const User = require('../models/User');
const mailer = require('./mailer');
const webPush = require('./webPush');

const THRESHOLDS = [7, 3, 1, 0];

function daysUntil(dateIso) {
  return Math.ceil((new Date(dateIso).getTime() - Date.now()) / 86_400_000);
}

async function checkAndSendReminders() {
  let sent = 0;
  const users = await User.findAll();
  for (const user of users) {
    const plan = user.plan;
    if (!plan?.expiresAt) continue;
    const daysLeft = daysUntil(plan.expiresAt);
    if (daysLeft < 0 || daysLeft > 7) continue; // already expired, or too far out

    const threshold = THRESHOLDS.find((t) => t === daysLeft);
    if (threshold === undefined) continue;
    if ((plan.remindersSent || []).includes(threshold)) continue;

    await mailer
      .sendVipExpiringEmail(user, threshold)
      .catch((err) => console.error('[mailer] VIP expiry reminder failed:', err.message));
    await webPush
      .sendToUser(user.id, {
        title: threshold === 0 ? 'Ton Premium expire aujourd\'hui' : `Ton Premium expire dans ${threshold} jours`,
        body: 'Renouvelle pour garder les cotes en direct et les pronostics VIP.',
        url: '/premium',
      })
      .catch(() => {});
    await User.markReminderSent(user.id, plan.startedAt, threshold);
    sent += 1;
  }
  return { sent };
}

module.exports = { checkAndSendReminders };
