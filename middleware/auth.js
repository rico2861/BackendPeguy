const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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

module.exports = { authenticate, authenticateOptional, authorize };
