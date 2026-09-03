const crypto = require('crypto');
const { appendMemberNotification, readMemberNotifications } = require('../db');

// A member-facing notification feed (e.g. "new VIP pick published") — the
// bell in the topbar for a regular/VIP account. Content is the same for
// every recipient of a given broadcast (there's nothing per-user to
// personalize yet), so entries are stored once and filtered by `audience`
// at read time instead of fanning out a row per recipient.
async function create({ title, body, url, audience = 'all' }) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    title,
    body: body ?? null,
    url: url ?? null,
    audience, // 'all' | 'vip'
  };
  await appendMemberNotification(entry);
  return entry;
}

// `viewer` is the authenticated req.user (or null) — already carries a
// computed `isVip` (see User.toPublic, true for staff too). An entry
// tagged 'vip' only shows for staff/VIP, same visibility rule as a locked
// pick (see models/Prediction.isLocked), so a non-VIP account doesn't see
// a notification teasing content it can't actually open.
async function list({ limit = 30, viewer } = {}) {
  const all = await readMemberNotifications({ limit });
  return all.filter((n) => n.audience !== 'vip' || viewer?.isVip);
}

module.exports = { create, list };
