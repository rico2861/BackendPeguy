// Single source of truth for what the VIP plan costs — mirrors the
// pricing shown on the frontend's VIP page. Trial has no payment flow
// (it's the free self-service activation).
//
// There's one paid plan, priced per-channel by the operator (not a pure
// currency conversion): 1000 HTG via MonCash, $20 via crypto/card
// (NOWPayments). Both grant the same 30-day access.
const HTG_PER_USD = 133; // used for display/conversion elsewhere in the app, not for this plan's fixed HTG price

const PLANS = {
  vip: { usd: 20, htg: 1000, days: 30 },
};

function priceForPlan(type) {
  return PLANS[type] || null;
}

module.exports = { HTG_PER_USD, PLANS, priceForPlan };
