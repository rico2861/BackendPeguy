const { readSetting, writeSetting } = require('../db');

// Single source of truth for what the VIP plan costs — mirrors the
// pricing shown on the frontend's VIP page. Trial has no payment flow
// (it's the free self-service activation).
//
// Prices are admin-editable at runtime (see PUT /payments/plans/:type)
// and persisted in the `settings` table, so a change takes effect on the
// very next price lookup — no redeploy. DEFAULT_PLANS is only the seed
// used the first time the app runs (or if a plan type is missing from
// what an admin has saved so far).
const HTG_PER_USD = 105; // used for display/conversion elsewhere in the app, not for this plan's fixed HTG price

const DEFAULT_PLANS = {
  vip: { usd: 20, htg: 1100, days: 30 },
};

const SETTINGS_KEY = 'plans';

async function getPlans() {
  const saved = await readSetting(SETTINGS_KEY);
  // Merge over the defaults rather than replace, so a plan type added in
  // a later release still has a sane price even if it predates whatever
  // an admin has saved.
  return { ...DEFAULT_PLANS, ...(saved || {}) };
}

async function priceForPlan(type) {
  const plans = await getPlans();
  return plans[type] || null;
}

// `usd`/`htg`/`days` — only the fields provided are changed; omitted ones
// keep their current value. Takes effect immediately: the next call to
// priceForPlan()/getPlans() (including one already in flight on another
// request) reads the freshly written row.
async function setPlanPrice(type, { usd, htg, days } = {}) {
  const plans = await getPlans();
  const current = plans[type] || { usd: 0, htg: 0, days: 30 };
  const updated = {
    usd: usd !== undefined ? Number(usd) : current.usd,
    htg: htg !== undefined ? Number(htg) : current.htg,
    days: days !== undefined ? Number(days) : current.days,
  };
  const next = { ...plans, [type]: updated };
  await writeSetting(SETTINGS_KEY, next);
  return next;
}

module.exports = { HTG_PER_USD, DEFAULT_PLANS, getPlans, priceForPlan, setPlanPrice };
