const crypto = require('crypto');
const { appendAdminNotification, readAdminNotifications } = require('../db');

// Internal feed for moderator/admin accounts only (e.g. "X vient de
// notifier les abonnés VIP par e-mail") — separate from the push
// subscription system, which is per-visitor and public-facing.
async function create({ title, body, actorName }) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    title,
    body: body ?? null,
    actorName: actorName ?? null,
  };
  await appendAdminNotification(entry);
  return entry;
}

async function list({ limit = 30 } = {}) {
  return readAdminNotifications({ limit });
}

module.exports = { create, list };
