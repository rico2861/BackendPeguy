// Shared fan-out for "a new pick is up": browser push (anyone subscribed)
// + e-mail (VIP members only) + a member-facing notification (the topbar
// bell) + an internal admin-notification entry. Used both by the
// moderator's manual "Notifier les abonnés" button (routes/push.js) and
// automatically whenever a VIP prediction/combo is published
// (routes/predictions.js, routes/combos.js) — a paying VIP used to only
// find out a new pick existed if a moderator remembered to click the
// button; publishing a VIP pick now always reaches them.
const webPush = require('./webPush');
const mailer = require('./mailer');
const User = require('../models/User');
const AdminNotification = require('../models/AdminNotification');
const MemberNotification = require('../models/MemberNotification');

// `emailMessage` may be a plain string (used verbatim for every
// recipient — the manual "Notifier les abonnés" button, where a
// moderator typed free text that can't be auto-translated) or an
// `{ fr, en }` pair (the automatic VIP-publish trigger), in which case
// each VIP gets the copy matching their own `user.lang`.
async function notifyPublish({ title, body, url, actorName, emailMessage }) {
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
    const results = await Promise.allSettled(
      vipUsers.map((u) => {
        const message =
          emailMessage && typeof emailMessage === 'object' ? (u.lang === 'en' ? emailMessage.en : emailMessage.fr) : emailMessage ?? body;
        return mailer.sendNewPicksEmail(u, { message });
      })
    );
    vipEmailsSent = results.filter((r) => r.status === 'fulfilled').length;
  }

  await AdminNotification.create({
    title: `${actorName} a notifié les abonnés`,
    body: `"${title}" — push: ${pushResult.sent ?? 0}, e-mails VIP: ${vipEmailsSent}.`,
    actorName,
  });
  // Same content as the push notification — everyone sees it in the
  // topbar bell too, not just whoever happened to have push enabled (or
  // dismissed the OS notification before reading it).
  await MemberNotification.create({ title, body, url, audience: 'all' });

  return { ...pushResult, vipEmailsSent };
}

module.exports = { notifyPublish };
