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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Charts accept either `?days=N` (7/30/90/180/365, the quick filter chips)
// or an explicit `?from=YYYY-MM-DD&to=YYYY-MM-DD` (the custom range
// picker) — `from`/`to` win when both are present and valid. Capped at 2
// years either way so a malformed/huge range can't force building an
// absurdly long zero-filled array.
const MAX_RANGE_DAYS = 730;
function resolveDateRange(req, defaultDays = 30) {
  const { from, to } = req.query;
  if (from && to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to) && from <= to) {
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    const spanDays = Math.round((toDate - fromDate) / 86_400_000) + 1;
    if (spanDays > 0 && spanDays <= MAX_RANGE_DAYS) {
      return { fromIso: from, toIso: to, days: spanDays };
    }
  }
  const days = Math.min(Math.max(Number(req.query.days) || defaultDays, 1), MAX_RANGE_DAYS);
  const toIso = todayIso();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (days - 1));
  return { fromIso: fromDate.toISOString().slice(0, 10), toIso, days };
}

// Every calendar date from fromIso to toIso inclusive — the backbone every
// zero-filled daily chart array is built against.
function dateRangeArray(fromIso, toIso) {
  const dates = [];
  const cur = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
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
  // Staff (moderator/admin) are never counted as "users"/"clients" in
  // any business metric on this dashboard — they always have full access
  // via their role (see User.computeIsVip), not because they're a client,
  // so including them would inflate totalUsers/newUsers with accounts
  // that were never a real subscriber.
  const clientUsers = users.filter((u) => u.role !== 'moderator' && u.role !== 'admin');
  const now = Date.now();
  let activeVip = 0;
  let expiredVip = 0;
  for (const u of clientUsers) {
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
  const revenueByProvider = {
    moncash: { count: 0, htg: 0 },
    bazik: { count: 0, htg: 0 },
    nowpayments: { count: 0, usd: 0 },
  };
  let revenueUsd = 0;
  let revenueHtg = 0;
  for (const p of successPayments) {
    if (p.provider === 'moncash' || p.provider === 'bazik') {
      revenueByProvider[p.provider].count += 1;
      revenueByProvider[p.provider].htg += p.amountHtg || 0;
      revenueHtg += p.amountHtg || 0;
    } else if (p.provider === 'nowpayments') {
      revenueByProvider.nowpayments.count += 1;
      revenueByProvider.nowpayments.usd += p.amountUsd || 0;
      revenueUsd += p.amountUsd || 0;
    }
  }

  // --- Today ----------------------------------------------------------
  const newUsersToday = clientUsers.filter((u) => isToday(u.createdAt)).length;
  let newSubscriptionsToday = 0;
  let revenueTodayUsd = 0;
  let revenueTodayHtg = 0;
  for (const u of clientUsers) {
    for (const plan of u.planHistory || []) {
      if (!isToday(plan.startedAt)) continue;
      newSubscriptionsToday += 1;
      if (plan.amountUsd) revenueTodayUsd += plan.amountUsd;
      if (plan.amountHtg) revenueTodayHtg += plan.amountHtg;
    }
  }
  const predictionsPublishedToday = predictions.filter((p) => isToday(p.created_at)).length;
  const predictionsCompletedToday = predictions.filter((p) => isToday(p.settled_at)).length;

  // --- Charts (period-filterable: ?days=N or ?from=&to=) ----------------
  const { fromIso, toIso } = resolveDateRange(req, 30);

  const revenueByDate = new Map();
  const subsByDate = new Map();
  for (const u of clientUsers) {
    for (const plan of u.planHistory || []) {
      const date = String(plan.startedAt).slice(0, 10);
      if (date < fromIso || date > toIso) continue;
      if (!revenueByDate.has(date)) revenueByDate.set(date, { date, usd: 0, htg: 0 });
      if (plan.amountUsd) revenueByDate.get(date).usd += plan.amountUsd;
      if (plan.amountHtg) revenueByDate.get(date).htg += plan.amountHtg;
      subsByDate.set(date, (subsByDate.get(date) || 0) + 1);
    }
  }
  // Zero-filled for every day in the window, not just days that had
  // activity — a chart with one lonely bar floating with no timeline
  // around it reads as broken/sparse; a full range of mostly-zero bars
  // with an occasional spike reads as an actual trend line.
  const allDates = dateRangeArray(fromIso, toIso);
  const revenueDaily = allDates.map((date) => revenueByDate.get(date) || { date, usd: 0, htg: 0 });
  const subscriptionsDaily = allDates.map((date) => ({ date, count: subsByDate.get(date) || 0 }));

  res.json({
    overview: {
      totalUsers: clientUsers.length,
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
