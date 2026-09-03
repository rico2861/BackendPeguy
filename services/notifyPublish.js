// Shared fan-out for "a new pick is up": browser push (anyone subscribed)
// + e-mail (VIP members only) + an internal admin-notification entry.
// Used both by the moderator's manual "Notifier les abonnés" button
// (routes/push.js) and automatically whenever a VIP prediction/combo is
// published (routes/predictions.js, routes/combos.js) — a paying VIP
// used to only find out a new pick existed if a moderator remembered to
// click the button; publishing a VIP pick now always reaches them.
const webPush = require('./webPush');
const mailer = require('./mailer');
const User = require('../models/User');
const AdminNotification = require('../models/AdminNotification');

async function notifyPublish({ title, body, url, actorName }) {
  let pushResult = { sent: 0 };
  try {
    pushResult = await webPush.broadcast({ title, body, url });
  } catch {
    // Push failure shouldn't block the VIP e-mail fan-out below.
  }

  let vipEmailsSent = 0;
  if (mailer.isConfigured()) {
    const users = await User.findAll();
    const vipUsers = users.filter((u) => User.computeIsVip(u));
    const results = await Promise.allSettled(vipUsers.map((u) => mailer.sendNewPicksEmail(u, { message: body })));
    vipEmailsSent = results.filter((r) => r.status === 'fulfilled').length;
  }

  await AdminNotification.create({
    title: `${actorName} a notifié les abonnés`,
    body: `"${title}" — push: ${pushResult.sent ?? 0}, e-mails VIP: ${vipEmailsSent}.`,
    actorName,
  });

  return { ...pushResult, vipEmailsSent };
}

module.exports = { notifyPublish };
