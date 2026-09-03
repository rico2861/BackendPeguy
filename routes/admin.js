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

// Every plan record carries BOTH amountUsd (the reference price shown in
// the UI) and amountHtg (what MonCash/Bazik actually charge), even though
// only one of the two was ever real money for a given purchase — MonCash
// never actually collects the USD figure, it's just the price tag. Summing
// amountUsd unconditionally (as the daily-chart/period loops below used
// to) made a MonCash-only client base show fake "USD revenue" nobody
// actually paid — the exact bug already fixed once for the payment
// confirmation e-mail and Subscription.jsx (see their own comments); this
// mirrors that same provider-aware rule for the admin dashboard's charts.
function isUsdProvider(provider) {
  return provider === 'nowpayments';
}
function isHtgProvider(provider) {
  return provider === 'moncash' || provider === 'bazik';
}

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
      if (plan.amountUsd && isUsdProvider(plan.provider)) revenueTodayUsd += plan.amountUsd;
      if (plan.amountHtg && isHtgProvider(plan.provider)) revenueTodayHtg += plan.amountHtg;
    }
  }
  const predictionsPublishedToday = predictions.filter((p) => isToday(p.created_at)).length;
  const predictionsCompletedToday = predictions.filter((p) => isToday(p.settled_at)).length;

  // Every payment attempt today (not just successful ones — a moderator
  // watching this list wants to see a failed/pending MonCash attempt too,
  // not just the ones that went through), newest first, with the payer's
  // name/email attached since a bare userId is useless in an admin view.
  const usersById = new Map(users.map((u) => [u.id, u]));
  const todayTransactions = payments
    .filter((p) => isToday(p.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => {
      const payer = usersById.get(p.userId);
      return {
        id: p.id,
        at: p.createdAt,
        status: p.status,
        provider: p.provider,
        planType: p.planType,
        amountUsd: p.amountUsd,
        amountHtg: p.amountHtg,
        userName: payer?.name || null,
        userEmail: payer?.email || null,
      };
    });

  // --- Charts (period-filterable: ?days=N or ?from=&to=) ----------------
  const { fromIso, toIso } = resolveDateRange(req, 30);

  const revenueByDate = new Map();
  const subsByDate = new Map();
  let periodRevenueUsd = 0;
  let periodRevenueHtg = 0;
  let periodNewSubscriptions = 0;
  for (const u of clientUsers) {
    for (const plan of u.planHistory || []) {
      const date = String(plan.startedAt).slice(0, 10);
      if (date < fromIso || date > toIso) continue;
      if (!revenueByDate.has(date)) revenueByDate.set(date, { date, usd: 0, htg: 0 });
      if (plan.amountUsd && isUsdProvider(plan.provider)) {
        revenueByDate.get(date).usd += plan.amountUsd;
        periodRevenueUsd += plan.amountUsd;
      }
      if (plan.amountHtg && isHtgProvider(plan.provider)) {
        revenueByDate.get(date).htg += plan.amountHtg;
        periodRevenueHtg += plan.amountHtg;
      }
      subsByDate.set(date, (subsByDate.get(date) || 0) + 1);
      periodNewSubscriptions += 1;
    }
  }

  // New-signups-per-day — same shape/purpose as revenueDaily/
  // subscriptionsDaily below, gives the dashboard an actual growth trend
  // instead of only ever showing "new today" as a single number.
  const usersByDate = new Map();
  let periodNewUsers = 0;
  for (const u of clientUsers) {
    const date = String(u.createdAt).slice(0, 10);
    if (date < fromIso || date > toIso) continue;
    usersByDate.set(date, (usersByDate.get(date) || 0) + 1);
    periodNewUsers += 1;
  }

  // Zero-filled for every day in the window, not just days that had
  // activity — a chart with one lonely bar floating with no timeline
  // around it reads as broken/sparse; a full range of mostly-zero bars
  // with an occasional spike reads as an actual trend line.
  const allDates = dateRangeArray(fromIso, toIso);
  const revenueDaily = allDates.map((date) => revenueByDate.get(date) || { date, usd: 0, htg: 0 });
  const subscriptionsDaily = allDates.map((date) => ({ date, count: subsByDate.get(date) || 0 }));
  const usersDaily = allDates.map((date) => ({ date, count: usersByDate.get(date) || 0 }));

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
    // Same window as the charts below (?days=N or ?from=&to=) — a
    // dedicated section so the period filter visibly changes something
    // above the fold too, not just the charts further down the page.
    periodOverview: {
      newUsers: periodNewUsers,
      newSubscriptions: periodNewSubscriptions,
      revenue: { usd: Math.round(periodRevenueUsd * 100) / 100, htg: periodRevenueHtg },
    },
    today: {
      newUsers: newUsersToday,
      newSubscriptions: newSubscriptionsToday,
      revenue: { usd: revenueTodayUsd, htg: revenueTodayHtg },
      predictionsPublished: predictionsPublishedToday,
      predictionsCompleted: predictionsCompletedToday,
      transactions: todayTransactions,
    },
    charts: { revenueDaily, subscriptionsDaily, usersDaily },
  });
});

router.get('/audit-logs', async (req, res) => {
  const logs = await AuditLog.list({ limit: 500 });
  res.json({ logs });
});

module.exports = router;
