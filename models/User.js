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

// Login accepts email, username, or phone — whichever the user typed.
// Checked in that order since email is still the most common case.
async function findByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const users = await readUsers();
  return (
    users.find((u) => u.email === normalized) ||
    users.find((u) => u.username && u.username.toLowerCase() === normalized) ||
    users.find((u) => u.phone && u.phone.replace(/\s+/g, '') === raw.replace(/\s+/g, '')) ||
    null
  );
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
    plan: null, // { type: 'trial'|'vip', startedAt, expiresAt, amountUsd, amountHtg, provider, remindersSent } | null
    planHistory: [], // every plan ever activated, oldest first
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
// extension. `amountUsd`/`amountHtg`/`provider` are only present for a real
// paid activation (absent for the free trial or an admin grant) and are
// carried into planHistory as the permanent record of what was paid.
// Passing no plan / clearPlan revokes access immediately.
async function setPlan(id, { type = 'trial', days, amountUsd, amountHtg, provider } = {}) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const duration = Number.isFinite(days) ? days : PLAN_DURATIONS_DAYS[type] || 30;
  const now = new Date();
  const plan = {
    type,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + duration * 86_400_000).toISOString(),
    amountUsd: amountUsd ?? null,
    amountHtg: amountHtg ?? null,
    provider: provider ?? null,
    remindersSent: [],
  };
  users[idx].plan = plan;
  users[idx].planHistory = [...(users[idx].planHistory || []), plan];
  await writeUsers(users);
  return toPublic(users[idx]);
}

// Marks a reminder threshold (7/3/1/0 days before expiry) as sent for the
// user's CURRENT plan, so subscriptionReminders.js never sends the same
// one twice. No-op if the plan has since changed (stale threshold).
async function markReminderSent(id, planStartedAt, threshold) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1 || users[idx].plan?.startedAt !== planStartedAt) return;
  const sent = new Set(users[idx].plan.remindersSent || []);
  sent.add(threshold);
  users[idx].plan.remindersSent = Array.from(sent);
  await writeUsers(users);
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

// Same secret/expiry fields as setResetToken (findByResetToken hashes and
// compares regardless of shape), just a short numeric code instead of a
// long hex token, and a shorter 10-minute window — used by the logged-in
// Settings page ("reset via OTP") instead of the logged-out email-link flow.
async function setResetOtp(id) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  users[idx].resetTokenHash = hashToken(otp);
  users[idx].resetTokenExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString(); // 10 min
  await writeUsers(users);
  return otp;
}

async function updateProfile(id, { name, phone, username } = {}) {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  if (name !== undefined && name.trim()) users[idx].name = name.trim();
  if (phone !== undefined && phone.trim()) users[idx].phone = phone.trim();
  if (username !== undefined && username.trim()) {
    const normalized = username.trim().toLowerCase();
    const taken = users.some((u) => u.id !== id && u.username && u.username.toLowerCase() === normalized);
    if (taken) {
      const err = new Error('Ce nom d’utilisateur est déjà pris.');
      err.status = 409;
      throw err;
    }
    users[idx].username = username.trim();
  }
  await writeUsers(users);
  return toPublic(users[idx]);
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
  findByIdentifier,
  create,
  verifyPassword,
  updateRole,
  setPlan,
  markReminderSent,
  clearPlan,
  remove,
  toggleFavorite,
  setRefreshToken,
  clearRefreshToken,
  verifyRefreshToken,
  setResetToken,
  setResetOtp,
  findByResetToken,
  updateProfile,
  setPassword,
  addPushSubscription,
  removePushSubscription,
  listPushSubscribers,
};
