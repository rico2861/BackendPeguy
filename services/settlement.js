// Pure grading logic: given a final score and a market/pick, decide
// whether that pick won, lost, or can't be graded automatically (an
// unrecognized market — we never guess, an ungraded pick just stays
// "pending" forever rather than risk being wrong).
function normalizeMarket(market) {
  return String(market || '').trim().toLowerCase();
}

function normalizePick(pick) {
  return String(pick || '').trim().toLowerCase();
}

const MARKET_1X2 = new Set([
  '1x2', 'résultat final', 'resultat final', 'match winner', 'full time result', 'vainqueur du match', 'winner',
]);
const MARKET_DOUBLE_CHANCE = new Set(['double chance']);
const MARKET_GOALS = new Set([
  'nombre de buts', 'number of goals', 'total buts', 'total goals', 'over/under', 'over under', 'over/under buts',
]);
const MARKET_BTTS = new Set(['btts', 'les deux équipes marquent', 'les deux equipes marquent', 'both teams to score']);
const MARKET_DRAW_NO_BET = new Set(['draw no bet', 'sans le nul', 'dnb']);

// Picks come from many different moderators typing free text, so accept
// the common French/English spellings for each outcome, not just 1/X/2.
const PICK_HOME = new Set(['1', 'domicile', 'home', 'home win']);
const PICK_DRAW = new Set(['x', 'nul', 'draw', 'match nul']);
const PICK_AWAY = new Set(['2', 'exterieur', 'extérieur', 'away', 'away win']);

function outcomeKey(pick) {
  const p = normalizePick(pick);
  if (PICK_HOME.has(p)) return '1';
  if (PICK_DRAW.has(p)) return 'x';
  if (PICK_AWAY.has(p)) return '2';
  return null;
}

function gradeOneXTwo(pick, home, away) {
  const p = outcomeKey(pick);
  if (!p) return null;
  const outcome = home > away ? '1' : home < away ? '2' : 'x';
  return p === outcome ? 'won' : 'lost';
}

function gradeDrawNoBet(pick, home, away) {
  const p = outcomeKey(pick);
  if (!p || p === 'x') return null; // draw voids the bet — we don't auto-refund, leave it pending for manual review
  const outcome = home > away ? '1' : home < away ? '2' : 'x';
  if (outcome === 'x') return null;
  return p === outcome ? 'won' : 'lost';
}

function gradeDoubleChance(pick, home, away) {
  const p = normalizePick(pick).replace(/\s+/g, '');
  const outcome = home > away ? '1' : home < away ? '2' : 'x';
  const covers = { '1x': ['1', 'x'], x2: ['x', '2'], '12': ['1', '2'] };
  const set = covers[p];
  if (!set) return null;
  return set.includes(outcome) ? 'won' : 'lost';
}

function gradeGoals(pick, home, away) {
  const total = home + away;
  const raw = String(pick || '').trim();

  // "+2.5" / "-2.5"
  const symbolMatch = raw.match(/^([+-])\s*(\d+(?:\.\d+)?)$/);
  if (symbolMatch) {
    const [, sign, thresholdStr] = symbolMatch;
    const threshold = Number(thresholdStr);
    return sign === '+' ? (total > threshold ? 'won' : 'lost') : total < threshold ? 'won' : 'lost';
  }

  // "Over 2.5" / "Plus de 2.5" / "Under 1.5" / "Moins de 1.5"
  const wordMatch = raw.toLowerCase().match(/^(over|under|plus de|moins de)\s*(\d+(?:\.\d+)?)$/);
  if (wordMatch) {
    const [, word, thresholdStr] = wordMatch;
    const threshold = Number(thresholdStr);
    const isOver = word === 'over' || word === 'plus de';
    return isOver ? (total > threshold ? 'won' : 'lost') : total < threshold ? 'won' : 'lost';
  }

  return null;
}

function gradeBtts(pick, home, away) {
  const p = normalizePick(pick);
  const bothScored = home > 0 && away > 0;
  if (['oui', 'yes'].includes(p)) return bothScored ? 'won' : 'lost';
  if (['non', 'no'].includes(p)) return bothScored ? 'lost' : 'won';
  return null;
}

// Returns 'won' | 'lost' | null (null = market/pick combo we don't know
// how to grade — leave it pending rather than settle it incorrectly).
function evaluatePick({ market, pick, score_home, score_away }) {
  if (score_home === null || score_home === undefined || score_away === null || score_away === undefined) {
    return null;
  }
  const home = Number(score_home);
  const away = Number(score_away);
  if (Number.isNaN(home) || Number.isNaN(away)) return null;

  const m = normalizeMarket(market);
  if (MARKET_1X2.has(m)) return gradeOneXTwo(pick, home, away);
  if (MARKET_DOUBLE_CHANCE.has(m)) return gradeDoubleChance(pick, home, away);
  if (MARKET_GOALS.has(m)) return gradeGoals(pick, home, away);
  if (MARKET_BTTS.has(m)) return gradeBtts(pick, home, away);
  if (MARKET_DRAW_NO_BET.has(m)) return gradeDrawNoBet(pick, home, away);
  return null;
}

module.exports = { evaluatePick };
