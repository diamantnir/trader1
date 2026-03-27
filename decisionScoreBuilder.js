/**
 * Normalized 0–100 score + letter grade for the LLM (internals blended, not raw sum).
 */

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function gradeFromTotal(t) {
  if (t >= 90) return "A";
  if (t >= 75) return "B";
  if (t >= 60) return "C";
  if (t >= 45) return "D";
  return "F";
}

function engagementFromTotal(t) {
  if (t >= 68) return "high";
  if (t >= 42) return "medium";
  return "low";
}

/**
 * @param {object} p
 * @param {object|null} p.lastBar5m
 * @param {object|null} p.setupPresence
 * @param {object|null} p.executionState
 * @param {object|null} p.signalConflicts
 * @param {object|null} p.mtfSummary
 */
function buildDecisionScore({
  lastBar5m,
  setupPresence,
  executionState,
  signalConflicts,
  mtfSummary
}) {
  let setup = 0;
  const type = setupPresence?.type || lastBar5m?.setup?.type || "none";
  const q = setupPresence?.quality || lastBar5m?.setup_analysis?.setup_quality || "none";
  const conf = Number(lastBar5m?.setup?.confidence);
  if (type && type !== "none") {
    setup += 12;
    if (Number.isFinite(conf)) setup += clamp(conf, 0, 1) * 22;
    if (q === "strong") setup += 8;
    else if (q === "moderate") setup += 4;
  }
  setup = Math.round(clamp(setup, 0, 40));

  let structure = 0;
  const st = lastBar5m?.structure_state;
  if (st && st !== "range") structure += 8;
  if (lastBar5m?.bos === "bullish" || lastBar5m?.bos === "bearish") structure += 10;
  if (lastBar5m?.bos_bullish || lastBar5m?.bos_bearish) structure += 6;
  if (lastBar5m?.choch) structure += 4;
  if (lastBar5m?.fvg?.is_valid) structure += 5;
  structure = Math.round(clamp(structure, 0, 30));

  let location = 0;
  const match = executionState?.setup_alignment?.location_match;
  if (match === true) location = 20;
  else if (match === false) location = 6;
  else if (match === null) location = 10;
  else location = 12;
  location = Math.round(clamp(location, 0, 20));

  let conflicts = 0;
  if (signalConflicts?.block_trading_suggestion) conflicts -= 28;
  if (lastBar5m?.conflict_alert?.present) conflicts -= 18;
  if (mtfSummary?.conflict) conflicts -= 22;
  if (lastBar5m?.confluence?.conflicts?.length) {
    conflicts -= Math.min(15, (lastBar5m.confluence.conflicts.length || 0) * 6);
  }
  conflicts = Math.round(clamp(conflicts, -50, 0));

  const positive = setup + structure + location;
  const positiveNorm = (positive / 90) * 100;
  const conflictNorm = ((50 + conflicts) / 50) * 100;
  const total = Math.round(clamp(0.65 * positiveNorm + 0.35 * conflictNorm, 0, 100));

  return {
    total,
    max: 100,
    grade: gradeFromTotal(total),
    engagement: engagementFromTotal(total)
  };
}

module.exports = { buildDecisionScore };
