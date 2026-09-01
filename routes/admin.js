const express = require('express');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, authorize('admin'));

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isToday(iso) {
  return typeof iso === 'string' && iso.slice(0, 10) === todayIso();
}

// Everything here is computed in memory from the existing stores
// (User.findAll / Prediction.listPredictions / Payment.listAll) — same
// approach as GET /predictions/stats, appropriate at this app's scale.
router.get('/dashboard', async (req, res) => {
  const [users, predictions, payments] = await Promise.all([
    User.findAll(),
    Prediction.listPredictions({}),
    Payment.listAll(),
  ]);

  // --- Overview -----------------------------------------------------
  const now = Date.now();
  let activeVip = 0;
  let expiredVip = 0;
  for (const u of users) {
    // Staff (moderator/admin) always have full access via their role
    // (see User.computeIsVip) regardless of any plan record — a
    // pre-promotion payment left over on their account must never
    // count as a "client actif" in business metrics.
    if (u.role === 'moderator' || u.role === 'admin') continue;
    if (!u.plan?.expiresAt) continue;
    if (new Date(u.plan.expiresAt).getTime() > now) activeVip += 1;
    else expiredVip += 1;
  }

  const pending = predictions.filter((p) => !p.result).length;
  const won = predictions.filter((p) => p.result === 'won').length;
  const lost = predictions.filter((p) => p.result === 'lost').length;
  const completed = won + lost;
  const winRate = completed ? Math.round((won / completed) * 100) : 0;

  const successPayments = payments.filter((p) => p.status === 'success');
  const revenueByProvider = { moncash: { count: 0, htg: 0 }, nowpayments: { count: 0, usd: 0 } };
  let revenueUsd = 0;
  let revenueHtg = 0;
  for (const p of successPayments) {
    if (p.provider === 'moncash') {
      revenueByProvider.moncash.count += 1;
      revenueByProvider.moncash.htg += p.amountHtg || 0;
      revenueHtg += p.amountHtg || 0;
    } else if (p.provider === 'nowpayments') {
      revenueByProvider.nowpayments.count += 1;
      revenueByProvider.nowpayments.usd += p.amountUsd || 0;
      revenueUsd += p.amountUsd || 0;
    }
  }

  // --- Today ----------------------------------------------------------
  const newUsersToday = users.filter((u) => isToday(u.createdAt)).length;
  let newSubscriptionsToday = 0;
  let revenueTodayUsd = 0;
  let revenueTodayHtg = 0;
  for (const u of users) {
    for (const plan of u.planHistory || []) {
      if (!isToday(plan.startedAt)) continue;
      newSubscriptionsToday += 1;
      if (plan.amountUsd) revenueTodayUsd += plan.amountUsd;
      if (plan.amountHtg) revenueTodayHtg += plan.amountHtg;
    }
  }
  const predictionsPublishedToday = predictions.filter((p) => isToday(p.created_at)).length;
  const predictionsCompletedToday = predictions.filter((p) => isToday(p.settled_at)).length;

  // --- 30-day charts ----------------------------------------------------
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const revenueByDate = new Map();
  const subsByDate = new Map();
  for (const u of users) {
    for (const plan of u.planHistory || []) {
      const date = String(plan.startedAt).slice(0, 10);
      if (date < cutoffIso) continue;
      if (!revenueByDate.has(date)) revenueByDate.set(date, { date, usd: 0, htg: 0 });
      if (plan.amountUsd) revenueByDate.get(date).usd += plan.amountUsd;
      if (plan.amountHtg) revenueByDate.get(date).htg += plan.amountHtg;
      subsByDate.set(date, (subsByDate.get(date) || 0) + 1);
    }
  }
  const revenueDaily = Array.from(revenueByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const subscriptionsDaily = Array.from(subsByDate.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    overview: {
      totalUsers: users.length,
      activeVip,
      expiredVip,
      totalPredictions: predictions.length,
      pending,
      won,
      lost,
      winRate,
      revenue: { usd: revenueUsd, htg: revenueHtg, byProvider: revenueByProvider },
    },
    today: {
      newUsers: newUsersToday,
      newSubscriptions: newSubscriptionsToday,
      revenue: { usd: revenueTodayUsd, htg: revenueTodayHtg },
      predictionsPublished: predictionsPublishedToday,
      predictionsCompleted: predictionsCompletedToday,
    },
    charts: { revenueDaily, subscriptionsDaily },
  });
});

router.get('/audit-logs', async (req, res) => {
  const logs = await AuditLog.list({ limit: 500 });
  res.json({ logs });
});

module.exports = router;
