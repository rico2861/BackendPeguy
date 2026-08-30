const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readUsers, writeUsers } = require('../db');

// Roles, in order of privilege. 'moderator' is the "pronostiqueur":
// almost every admin right, minus the ones explicitly blocked in the
// route permission checks (user management, role changes, account deletion).
const ROLES = ['user', 'moderator', 'admin'];

const PLAN_DURATIONS_DAYS = { trial: 7, vip: 30 };

// isVip is never stored — it's derived from plan.expiresAt every time a
// user object is read, so an expired plan loses VIP access immediately
// and automatically, with no cron job or stale flag to forget about.
// Staff (moderator/admin) always have full access regardless of plan.
function computeIsVip(user) {
  if (user.role === 'moderator' || user.role === 'admin') return true;
  if (!user.plan?.expiresAt) return false;
  return new Date(user.plan.expiresAt).getTime() > Date.now();
}

function toPublic(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return { ...rest, isVip: computeIsVip(user) };
}

function findAll() {
  return readUsers().map(toPublic);
}

function findById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

function findByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return readUsers().find((u) => u.email === normalized) || null;
}

function create({ name, email, phone, password, role = 'user' }) {
  const users = readUsers();
  const normalizedEmail = String(email).trim().toLowerCase();
  if (users.some((u) => u.email === normalizedEmail)) {
    const err = new Error('Un compte existe déjà avec cet email.');
    err.status = 409;
    throw err;
  }
  if (!ROLES.includes(role)) role = 'user';

  const user = {
    id: crypto.randomUUID(),
    name,
    email: normalizedEmail,
    phone: phone ? String(phone).trim() : null,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    plan: null, // { type: 'trial'|'vip', startedAt, expiresAt } | null
    favorites: [],
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return toPublic(user);
}

function verifyPassword(user, password) {
  if (!user) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

function updateRole(id, role) {
  if (!ROLES.includes(role)) {
    const err = new Error('Rôle invalide.');
    err.status = 400;
    throw err;
  }
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].role = role;
  writeUsers(users);
  return toPublic(users[idx]);
}

// Sets (or extends from now) a VIP plan by type. `days` overrides the
// default duration for that type — used by the admin panel's custom
// extension. Passing no plan / clearPlan revokes access immediately.
function setPlan(id, { type = 'trial', days } = {}) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const duration = Number.isFinite(days) ? days : PLAN_DURATIONS_DAYS[type] || 30;
  const now = new Date();
  users[idx].plan = {
    type,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + duration * 86_400_000).toISOString(),
  };
  writeUsers(users);
  return toPublic(users[idx]);
}

function clearPlan(id) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].plan = null;
  writeUsers(users);
  return toPublic(users[idx]);
}

function remove(id) {
  const users = readUsers();
  const next = users.filter((u) => u.id !== id);
  const changed = next.length !== users.length;
  if (changed) writeUsers(next);
  return changed;
}

function toggleFavorite(id, predictionId) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const favs = new Set(users[idx].favorites || []);
  if (favs.has(predictionId)) favs.delete(predictionId);
  else favs.add(predictionId);
  users[idx].favorites = Array.from(favs);
  writeUsers(users);
  return toPublic(users[idx]);
}

module.exports = {
  ROLES,
  PLAN_DURATIONS_DAYS,
  toPublic,
  computeIsVip,
  findAll,
  findById,
  findByEmail,
  create,
  verifyPassword,
  updateRole,
  setPlan,
  clearPlan,
  remove,
  toggleFavorite,
};
