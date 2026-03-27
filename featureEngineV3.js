function featureEngineV3(bars, options = {}) {
  const config = {
    swingLookback: options.swingLookback ?? 2,
    volumeLookback: options.volumeLookback ?? 20,
    atrLength: options.atrLength ?? 14,
    equalTolerancePct: options.equalTolerancePct ?? 0.0015,
    displacementRangeMultiplier: options.displacementRangeMultiplier ?? 1.2,
    displacementBodyRatioThreshold: options.displacementBodyRatioThreshold ?? 0.6,
    obLookback: options.obLookback ?? 6,
    recentTailSize: options.recentTailSize ?? 8,
    percentileWindow: options.percentileWindow ?? 50,
    rangeCompressionLookback: options.rangeCompressionLookback ?? 8,
    minFvgAtrFraction: options.minFvgAtrFraction ?? 0.12,
    candidateAtrPad: options.candidateAtrPad ?? 0.15,
    /** How many full feature rows to include at end of API payload (server/LLM). */
    featuresRecentCount: options.featuresRecentCount ?? 12,
    /** Drop trade_candidates legs with estimated R:R below this (junk for LLM). */
    minTradeCandidateRr: options.minTradeCandidateRr ?? 1.2,
    /** Reject candidates whose stop distance is wider than this × ATR (invalidation too far). */
    maxCandidateRiskAtrMultiple: options.maxCandidateRiskAtrMultiple ?? 3
  };

  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      bar_count: 0,
      last_bar: null,
      features_recent: [],
      config_used: { ...config }
    };
  }

  // =========================
  // Helpers
  // =========================
  const isNum = (v) => Number.isFinite(v);

  const avg = (arr) => {
    const valid = arr.filter(isNum);
    if (!valid.length) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  };

  const sum = (arr) => {
    const valid = arr.filter(isNum);
    return valid.reduce((a, b) => a + b, 0);
  };

  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

  const round = (v, decimals = 4) => {
    if (!isNum(v)) return null;
    const p = Math.pow(10, decimals);
    return Math.round(v * p) / p;
  };

  const safeDate = (timestamp) => {
    if (!timestamp) return null;
    const d = new Date(timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const getTimestamp = (bar) => bar.timestamp ?? bar.time ?? bar.date ?? null;

  const getSession = (timestamp) => {
    const d = safeDate(timestamp);
    if (!d) return "unknown";

    const total = d.getUTCHours() * 60 + d.getUTCMinutes();

    if (total >= 13 * 60 + 30 && total < 14 * 60 + 30) return "ny_open";
    if (total >= 14 * 60 + 30 && total < 19 * 60) return "regular";
    if (total >= 19 * 60 && total < 20 * 60) return "power_hour";
    if (total >= 20 * 60 && total < 24 * 60) return "after_hours";
    if (total >= 8 * 60 && total < 13 * 60 + 30) return "pre_market";
    return "overnight";
  };

  const getRange = (bar) => {
    if (!bar) return 0;
    const high = bar.high ?? bar.close ?? 0;
    const low = bar.low ?? bar.close ?? 0;
    return Math.max(0, high - low);
  };

  const getBody = (bar) => {
    if (!bar) return 0;
    return Math.abs((bar.close ?? 0) - (bar.open ?? 0));
  };

  const getBodyRatio = (bar) => {
    const range = getRange(bar);
    if (!range) return 0;
    return getBody(bar) / range;
  };

  const isBullish = (bar) => (bar?.close ?? 0) > (bar?.open ?? 0);
  const isBearish = (bar) => (bar?.close ?? 0) < (bar?.open ?? 0);

  const typicalPrice = (bar) => {
    if (!bar) return null;
    return ((bar.high ?? 0) + (bar.low ?? 0) + (bar.close ?? 0)) / 3;
  };

  const percentDiff = (a, b) => {
    if (!isNum(a) || !isNum(b) || a === 0 || b === 0) return Infinity;
    return Math.abs(a - b) / ((Math.abs(a) + Math.abs(b)) / 2);
  };

  const getVWAP = (slice) => {
    let totalPV = 0;
    let totalVol = 0;

    for (const b of slice) {
      const vol = b.volume ?? 0;
      if (!isNum(vol) || vol <= 0) continue;

      const tp = typicalPrice(b);
      totalPV += tp * vol;
      totalVol += vol;
    }

    if (!totalVol) return null;
    return totalPV / totalVol;
  };

  const getATR = (sourceBars, i, length = 14) => {
    if (i <= 0) return null;
    const start = Math.max(1, i - length + 1);
    const trs = [];

    for (let j = start; j <= i; j++) {
      const curr = sourceBars[j];
      const prev = sourceBars[j - 1];

      const high = curr.high ?? curr.close ?? 0;
      const low = curr.low ?? curr.close ?? 0;
      const prevClose = prev?.close ?? curr.close ?? 0;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      trs.push(tr);
    }

    return avg(trs);
  };

  const percentileRank = (value, values) => {
    const valid = values.filter(isNum);
    if (!valid.length || !isNum(value)) return null;
    const below = valid.filter(v => v <= value).length;
    return below / valid.length;
  };

  const detectSwingHigh = (sourceBars, i, lookback = 2) => {
    if (i < lookback || i > sourceBars.length - lookback - 1) return false;
    const currentHigh = sourceBars[i].high;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((sourceBars[j].high ?? -Infinity) >= currentHigh) return false;
    }
    return true;
  };

  const detectSwingLow = (sourceBars, i, lookback = 2) => {
    if (i < lookback || i > sourceBars.length - lookback - 1) return false;
    const currentLow = sourceBars[i].low;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((sourceBars[j].low ?? Infinity) <= currentLow) return false;
    }
    return true;
  };

  const detectEqualHighLow = (sourceBars, i) => {
    if (i < 3) {
      return { equal_highs: false, equal_lows: false };
    }

    const highs = sourceBars.slice(i - 3, i + 1).map(b => b.high);
    const lows = sourceBars.slice(i - 3, i + 1).map(b => b.low);
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];

    const equalHighs = highs.slice(0, -1).every(h => percentDiff(h, lastHigh) <= config.equalTolerancePct);
    const equalLows = lows.slice(0, -1).every(l => percentDiff(l, lastLow) <= config.equalTolerancePct);

    return {
      equal_highs: equalHighs,
      equal_lows: equalLows
    };
  };

  const calculatePDArray = (price, swingHigh, swingLow) => {
    if (!isNum(price) || !isNum(swingHigh) || !isNum(swingLow)) return null;

    const range = swingHigh - swingLow;
    if (!isNum(range) || range <= 0) return null;

    const midpoint = swingLow + range / 2;
    const positionRaw = (price - swingLow) / range;
    const positionClamped = clamp(positionRaw, 0, 1);

    let baseZone = "equilibrium";
    if (positionClamped < 0.45) baseZone = "discount";
    else if (positionClamped > 0.55) baseZone = "premium";

    let extremeZone = null;
    if (positionRaw < 0) extremeZone = "extreme_discount";
    else if (positionRaw > 1) extremeZone = "extreme_premium";

    const finalZone = extremeZone ?? baseZone;

    return {
      zone: finalZone,
      base_zone: baseZone,
      extreme_zone: extremeZone,
      outside_range: positionRaw < 0 || positionRaw > 1,
      position_raw: round(positionRaw, 6),
      position_clamped: round(positionClamped, 6),
      midpoint: round(midpoint, 4),
      distance_to_high: round((swingHigh - price) / range, 6),
      distance_to_low: round((price - swingLow) / range, 6),
      optimal_long: finalZone === "discount" || finalZone === "extreme_discount",
      optimal_short: finalZone === "premium" || finalZone === "extreme_premium"
    };
  };

  const detectDisplacement = (sourceBars, i) => {
    const bar = sourceBars[i];
    const prevSlice = sourceBars.slice(Math.max(0, i - 5), i);
    const avgRange = avg(prevSlice.map(getRange)) ?? 0;
    const range = getRange(bar);
    const bodyRatio = getBodyRatio(bar);
    const rangeRatio = avgRange > 0 ? range / avgRange : 0;

    const bullish =
      isBullish(bar) &&
      bodyRatio >= config.displacementBodyRatioThreshold &&
      rangeRatio >= config.displacementRangeMultiplier;

    const bearish =
      isBearish(bar) &&
      bodyRatio >= config.displacementBodyRatioThreshold &&
      rangeRatio >= config.displacementRangeMultiplier;

    return {
      bullish,
      bearish,
      body_ratio: round(bodyRatio, 6),
      range_ratio: round(rangeRatio, 6)
    };
  };

  const detectRejection = (bar) => {
    const bodyTop = Math.max(bar.open ?? 0, bar.close ?? 0);
    const bodyBottom = Math.min(bar.open ?? 0, bar.close ?? 0);
    const upperWick = Math.max(0, (bar.high ?? bodyTop) - bodyTop);
    const lowerWick = Math.max(0, bodyBottom - (bar.low ?? bodyBottom));
    const body = getBody(bar) || 0.0000001;

    return {
      bullish: lowerWick > body * 1.5 && upperWick < body,
      bearish: upperWick > body * 1.5 && lowerWick < body,
      upper_wick: round(upperWick, 4),
      lower_wick: round(lowerWick, 4)
    };
  };

  const detectCompression = (sourceBars, i) => {
    if (i < config.rangeCompressionLookback) return false;

    const recent = sourceBars.slice(i - 3, i + 1);
    const recentAvg = avg(recent.map(getRange)) ?? 0;

    const older = sourceBars.slice(
      Math.max(0, i - config.rangeCompressionLookback),
      Math.max(0, i - 4)
    );
    const olderAvg = avg(older.map(getRange)) ?? 0;

    if (!olderAvg) return false;
    return recentAvg < olderAvg * 0.7;
  };

  const detectMomentum = (sourceBars, i) => {
    if (i < 3) return null;

    const recent = sourceBars.slice(i - 3, i + 1);
    const bullishCount = recent.filter(isBullish).length;
    const bearishCount = recent.filter(isBearish).length;
    const firstClose = recent[0].close;
    const lastClose = recent[recent.length - 1].close;

    const bodies = recent.map(getBody);
    const ranges = recent.map(getRange);
    const avgBody = avg(bodies) ?? 0;
    const avgRange = avg(ranges) ?? 0;

    const strongBull = recent.filter(
      b => isBullish(b) && getBody(b) >= avgBody && getRange(b) >= avgRange * 0.9
    ).length;

    const strongBear = recent.filter(
      b => isBearish(b) && getBody(b) >= avgBody && getRange(b) >= avgRange * 0.9
    ).length;

    if (strongBull >= 3 && lastClose > firstClose) return "strong_up";
    if (strongBear >= 3 && lastClose < firstClose) return "strong_down";
    if (bullishCount >= 3 && lastClose > firstClose) return "up";
    if (bearishCount >= 3 && lastClose < firstClose) return "down";
    if (lastClose > firstClose) return "up";
    if (lastClose < firstClose) return "down";
    return "flat";
  };

  const detectFVG = (sourceBars, i, currentPrice, atrValue) => {
    if (i < 2) return null;

    const a = sourceBars[i - 2];
    const b = sourceBars[i - 1];
    const c = sourceBars[i];
    let fvg = null;

    if ((a.high ?? -Infinity) < (c.low ?? Infinity)) {
      fvg = {
        type: "bullish",
        top: c.low,
        bottom: a.high,
        size: c.low - a.high,
        midpoint: (c.low + a.high) / 2,
        created_at_index: i
      };
    } else if ((a.low ?? Infinity) > (c.high ?? -Infinity)) {
      fvg = {
        type: "bearish",
        top: a.low,
        bottom: c.high,
        size: a.low - c.high,
        midpoint: (a.low + c.high) / 2,
        created_at_index: i
      };
    }

    if (!fvg) return null;

    const minSizeValid = isNum(atrValue)
      ? fvg.size >= atrValue * config.minFvgAtrFraction
      : true;

    const futureBars = sourceBars.slice(i + 1);

    const isFilled = fvg.type === "bullish"
      ? futureBars.some(x => (x.low ?? Infinity) <= fvg.bottom)
      : futureBars.some(x => (x.high ?? -Infinity) >= fvg.top);

    const isTouched = fvg.type === "bullish"
      ? futureBars.some(x => (x.low ?? Infinity) <= fvg.top && (x.high ?? -Infinity) >= fvg.bottom)
      : futureBars.some(x => (x.high ?? -Infinity) >= fvg.bottom && (x.low ?? Infinity) <= fvg.top);

    return {
      type: fvg.type,
      top: round(fvg.top, 4),
      bottom: round(fvg.bottom, 4),
      size: round(fvg.size, 4),
      midpoint: round(fvg.midpoint, 4),
      created_at_index: fvg.created_at_index,
      is_valid: minSizeValid && !isFilled,
      is_filled: isFilled,
      is_touched: isTouched,
      formed_with_displacement: getRange(c) > getRange(b) * config.displacementRangeMultiplier,
      distance_from_price: isNum(currentPrice) ? round(Math.abs(currentPrice - fvg.midpoint), 4) : null,
      distance_from_price_atr: isNum(currentPrice) && isNum(atrValue) && atrValue > 0
        ? round(Math.abs(currentPrice - fvg.midpoint) / atrValue, 4)
        : null,
      age_bars: 0
    };
  };

  const detectOrderBlock = (sourceBars, i, structureBreak) => {
    if (i < 3 || !structureBreak) return null;

    for (let j = i - 1; j >= Math.max(0, i - config.obLookback); j--) {
      const c = sourceBars[j];

      if (structureBreak === "bullish" && isBearish(c)) {
        return {
          type: "bullish",
          high: c.high,
          low: c.low,
          midpoint: ((c.high ?? 0) + (c.low ?? 0)) / 2,
          index: j,
          created_by_bos: true,
          created_by_displacement: getBodyRatio(sourceBars[i]) >= config.displacementBodyRatioThreshold
        };
      }

      if (structureBreak === "bearish" && isBullish(c)) {
        return {
          type: "bearish",
          high: c.high,
          low: c.low,
          midpoint: ((c.high ?? 0) + (c.low ?? 0)) / 2,
          index: j,
          created_by_bos: true,
          created_by_displacement: getBodyRatio(sourceBars[i]) >= config.displacementBodyRatioThreshold
        };
      }
    }

    return null;
  };

  const inferStructureState = (feature) => {
    if (feature.sweep_low) return "liquidity_sweep_low";
    if (feature.sweep_high) return "liquidity_sweep_high";
    if (feature.bos_bullish) return "bullish_break";
    if (feature.bos_bearish) return "bearish_break";
    if (feature.equal_highs) return "equal_highs";
    if (feature.equal_lows) return "equal_lows";
    return "range";
  };

  const inferIntent = (feature) => {
    if (feature.setup?.type === "bull_trap" || feature.setup?.type === "bear_trap") return "trap";
    if (feature.bos_bullish || feature.bos_bearish) return "breakout";
    if (feature.sweep_low || feature.sweep_high) return "liquidity";
    return "range";
  };

  const inferMarketContext = (feature) => {
    let volatility = "normal";
    if (feature.displacement?.bullish || feature.displacement?.bearish) volatility = "expanded";
    else if (feature.compression) volatility = "compressed";

    let regime = "range";
    if (feature.bos_bullish || feature.bos_bearish) regime = "breakout";
    else if (feature.sweep_low || feature.sweep_high) regime = "liquidity_event";

    return {
      regime,
      session: feature.session,
      volatility
    };
  };

  /**
   * Volume reliability for *this bar*: requires a positive reported volume on the bar.
   * Otherwise percentile/spike are computed against zeros/nulls and must not read as "high".
   */
  const buildFeatureReliability = (feature, avgVol, volumePercentile, rawBarVolume) => {
    const hasReportedVolume =
      rawBarVolume != null && rawBarVolume !== "" && Number(rawBarVolume) > 0;
    const volumeReliability =
      hasReportedVolume && avgVol > 0 && volumePercentile != null ? "high" : "low";

    return {
      volume: volumeReliability,
      vwap: feature.vwap != null ? "high" : "low",
      pd_array: feature.pd_array ? "high" : "low",
      structure:
        isNum(feature.last_swing_high) || isNum(feature.last_swing_low)
          ? "medium"
          : "low",
      session: feature.session === "unknown" ? "low" : "high",
      liquidity_target: feature.liquidity_target ? "medium" : "low",
      fvg: feature.fvg ? (feature.fvg.is_valid ? "medium" : "low") : "low",
      order_block: feature.order_block ? (feature.order_block.is_valid ? "medium" : "low") : "low"
    };
  };

  const buildConfluence = (feature) => {
    const bullish = [];
    const bearish = [];
    const conflicts = [];

    if (feature.above_vwap === true) bullish.push("above_vwap");
    if (feature.above_vwap === false) bearish.push("below_vwap");

    if (feature.bos_bullish) bullish.push("bullish_bos");
    if (feature.bos_bearish) bearish.push("bearish_bos");

    if (feature.sweep_low) bullish.push("sweep_low");
    if (feature.sweep_high) bearish.push("sweep_high");

    if (feature.pd_array?.zone === "discount" || feature.pd_array?.zone === "extreme_discount") {
      bullish.push("discount_zone");
    }
    if (feature.pd_array?.zone === "premium" || feature.pd_array?.zone === "extreme_premium") {
      bearish.push("premium_zone");
    }

    if (feature.fvg?.type === "bullish" && feature.fvg?.is_valid) bullish.push("valid_bullish_fvg");
    if (feature.fvg?.type === "bearish" && feature.fvg?.is_valid) bearish.push("valid_bearish_fvg");

    if (feature.order_block?.type === "bullish" && feature.order_block?.is_valid) bullish.push("fresh_bullish_ob");
    if (feature.order_block?.type === "bearish" && feature.order_block?.is_valid) bearish.push("fresh_bearish_ob");

    if (feature.volume_spike) bullish.push("volume_activity");

    if (bullish.length && bearish.length) conflicts.push("mixed_signals");
    if (feature.feature_reliability?.volume === "low") conflicts.push("low_volume_reliability");

    return {
      bullish_points: bullish,
      bearish_points: bearish,
      conflicts
    };
  };

  /**
   * Direction = path from current price to target (never "down" with target above price).
   */
  const buildLiquidityTarget = (feature) => {
    const close = feature.close;
    if (!isNum(close)) return null;

    let target_price = null;
    let pattern = null;

    if (feature.sweep_low && isNum(feature.last_swing_high)) {
      target_price = feature.last_swing_high;
      pattern = "sweep_low_to_high_liquidity";
    } else if (feature.sweep_high && isNum(feature.last_swing_low)) {
      target_price = feature.last_swing_low;
      pattern = "sweep_high_to_low_liquidity";
    } else if (feature.bos_bullish && isNum(feature.last_swing_high)) {
      target_price = feature.last_swing_high;
      pattern = "bullish_break_continuation";
    } else if (feature.bos_bearish && isNum(feature.last_swing_low)) {
      target_price = feature.last_swing_low;
      pattern = "bearish_break_continuation";
    }

    if (!isNum(target_price)) return null;

    const eps = Math.max(1e-8, Math.abs(close) * 1e-7);
    let direction;
    if (target_price > close + eps) direction = "up";
    else if (target_price < close - eps) direction = "down";
    else {
      direction = "at_target";
    }

    const geometry_note =
      direction === "at_target"
        ? "price_at_reference_liquidity"
        : "direction_is_sign_target_minus_price";

    /** Bearish continuation can still show direction "up" if price broke below swing low: target is that low above current (retest path). */
    let llm_geometry_note = null;
    if (pattern === "bearish_break_continuation" && direction === "up") {
      llm_geometry_note =
        "bearish_continuation_with_target_above_price: mapped_liquidity_is_prior_swing_low_used_as_retest_magnet_not_bullish_bias";
    } else if (pattern === "bullish_break_continuation" && direction === "down") {
      llm_geometry_note =
        "bullish_continuation_with_target_below_price: mapped_liquidity_is_prior_swing_high_below_price_typical_retest_path";
    }

    return {
      direction,
      target_price: round(target_price, 4),
      price: round(close, 4),
      pattern,
      distance: round(Math.abs(close - target_price), 4),
      geometry_note,
      llm_geometry_note
    };
  };

  const buildConflictAlert = (feature) => {
    const flags = feature.confluence?.conflicts ?? [];
    const present = flags.length > 0;
    return {
      present,
      severity: present ? "high" : "none",
      flags: [...flags],
      mixed_signals: flags.includes("mixed_signals"),
      recommendation: present
        ? "stand_down_until_engine_conflicts_resolve"
        : "no_engine_conflict_flags"
    };
  };

  const classifySetup = (feature, prevFeature) => {
    if (!prevFeature) {
      return {
        type: "none",
        confidence: 0,
        reasons: []
      };
    }

    if (
      prevFeature.bos_bullish &&
      feature.close < prevFeature.close &&
      !feature.volume_spike &&
      feature.momentum !== "strong_up"
    ) {
      return {
        type: "bull_trap",
        confidence: 0.7,
        reasons: ["failed_bos", "no_volume", "reversal"]
      };
    }

    if (
      prevFeature.bos_bearish &&
      feature.close > prevFeature.close &&
      !feature.volume_spike &&
      feature.momentum !== "strong_down"
    ) {
      return {
        type: "bear_trap",
        confidence: 0.7,
        reasons: ["failed_bos", "no_volume", "reversal"]
      };
    }

    return {
      type: "none",
      confidence: 0,
      reasons: []
    };
  };

  const buildSetupAnalysis = (feature) => {
    const missing = [];

    const hasStructureEvent =
      feature.bos_bullish || feature.bos_bearish || feature.sweep_low || feature.sweep_high;

    if (!hasStructureEvent) missing.push("no_structure_event");
    if (!feature.volume_spike) missing.push("no_volume_confirmation");
    if (!feature.displacement?.bullish && !feature.displacement?.bearish) {
      missing.push("no_displacement");
    }
    if (["after_hours", "pre_market", "overnight", "unknown"].includes(feature.session)) {
      missing.push("weak_session_context");
    }

    let quality = "weak";
    if (missing.length === 0) quality = "strong";
    else if (missing.length <= 2) quality = "moderate";

    return {
      setup_quality: quality,
      reasons_missing: missing
    };
  };

  const buildBreakoutStrength = (feature) => {
    let score = 0;
    if (feature.volume_spike) score += 30;
    if (feature.displacement?.bullish || feature.displacement?.bearish) score += 30;
    if (feature.bos_bullish || feature.bos_bearish) score += 25;
    if (feature.above_vwap === true || feature.above_vwap === false) score += 15;

    let label = "none";
    if (score >= 70) label = "strong";
    else if (score >= 40) label = "moderate";
    else if (score > 0) label = "weak";

    return { score, label };
  };

  const buildTriggerContext = (feature) => {
    const confirmationSignals = [];
    const invalidationSignals = [];

    if (feature.volume_spike) confirmationSignals.push("volume_spike");
    if (feature.displacement?.bullish || feature.displacement?.bearish) confirmationSignals.push("displacement");
    if (feature.above_vwap === true) confirmationSignals.push("above_vwap");
    if (feature.above_vwap === false) invalidationSignals.push("below_vwap");

    return {
      trigger_type_detected: feature.setup?.type || "none",
      confirmation_signals: confirmationSignals,
      invalidation_signals: invalidationSignals
    };
  };

  const buildStateTransition = (prevFeature, feature) => {
    if (!prevFeature) return null;

    const changes = [];

    if (prevFeature.structure_state !== feature.structure_state) {
      changes.push(`structure:${prevFeature.structure_state}->${feature.structure_state}`);
    }
    if (prevFeature.momentum !== feature.momentum) {
      changes.push(`momentum:${prevFeature.momentum}->${feature.momentum}`);
    }
    if ((prevFeature.bos || "none") !== (feature.bos || "none")) {
      changes.push(`bos:${prevFeature.bos || "none"}->${feature.bos || "none"}`);
    }
    if ((prevFeature.setup?.type || "none") !== (feature.setup?.type || "none")) {
      changes.push(`setup:${prevFeature.setup?.type || "none"}->${feature.setup?.type || "none"}`);
    }

    return {
      previous_structure: prevFeature.structure_state,
      current_structure: feature.structure_state,
      previous_momentum: prevFeature.momentum,
      current_momentum: feature.momentum,
      changes
    };
  };

  // =========================
  // Trade candidates
  // Not decisions. Just possibilities.
  // =========================
  const buildTradeCandidates = (feature, atrValue) => {
    const candidates = {
      long: null,
      short: null
    };

    const atr = isNum(atrValue) && atrValue > 0 ? atrValue : null;
    const pad = atr ? atr * config.candidateAtrPad : null;

    const addCandidate = (side, entryRef, invalidationRef, targetRef, rationale) => {
      if (!isNum(entryRef) || !isNum(invalidationRef) || !isNum(targetRef)) return;

      const risk = side === "long"
        ? entryRef - invalidationRef
        : invalidationRef - entryRef;

      const reward = side === "long"
        ? targetRef - entryRef
        : entryRef - targetRef;

      if (!isNum(risk) || !isNum(reward) || risk <= 0 || reward <= 0) return;

      candidates[side] = {
        entry_reference: round(entryRef, 4),
        invalidation_reference: round(invalidationRef, 4),
        target_reference: round(targetRef, 4),
        risk_distance: round(risk, 4),
        reward_distance: round(reward, 4),
        rr_estimate: round(reward / risk, 4),
        rationale
      };
    };

    // LONG candidate
    const longEntry =
      feature.fvg?.type === "bullish" && feature.fvg.is_valid
        ? feature.fvg.midpoint
        : feature.order_block?.type === "bullish" && feature.order_block.is_valid
          ? feature.order_block.midpoint
          : feature.pd_array?.optimal_long && isNum(feature.last_swing_low)
            ? feature.last_swing_low + ((atr ?? 0) * 0.25)
            : null;

    const longInvalidation =
      isNum(feature.last_swing_low)
        ? (pad ? feature.last_swing_low - pad : feature.last_swing_low)
        : null;

    const longTarget =
      feature.liquidity_target?.direction === "up"
        ? feature.liquidity_target.target_price
        : isNum(feature.last_swing_high)
          ? feature.last_swing_high
          : null;

    addCandidate(
      "long",
      longEntry,
      longInvalidation,
      longTarget,
      [
        feature.fvg?.type === "bullish" && feature.fvg.is_valid ? "bullish_fvg_midpoint" : null,
        feature.order_block?.type === "bullish" && feature.order_block.is_valid ? "bullish_order_block_midpoint" : null,
        feature.pd_array?.optimal_long ? "pd_discount_context" : null,
        feature.liquidity_target?.direction === "up" ? "upside_liquidity_target" : null
      ].filter(Boolean)
    );

    // SHORT candidate
    const shortEntry =
      feature.fvg?.type === "bearish" && feature.fvg.is_valid
        ? feature.fvg.midpoint
        : feature.order_block?.type === "bearish" && feature.order_block.is_valid
          ? feature.order_block.midpoint
          : feature.pd_array?.optimal_short && isNum(feature.last_swing_high)
            ? feature.last_swing_high - ((atr ?? 0) * 0.25)
            : null;

    const shortInvalidation =
      isNum(feature.last_swing_high)
        ? (pad ? feature.last_swing_high + pad : feature.last_swing_high)
        : null;

    const shortTarget =
      feature.liquidity_target?.direction === "down"
        ? feature.liquidity_target.target_price
        : isNum(feature.last_swing_low)
          ? feature.last_swing_low
          : null;

    addCandidate(
      "short",
      shortEntry,
      shortInvalidation,
      shortTarget,
      [
        feature.fvg?.type === "bearish" && feature.fvg.is_valid ? "bearish_fvg_midpoint" : null,
        feature.order_block?.type === "bearish" && feature.order_block.is_valid ? "bearish_order_block_midpoint" : null,
        feature.pd_array?.optimal_short ? "pd_premium_context" : null,
        feature.liquidity_target?.direction === "down" ? "downside_liquidity_target" : null
      ].filter(Boolean)
    );

    const minRr = config.minTradeCandidateRr;
    const maxRiskAtr = isNum(atr) && atr > 0 && isNum(config.maxCandidateRiskAtrMultiple)
      ? atr * config.maxCandidateRiskAtrMultiple
      : null;

    const rejectLong = (c) => {
      if (!c) return null;
      if (isNum(c.rr_estimate) && c.rr_estimate < minRr) return null;
      if (maxRiskAtr != null && isNum(c.risk_distance) && c.risk_distance > maxRiskAtr) return null;
      return c;
    };
    const rejectShort = (c) => {
      if (!c) return null;
      if (isNum(c.rr_estimate) && c.rr_estimate < minRr) return null;
      if (maxRiskAtr != null && isNum(c.risk_distance) && c.risk_distance > maxRiskAtr) return null;
      return c;
    };

    candidates.long = rejectLong(candidates.long);
    candidates.short = rejectShort(candidates.short);

    return candidates;
  };

  const buildNoTradeContext = (feature) => {
    const reasons = [];

    if (feature.setup?.type === "none") reasons.push("no_clear_setup");
    if (!feature.volume_spike) reasons.push("no_volume_confirmation");
    if (feature.confluence?.conflicts?.includes("mixed_signals")) reasons.push("mixed_signals");
    if (["after_hours", "overnight", "pre_market"].includes(feature.session)) reasons.push("weak_session");
    if (feature.feature_reliability?.volume === "low") reasons.push("low_volume_reliability");

    return reasons;
  };

  // =========================
  // Main loop
  // =========================
  const results = [];
  let lastSwingHigh = null;
  let lastSwingLow = null;
  let activeFVG = null;
  let activeOrderBlock = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevFeature = results[i - 1] ?? null;
    const timestamp = getTimestamp(bar);
    const session = getSession(timestamp);

    const volSlice = bars.slice(Math.max(0, i - config.volumeLookback + 1), i + 1);
    const avgVol = avg(volSlice.map(b => b.volume ?? 0)) ?? 0;
    const volumeRelative = avgVol > 0 ? (bar.volume ?? 0) / avgVol : null;

    const pctSlice = bars.slice(Math.max(0, i - config.percentileWindow + 1), i + 1);
    const volumePercentile = percentileRank(bar.volume ?? 0, pctSlice.map(b => b.volume ?? 0));

    const atrValue = getATR(bars, i, config.atrLength);
    const vwap = getVWAP(bars.slice(0, i + 1));
    const aboveVWAP = vwap == null ? null : (bar.close > vwap);
    const distanceToVWAP = vwap == null ? null : bar.close - vwap;

    const swingHigh = detectSwingHigh(bars, i, config.swingLookback);
    const swingLow = detectSwingLow(bars, i, config.swingLookback);

    if (swingHigh) lastSwingHigh = bar.high;
    if (swingLow) lastSwingLow = bar.low;

    const eq = detectEqualHighLow(bars, i);

    let bos = false;
    let bosBullish = false;
    let bosBearish = false;
    let choch = false;
    let sweepLow = false;
    let sweepHigh = false;

    if (isNum(lastSwingHigh) && bar.close > lastSwingHigh) {
      bos = "bullish";
      bosBullish = true;
      if (prevFeature?.bos_bearish) choch = true;
    }

    if (isNum(lastSwingLow) && bar.close < lastSwingLow) {
      bos = "bearish";
      bosBearish = true;
      if (prevFeature?.bos_bullish) choch = true;
    }

    if (isNum(lastSwingLow) && bar.low < lastSwingLow && bar.close > lastSwingLow) {
      sweepLow = true;
    }

    if (isNum(lastSwingHigh) && bar.high > lastSwingHigh && bar.close < lastSwingHigh) {
      sweepHigh = true;
    }

    const displacement = detectDisplacement(bars, i);
    const rejection = detectRejection(bar);
    const compression = detectCompression(bars, i);
    const momentum = detectMomentum(bars, i);

    const pdArray = calculatePDArray(bar.close, lastSwingHigh, lastSwingLow);

    const rawFVG = detectFVG(bars, i, bar.close, atrValue);
    if (rawFVG) activeFVG = rawFVG;

    if (activeFVG) {
      activeFVG = {
        ...activeFVG,
        age_bars: i - activeFVG.created_at_index,
        distance_from_price: round(Math.abs(bar.close - activeFVG.midpoint), 4),
        distance_from_price_atr: isNum(atrValue) && atrValue > 0
          ? round(Math.abs(bar.close - activeFVG.midpoint) / atrValue, 4)
          : null
      };
    }

    const rawOB = detectOrderBlock(bars, i, bos);
    if (rawOB) activeOrderBlock = rawOB;

    if (activeOrderBlock) {
      const touched = bars
        .slice(activeOrderBlock.index + 1, i + 1)
        .some(x => (x.low ?? Infinity) <= activeOrderBlock.high && (x.high ?? -Infinity) >= activeOrderBlock.low);

      activeOrderBlock = {
        ...activeOrderBlock,
        high: round(activeOrderBlock.high, 4),
        low: round(activeOrderBlock.low, 4),
        midpoint: round(activeOrderBlock.midpoint, 4),
        fresh: !touched,
        mitigated: touched,
        is_valid: !touched,
        distance_from_price: round(Math.abs(bar.close - activeOrderBlock.midpoint), 4),
        distance_from_price_atr: isNum(atrValue) && atrValue > 0
          ? round(Math.abs(bar.close - activeOrderBlock.midpoint) / atrValue, 4)
          : null,
        age_bars: i - activeOrderBlock.index
      };
    }

    const feature = {
      index: i,
      timestamp,
      session,
      open: round(bar.open, 4),
      high: round(bar.high, 4),
      low: round(bar.low, 4),
      close: round(bar.close, 4),
      volume: bar.volume ?? 0,
      price: round(bar.close, 4),

      swing_high: swingHigh,
      swing_low: swingLow,
      last_swing_high: isNum(lastSwingHigh) ? round(lastSwingHigh, 4) : null,
      last_swing_low: isNum(lastSwingLow) ? round(lastSwingLow, 4) : null,

      sweep_low: sweepLow,
      sweep_high: sweepHigh,
      choch,
      bos,
      bos_bullish: bosBullish,
      bos_bearish: bosBearish,

      equal_highs: eq.equal_highs,
      equal_lows: eq.equal_lows,

      volume_spike: avgVol > 0 ? (bar.volume ?? 0) > avgVol * 1.5 : false,
      volume_relative: round(volumeRelative, 4),
      volume_percentile: round(volumePercentile, 4),

      vwap: round(vwap, 4),
      above_vwap: aboveVWAP,
      distance_to_vwap: round(distanceToVWAP, 4),
      distance_to_vwap_atr: isNum(distanceToVWAP) && isNum(atrValue) && atrValue > 0
        ? round(Math.abs(distanceToVWAP) / atrValue, 4)
        : null,

      atr: round(atrValue, 4),
      trend_strength: i >= 5 ? round((bar.close - bars[i - 5].close) / (bars[i - 5].close || 1), 6) : null,
      momentum,

      pd_array: pdArray,
      fvg: activeFVG,
      order_block: activeOrderBlock,

      displacement,
      rejection,
      compression
    };

    feature.liquidity_target = buildLiquidityTarget(feature);
    feature.feature_reliability = buildFeatureReliability(feature, avgVol, volumePercentile, bar.volume);
    feature.setup = classifySetup(feature, prevFeature);
    feature.setup_analysis = buildSetupAnalysis(feature);
    feature.structure_state = inferStructureState(feature);
    feature.intent = inferIntent(feature);
    feature.market_context = inferMarketContext(feature);
    feature.breakout_strength = buildBreakoutStrength(feature);
    feature.trigger_context = buildTriggerContext(feature);

    feature.confluence = buildConfluence(feature);
    feature.conflict_alert = buildConflictAlert(feature);
    feature.state_transition = buildStateTransition(prevFeature, feature);

    feature.trade_candidates = buildTradeCandidates(feature, atrValue);
    feature.no_trade_context = buildNoTradeContext(feature);

    const compactTailStart = Math.max(0, i - config.recentTailSize + 1);
    feature.recent_tail = results
      .slice(compactTailStart, i)
      .map(x => ({
        index: x.index,
        price: x.price,
        session: x.session,
        momentum: x.momentum,
        structure_state: x.structure_state,
        bos: x.bos,
        sweep_low: x.sweep_low,
        sweep_high: x.sweep_high,
        volume_spike: x.volume_spike,
        above_vwap: x.above_vwap,
        pd_zone: x.pd_array?.zone ?? null,
        setup: x.setup?.type ?? "none"
      }))
      .concat([{
        index: feature.index,
        price: feature.price,
        session: feature.session,
        momentum: feature.momentum,
        structure_state: feature.structure_state,
        bos: feature.bos,
        sweep_low: feature.sweep_low,
        sweep_high: feature.sweep_high,
        volume_spike: feature.volume_spike,
        above_vwap: feature.above_vwap,
        pd_zone: feature.pd_array?.zone ?? null,
        setup: feature.setup?.type ?? "none"
      }]);

    results.push(feature);
  }

  const nRecent = Math.min(config.featuresRecentCount, results.length);
  return {
    bar_count: bars.length,
    last_bar: results.length ? results[results.length - 1] : null,
    features_recent: nRecent ? results.slice(-nRecent) : [],
    config_used: { ...config }
  };
}

module.exports = { featureEngineV3 };