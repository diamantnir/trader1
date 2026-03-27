/**
 * Execution / location context from recent 5m bars (range, distances, extremes).
 * Used by triggerEngine + decision payload.
 */

function buildExecutionState(min5Candles = []) {
  if (!Array.isArray(min5Candles) || !min5Candles.length) return null;

  const lastBar = min5Candles[min5Candles.length - 1];
  const lastClose = Number(lastBar?.close);
  if (!Number.isFinite(lastClose)) return null;

  const lookback = Math.min(min5Candles.length, 40);
  const slice = min5Candles.slice(-lookback);
  let rh = -Infinity;
  let rl = Infinity;
  for (const b of slice) {
    const h = Number(b.high);
    const l = Number(b.low);
    if (Number.isFinite(h)) rh = Math.max(rh, h);
    if (Number.isFinite(l)) rl = Math.min(rl, l);
  }
  if (!Number.isFinite(rh) || !Number.isFinite(rl) || rh <= rl) return null;

  const width = rh - rl;
  const dh = rh - lastClose;
  const dl = lastClose - rl;
  const nearPct = 0.14;
  let price_location = "mid_range";
  if (dh <= width * nearPct) price_location = "near_resistance";
  else if (dl <= width * nearPct) price_location = "near_support";

  const position = width > 0 ? (lastClose - rl) / width : 0.5;

  return {
    price: Number(lastClose.toFixed(4)),
    current_price: Number(lastClose.toFixed(4)),
    range_high: Number(rh.toFixed(4)),
    range_low: Number(rl.toFixed(4)),
    position: Number(position.toFixed(6)),
    price_location,
    in_range: lastClose >= rl && lastClose <= rh,
    distance_to_high: Number(dh.toFixed(4)),
    distance_to_low: Number(dl.toFixed(4)),
    is_at_extreme: dh <= width * 0.11 || dl <= width * 0.11,
    lookback_bars: lookback
  };
}

/**
 * Relate PD zone / setup type to where price sits in the 5m range.
 */
function buildSetupAlignment(executionState, lastBarFeature, setupPresence) {
  if (!executionState?.price_location) {
    return { location_match: null, reason: "no_execution_location" };
  }
  const loc = executionState.price_location;
  const pd = lastBarFeature?.pd_array?.zone || "unknown";
  const st = setupPresence?.type || lastBarFeature?.setup?.type || "none";

  if (!st || st === "none") {
    return { location_match: null, reason: "no_named_setup" };
  }

  const discountPd = pd === "discount" || pd === "extreme_discount";
  const premiumPd = pd === "premium" || pd === "extreme_premium";
  const discountSetup =
    /discount|bullish_fvg|range_fvg_discount|potential_reversal_discount|trend_bullish_fvg/i.test(String(st));
  const premiumSetup =
    /premium|bearish_fvg|range_fvg_premium|potential_reversal_premium|trend_bearish_fvg/i.test(String(st));

  const longContext = discountPd || discountSetup;
  const shortContext = premiumPd || premiumSetup;

  if (longContext && !shortContext) {
    const match = loc === "near_support";
    return {
      location_match: match,
      reason: match
        ? "discount_long_context_and_price_near_support"
        : `long_bias_setup_but_price_${loc}_not_ideal_for_discount_entry`
    };
  }

  if (shortContext && !longContext) {
    const match = loc === "near_resistance";
    return {
      location_match: match,
      reason: match
        ? "premium_short_context_and_price_near_resistance"
        : `short_bias_setup_but_price_${loc}_not_ideal_for_premium_entry`
    };
  }

  if (longContext && shortContext) {
    return { location_match: null, reason: "mixed_pd_context_use_structure" };
  }

  return { location_match: null, reason: "neutral_alignment" };
}

module.exports = { buildExecutionState, buildSetupAlignment };
