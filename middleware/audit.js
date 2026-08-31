const AuditLog = require('../models/AuditLog');

// Call after a mutation has already succeeded — never awaited by the
// caller for its result, always .catch()'d, so a logging hiccup can't
// turn a successful action into a failed request.
function recordAudit(req, { action, target, previousValue, newValue }) {
  return AuditLog.log({
    actorId: req.user?.id,
    actorName: req.user?.name,
    actorRole: req.user?.role,
    action,
    target,
    previousValue,
    newValue,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }).catch((err) => console.error('[audit] failed to record', action, err.message));
}

module.exports = { recordAudit };
