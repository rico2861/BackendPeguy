const crypto = require('crypto');
const { appendAuditLog, readAuditLogs } = require('../db');

// Fire-and-forget by design: every call site wraps this in .catch(() => {})
// (see middleware/audit.js) — a logging failure must never fail the
// action it's describing.
async function log({ actorId, actorName, actorRole, action, target, previousValue, newValue, ip, userAgent }) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorId: actorId ?? null,
    actorName: actorName ?? null,
    actorRole: actorRole ?? null,
    action,
    target: target ?? null,
    previousValue: previousValue ?? null,
    newValue: newValue ?? null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
  };
  await appendAuditLog(entry);
  return entry;
}

async function list({ limit = 200 } = {}) {
  return readAuditLogs({ limit });
}

module.exports = { log, list };
