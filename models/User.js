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
  const { passwordHash, refreshTokenHash, resetTokenHash, resetTokenExpiresAt, pushSubscriptions, ...rest } = user;
  return { ...rest, isVip: computeIsVip(user), pushEnabled: (pushSubscriptions || []).length > 0 };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function findAll() {
  const users = await readUsers();
  return users.map(toPublic);
}

async function findById(id) {
  const users = await readUsers();
  return users.find((u) => u.id === id) || null;
}

async function findByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const users = await readUsers();
  return users.find((u) => u.email === normalized) || null;
}

async function create({ name, email, phone, password, role = 'user' }) {
  const users = await readUsers();
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
    refreshTokenHash: null,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    pushSubscriptions: [],
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await writeUsers(users);
  return toPublic(user);
}

function verifyPassword(user, password) {
  if (!user) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

async function updateRole(id, role) {
  if (!ROLES.includes(role)) {
    const err = new Error('Rôle invalide.');
    err.status = 400;
    throw err;
  }
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].role = role;
  await writeUsers(users);
  return toPublic(users[idx]);
}

// Sets (or extends from now) a VIP plan by type. `days` overrides the
// default duration for that type — used by the admin panel's custom
// extension. Passing no plan / clearPlan revokes access immediately.
async function setPlan(id, { type = 'trial', days } = {}) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const duration = Number.isFinite(days) ? days : PLAN_DURATIONS_DAYS[type] || 30;
  const now = new Date();
  users[idx].plan = {
    type,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + duration * 86_400_000).toISOString(),
  };
  await writeUsers(users);
  return toPublic(users[idx]);
}

async function clearPlan(id) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].plan = null;
  await writeUsers(users);
  return toPublic(users[idx]);
}

async function remove(id) {
  const users = await readUsers();
  const next = users.filter((u) => u.id !== id);
  const changed = next.length !== users.length;
  if (changed) await writeUsers(next);
  return changed;
}

async function toggleFavorite(id, predictionId) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const favs = new Set(users[idx].favorites || []);
  if (favs.has(predictionId)) favs.delete(predictionId);
  else favs.add(predictionId);
  users[idx].favorites = Array.from(favs);
  await writeUsers(users);
  return toPublic(users[idx]);
}

// --- Refresh tokens ---------------------------------------------------
// Only the hash is stored, and only one at a time: issuing a new refresh
// token (login, or a successful /refresh) invalidates whichever one came
// before it. A /refresh call presenting a token that doesn't match the
// stored hash — most likely a stolen, already-rotated-away token — clears
// the stored hash entirely, forcing a fresh login on every device.
async function setRefreshToken(id, token) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].refreshTokenHash = hashToken(token);
  await writeUsers(users);
  return toPublic(users[idx]);
}

async function clearRefreshToken(id) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  users[idx].refreshTokenHash = null;
  await writeUsers(users);
  return true;
}

function verifyRefreshToken(user, token) {
  if (!user?.refreshTokenHash) return false;
  return user.refreshTokenHash === hashToken(token);
}

// --- Password reset -----------------------------------------------------
async function setResetToken(id) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const token = crypto.randomBytes(32).toString('hex');
  users[idx].resetTokenHash = hashToken(token);
  users[idx].resetTokenExpiresAt = new Date(Date.now() + 3_600_000).toISOString(); // 1h
  await writeUsers(users);
  return token; // plain token — only ever returned here, to be emailed
}

async function findByResetToken(token) {
  const users = await readUsers();
  const hash = hashToken(token);
  return (
    users.find(
      (u) => u.resetTokenHash === hash && u.resetTokenExpiresAt && new Date(u.resetTokenExpiresAt).getTime() > Date.now()
    ) || null
  );
}

// Also clears the refresh token — a password reset should force re-login
// everywhere, not just on the device that reset it.
async function setPassword(id, password) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].passwordHash = bcrypt.hashSync(password, 10);
  users[idx].resetTokenHash = null;
  users[idx].resetTokenExpiresAt = null;
  users[idx].refreshTokenHash = null;
  await writeUsers(users);
  return toPublic(users[idx]);
}

// --- Web push subscriptions ----------------------------------------------
async function addPushSubscription(id, subscription) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const subs = (users[idx].pushSubscriptions || []).filter((s) => s.endpoint !== subscription.endpoint);
  subs.push(subscription);
  users[idx].pushSubscriptions = subs;
  await writeUsers(users);
  return toPublic(users[idx]);
}

async function removePushSubscription(id, endpoint) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx].pushSubscriptions = (users[idx].pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  await writeUsers(users);
  return toPublic(users[idx]);
}

// Raw subscriptions per user — toPublic() strips pushSubscriptions from
// every other read path, so the broadcast job goes straight to the store.
async function listPushSubscribers() {
  const users = await readUsers();
  return users
    .filter((u) => (u.pushSubscriptions || []).length > 0)
    .map((u) => ({ id: u.id, subscriptions: u.pushSubscriptions }));
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
  setRefreshToken,
  clearRefreshToken,
  verifyRefreshToken,
  setResetToken,
  findByResetToken,
  setPassword,
  addPushSubscription,
  removePushSubscription,
  listPushSubscribers,
};
