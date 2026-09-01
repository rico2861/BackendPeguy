const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable.' });
    // Enforced here too, not just at login/refresh — a still-valid access
    // token (up to JWT_EXPIRES_IN) must lose access immediately once an
    // admin blocks the account, not just on its next refresh.
    if (user.blocked) return res.status(403).json({ error: 'Ce compte a été bloqué.' });
    req.user = User.toPublic(user);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
}

// Optional auth: attaches req.user if a valid token is present, but never
// blocks the request (used on public endpoints like GET /predictions).
async function authenticateOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(payload.sub);
    if (user) req.user = User.toPublic(user);
  } catch {
    // ignore invalid token on optional routes
  }
  next();
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé : droits insuffisants.' });
    }
    next();
  };
}

// Guards server-to-server endpoints called by DealPam (which acts as the
// shared MonCash return page for this app — see routes/payments.js POST
// /external/confirm). Same HMAC-SHA256-over-raw-body + timing-safe-compare
// pattern as the existing cross-platform/Bazik/NOWPayments webhooks — never
// a JWT, since DealPam's backend has no PeguyTBN user session.
function requireDealPamSignature(req, res, next) {
  const secret = process.env.DEALPAM_PAYMENT_CONFIRM_SECRET;
  const signature = req.headers['x-cross-signature'];
  if (!secret || !signature || req.rawBody == null) {
    return res.status(401).json({ error: 'Signature manquante ou service non configuré.' });
  }
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Signature invalide.' });
  }
  next();
}

module.exports = { authenticate, authenticateOptional, authorize, requireDealPamSignature };
