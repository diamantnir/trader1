/**
 * Typed triggers: breakout (break + retest at break), fvg_entry (FVG zone separate), reversal (sweep/reclaim).
 */

function n4(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function clampZone(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return [n4(a), n4(b)];
}

/** Retest band hugging the break level (not the FVG). */
function breakRetestZoneLong(breakPrice, atr) {
  if (!Number.isFinite(breakPrice)) return null;
  const pad =
    Number.isFinite(atr) && atr > 0
      ? Math.max(atr * 0.12, breakPrice * 0.0004)
      : breakPrice * 0.0012;
  const lo = breakPrice - pad;
  const hi = breakPrice - Math.min(pad * 0.15, pad * 0.25);
  return clampZone(lo, hi);
}

function breakRetestZoneShort(breakPrice, atr) {
  if (!Number.isFinite(breakPrice)) return null;
  const pad =
    Number.isFinite(atr) && atr > 0
      ? Math.max(atr * 0.12, breakPrice * 0.0004)
      : breakPrice * 0.0012;
  const lo = breakPrice + Math.min(pad * 0.15, pad * 0.25);
  const hi = breakPrice + pad;
  return clampZone(lo, hi);
}

function fvgZone(fvg) {
  if (!fvg?.is_valid || !Number.isFinite(fvg.bottom) || !Number.isFinite(fvg.top)) return null;
  return clampZone(fvg.bottom, fvg.top);
}

function buildTriggers(executionState, lastBarFeature = null) {
  if (!executionState) return null;

  const hi = executionState.range_high;
  const lo = executionState.range_low;
  const loc = executionState.price_location;
  const atr = Number.isFinite(lastBarFeature?.atr) ? lastBarFeature.atr : null;
  const fvg = lastBarFeature?.fvg;
  const swingLow = lastBarFeature?.last_swing_low;
  const swingHigh = lastBarFeature?.last_swing_high;

  const longBreak = n4(hi);
  const shortBreak = n4(lo);

  const longInv =
    Number.isFinite(swingLow) && Number.isFinite(atr)
      ? n4(swingLow - atr * 0.25)
      : Number.isFinite(lo)
        ? n4(lo)
        : null;

  const shortInv =
    Number.isFinite(swingHigh) && Number.isFinite(atr)
      ? n4(swingHigh + atr * 0.25)
      : Number.isFinite(hi)
        ? n4(hi)
        : null;

  const breakout = {
    long: {
      break: longBreak,
      retest_zone: breakRetestZoneLong(longBreak, atr),
      confirmation: [
        longBreak != null ? `5m close above ${longBreak} (break)` : "5m close above range_high",
        "hold / retest hold above break (see retest_zone at break, not FVG)",
        loc === "near_support" ? "optional: spring from range_low then expand" : null
      ].filter(Boolean),
      invalidation: longInv
    },
    short: {
      break: shortBreak,
      retest_zone: breakRetestZoneShort(shortBreak, atr),
      confirmation: [
        shortBreak != null ? `5m close below ${shortBreak} (break)` : "5m close below range_low",
        "hold / retest hold below break",
        loc === "near_resistance" ? "optional: fake breakout then rejection" : null
      ].filter(Boolean),
      invalidation: shortInv
    }
  };

  const fvg_entry = {
    long:
      fvg?.is_valid && fvg.type === "bullish"
        ? {
            fvg_zone: fvgZone(fvg),
            confirmation: [
              "limit/reaction inside fvg_zone or deep partial fill",
              "bullish displacement or reclaim after touch",
              "invalid if acceptance below fvg_zone with momentum"
            ],
            invalidation: Number.isFinite(fvg.bottom) ? n4(fvg.bottom - (atr || 0) * 0.2) : longInv
          }
        : null,
    short:
      fvg?.is_valid && fvg.type === "bearish"
        ? {
            fvg_zone: fvgZone(fvg),
            confirmation: [
              "reaction inside fvg_zone from premium",
              "bearish displacement after touch",
              "invalid if reclaim above fvg_zone"
            ],
            invalidation: Number.isFinite(fvg.top) ? n4(fvg.top + (atr || 0) * 0.2) : shortInv
          }
        : null
  };

  const reversal = {
    long:
      lastBarFeature?.sweep_low && Number.isFinite(swingLow)
        ? {
            trigger_type: "sweep_low_reclaim",
            sweep_reference: n4(swingLow),
            confirmation: [
              `reclaim and close back above ${n4(swingLow)}`,
              "ideally bullish CHoCH / BOS on 5m",
              "use fvg_entry if bullish FVG overlaps reclaim"
            ],
            invalidation: Number.isFinite(swingLow) && Number.isFinite(atr) ? n4(swingLow - atr * 0.35) : longInv
          }
        : null,
    short:
      lastBarFeature?.sweep_high && Number.isFinite(swingHigh)
        ? {
            trigger_type: "sweep_high_reject",
            sweep_reference: n4(swingHigh),
            confirmation: [
              `lose ${n4(swingHigh)} again with supply`,
              "bearish CHoCH / BOS on 5m",
              "use fvg_entry if bearish FVG overlaps rejection"
            ],
            invalidation: Number.isFinite(swingHigh) && Number.isFinite(atr) ? n4(swingHigh + atr * 0.35) : shortInv
          }
        : null
  };

  return {
    breakout,
    fvg_entry,
    reversal,
    context: {
      price_location: loc,
      is_at_extreme: executionState.is_at_extreme
    }
  };
}

module.exports = { buildTriggers };
