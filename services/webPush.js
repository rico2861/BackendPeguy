// Browser push notifications (daily picks / new combos) via the Web Push
// protocol. Subscriptions live on the user record (models/User.js);
// a subscription that the push service reports as gone (404/410 — the
// browser unsubscribed or the endpoint expired) is pruned automatically
// so broadcasts don't keep retrying dead endpoints forever.
const webPush = require('web-push');
const User = require('../models/User');

let configured = false;

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function ensureConfigured() {
  if (configured || !isConfigured()) return;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@peguytbn.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

async function broadcast({ title, body, url }) {
  if (!isConfigured()) {
    const err = new Error('Notifications push non configurées.');
    err.status = 503;
    throw err;
  }
  ensureConfigured();

  const subscribers = await User.listPushSubscribers();
  const payload = JSON.stringify({ title, body, url: url || '/' });
  let sent = 0;
  let pruned = 0;

  for (const { id: userId, subscriptions } of subscribers) {
    for (const sub of subscriptions) {
      try {
        await webPush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await User.removePushSubscription(userId, sub.endpoint);
          pruned += 1;
        }
      }
    }
  }
  return { sent, pruned };
}

module.exports = { isConfigured, broadcast };
