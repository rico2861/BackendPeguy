// The "smart" part of the platform: link each manually-created
// prediction to a real match (when one exists in the free football-data
// feed) and keep it in sync automatically — live score while it's being
// played, then final score + auto-graded won/lost the moment it ends.
// Predictions with no real-world match (demo/custom fixtures) are left
// alone; they still get graded manually via Prediction.updatePrediction
// once a moderator enters a final score, using the same settlement
// engine (see services/settlement.js).
const footballData = require('./footballData');
const Prediction = require('../models/Prediction');
const { teamsLooselyMatch } = require('../utils/normalizeTeam');

let lastRun = { at: 0, updated: 0, error: null };
const SYNC_MIN_INTERVAL_MS = 30_000; // don't hammer football-data if called from multiple routes at once

function findRealMatch(realMatches, pred) {
  return realMatches.find(
    (m) =>
      m.match_date === pred.match_date &&
      teamsLooselyMatch(m.home_team, pred.home_team) &&
      teamsLooselyMatch(m.away_team, pred.away_team)
  );
}

async function syncPredictionsWithLiveResults({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRun.at < SYNC_MIN_INTERVAL_MS) return lastRun;
  if (!footballData.isConfigured()) {
    lastRun = { at: now, updated: 0, error: null, skipped: 'not_configured' };
    return lastRun;
  }

  let updated = 0;
  try {
    const realMatches = await footballData.fetchRecentMatches(2);
    const pending = (await Prediction.listPredictions({})).filter((p) => !p.result);

    for (const pred of pending) {
      const real = findRealMatch(realMatches, pred);
      if (!real) continue;

      // Only push facts the sync actually knows, and only "forward" —
      // e.g. never revert a status from FT back to live because of a
      // stale cache read.
      const facts = {
        status: real.status,
        score_home: real.score_home,
        score_away: real.score_away,
        half_time_home: real.half_time_home,
        half_time_away: real.half_time_away,
        matchday: real.matchday,
        stage: real.stage,
        referee: real.referee,
        external_source: real.source,
      };
      if (pred.status === 'FT' && real.status !== 'FT') continue;

      const before = pred;
      const after = await Prediction.applyLiveFacts(pred.id, facts);
      if (after && (after.result !== before.result || after.score_home !== before.score_home || after.status !== before.status)) {
        updated += 1;
      }
    }

    // Catch anything with a manually-entered FT score that was never graded.
    updated += await Prediction.settleAll();

    lastRun = { at: now, updated, error: null };
  } catch (err) {
    lastRun = { at: now, updated: 0, error: err.message };
  }
  return lastRun;
}

function getLastSyncStatus() {
  return lastRun;
}

module.exports = { syncPredictionsWithLiveResults, getLastSyncStatus };
