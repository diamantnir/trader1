function featureEngineV4(bars, options = {}) {
  const config = {
    swingLookbackBase: options.swingLookbackBase ?? 4,
    volumeLookback: options.volumeLookback ?? 20,
    atrLength: options.atrLength ?? 14,
    obLookbackBase: options.obLookbackBase ?? 6,
    recentTailSize: options.recentTailSize ?? 8,
    percentileWindow: options.percentileWindow ?? 50,
    rangeCompressionLookback: options.rangeCompressionLookback ?? 8,
    minFvgAtrFractionBase: options.minFvgAtrFractionBase ?? 0.12,
    candidateAtrPadBase: options.candidateAtrPadBase ?? 0.15,
    featuresRecentCount: options.featuresRecentCount ?? 12,
    minTradeCandidateRrBase: options.minTradeCandidateRrBase ?? 1.2,
    maxCandidateRiskAtrMultipleBase: options.maxCandidateRiskAtrMultipleBase ?? 3,
    liquidityToleranceAtrFraction: options.liquidityToleranceAtrFraction ?? 0.08,
    liquidityTolerancePriceFraction: options.liquidityTolerancePriceFraction ?? 0.001,
    displacementBodyRatioThresholdBase: options.displacementBodyRatioThresholdBase ?? 0.6,
    displacementRangeZScoreThreshold: options.displacementRangeZScoreThreshold ?? 1.0,
    volumeSpikePercentileThreshold: options.volumeSpikePercentileThreshold ?? 0.9,
    volumeSpikeZScoreThreshold: options.volumeSpikeZScoreThreshold ?? 1.5,
    minStrengthForFvgObEntry: options.minStrengthForFvgObEntry ?? 2,
    /** When true: volume gaps are confidence_penalty, not hard no_trade blockers. */
    volumeAsPenaltyOnly: options.volumeAsPenaltyOnly ?? false
  };

  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      bar_count: 0,
      last_bar: null,
      features_recent: [],
      config_used: { ...config }
    };
  }

  const isNum = (v) => Number.isFinite(v);

  const avg = (arr) => {
    const valid = arr.filter(isNum);
    if (!valid.length) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
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

  const calcStd = (arr, mean = null) => {
    const valid = arr.filter(isNum);
    if (!valid.length) return null;
    const mu = mean ?? avg(valid);
    const variance = valid.reduce((sum, x) => sum + Math.pow(x - mu, 2), 0) / valid.length;
    return Math.sqrt(variance);
  };

  const percentileRank = (value, values) => {
    const valid = values.filter(isNum);
    if (!valid.length || !isNum(value)) return null;
    const below = valid.filter((v) => v <= value).length;
    return below / valid.length;
  };

  const zScore = (value, values) => {
    const valid = values.filter(isNum);
    if (!valid.length || !isNum(value)) return null;
    const mean = avg(valid);
    const std = calcStd(valid, mean);
    if (!std) return 0;
    return (value - mean) / std;
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

  const getATRBundle = (sourceBars, i) => ({
    atr_5: getATR(sourceBars, i, 5),
    atr_14: getATR(sourceBars, i, 14),
    atr_30: getATR(sourceBars, i, 30)
  });

  const getVolatilityRegime = (currentAtr, atrHistory) => {
    const pct = percentileRank(currentAtr, atrHistory);
    if (!isNum(pct)) return "normal";
    if (pct >= 0.75) return "high_vol";
    if (pct <= 0.25) return "low_vol";
    return "normal";
  };

  const getWorkingATR = (atrBundle, regime) => {
    if (regime === "high_vol") return atrBundle.atr_5 ?? atrBundle.atr_14 ?? atrBundle.atr_30 ?? null;
    if (regime === "low_vol") return atrBundle.atr_30 ?? atrBundle.atr_14 ?? atrBundle.atr_5 ?? null;
    return atrBundle.atr_14 ?? atrBundle.atr_5 ?? atrBundle.atr_30 ?? null;
  };

  const getDynamicLookback = (regime) => {
    if (regime === "high_vol") return 3;
    if (regime === "low_vol") return 6;
    return config.swingLookbackBase;
  };

  const getDynamicObLookback = (regime) => {
    if (regime === "high_vol") return Math.max(4, config.obLookbackBase - 2);
    if (regime === "low_vol") return config.obLookbackBase + 2;
    return config.obLookbackBase;
  };

  const getLiquidityTolerance = (price, atr) => {
    if (!isNum(price) && !isNum(atr)) return null;
    const atrTol = isNum(atr) ? atr * config.liquidityToleranceAtrFraction : 0;
    const pctTol = isNum(price) ? price * config.liquidityTolerancePriceFraction : 0;
    return Math.max(atrTol, pctTol);
  };

  const getAdaptiveMinFvgAtrFraction = (regime) => {
    if (regime === "high_vol") return config.minFvgAtrFractionBase * 1.2;
    if (regime === "low_vol") return config.minFvgAtrFractionBase * 0.8;
    return config.minFvgAtrFractionBase;
  };

  const getAdaptiveCandidateAtrPad = (regime) => {
    if (regime === "high_vol") return config.candidateAtrPadBase * 1.15;
    if (regime === "low_vol") return config.candidateAtrPadBase * 0.9;
    return config.candidateAtrPadBase;
  };

  const getAdaptiveMinRR = (setupQuality, regime, session) => {
    let minRR = config.minTradeCandidateRrBase;

    if (setupQuality === "strong") minRR -= 0.15;
    if (setupQuality === "weak") minRR += 0.5;

    if (regime === "high_vol") minRR += 0.2;
    if (["after_hours", "overnight", "pre_market"].includes(session)) minRR += 0.5;

    const r = round(minRR, 3);
    return Math.max(1, isNum(r) ? r : minRR);
  };

  const getAdaptiveMaxRiskAtrMultiple = (regime) => {
    if (regime === "high_vol") return config.maxCandidateRiskAtrMultipleBase * 1.25;
    if (regime === "low_vol") return config.maxCandidateRiskAtrMultipleBase * 0.9;
    return config.maxCandidateRiskAtrMultipleBase;
  };

  /** Percentile vs configurable base (no hard-coded decision threshold in call sites). */
  const adaptiveThreshold = (_value, percentile, base = 0.8) => {
    if (!isNum(percentile) || !isNum(base)) return false;
    return percentile >= base;
  };

  const classifyMarketRegime = (feature) => {
    if (feature.bos_bullish || feature.bos_bearish) return "trending";
    if (feature.compression) return "compression";
    if (feature.equal_highs || feature.equal_lows) return "liquidity_range";
    return "choppy";
  };

  const scoreFVG = (fvg, feature) => {
    if (!fvg) return null;
    if (!fvg.is_valid) {
      return { ...fvg, strength: 0, quality: "low" };
    }

    let score = 0;
    if (fvg.formed_with_displacement) score += 2;
    if (feature.momentum === "strong_up" && fvg.type === "bullish") score += 1;
    if (feature.momentum === "strong_down" && fvg.type === "bearish") score += 1;

    return {
      ...fvg,
      strength: score,
      quality: score >= 3 ? "high" : score >= 2 ? "medium" : "low"
    };
  };

  const scoreOrderBlock = (ob, feature) => {
    if (!ob) return null;
    if (!ob.is_valid) {
      return { ...ob, strength: 0, quality: "low" };
    }

    let score = 0;
    if (ob.created_by_displacement) score += 2;
    if (feature.bos === ob.type) score += 1;

    return {
      ...ob,
      strength: score,
      quality: score >= 3 ? "high" : score >= 2 ? "medium" : "low"
    };
  };

  const buildSafeTradeCandidates = (feature, atr) => {
    if (!isNum(atr) || atr <= 0) return null;

    const candidates = [];
    const fvg = feature.fvg;

    if (feature.pd_array?.optimal_long && fvg?.type === "bullish" && fvg.is_valid) {
      candidates.push({
        type: "long_candidate",
        zone: "discount",
        reference: round(fvg.midpoint, 4),
        confidence_hint: fvg.strength,
        fvg_quality: fvg.quality
      });
    }

    if (feature.pd_array?.optimal_short && fvg?.type === "bearish" && fvg.is_valid) {
      candidates.push({
        type: "short_candidate",
        zone: "premium",
        reference: round(fvg.midpoint, 4),
        confidence_hint: fvg.strength,
        fvg_quality: fvg.quality
      });
    }

    return candidates.length ? candidates : null;
  };

  const detectSwingHigh = (sourceBars, i, lookback = 4) => {
    if (i < lookback || i > sourceBars.length - lookback - 1) return false;
    const currentHigh = sourceBars[i].high;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((sourceBars[j].high ?? -Infinity) >= currentHigh) return false;
    }
    return true;
  };

  const detectSwingLow = (sourceBars, i, lookback = 4) => {
    if (i < lookback || i > sourceBars.length - lookback - 1) return false;
    const currentLow = sourceBars[i].low;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((sourceBars[j].low ?? Infinity) <= currentLow) return false;
    }
    return true;
  };

  const detectEqualHighLow = (sourceBars, i, tolerance) => {
    if (i < 3 || !isNum(tolerance)) {
      return { equal_highs: false, equal_lows: false };
    }

    const highs = sourceBars.slice(i - 3, i + 1).map((b) => b.high);
    const lows = sourceBars.slice(i - 3, i + 1).map((b) => b.low);
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];

    const equalHighs = highs.slice(0, -1).every((h) => Math.abs(h - lastHigh) <= tolerance);
    const equalLows = lows.slice(0, -1).every((l) => Math.abs(l - lastLow) <= tolerance);

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

  const detectDisplacement = (sourceBars, i, adaptiveContext) => {
    const bar = sourceBars[i];
    const prevSlice = sourceBars.slice(Math.max(0, i - 10), i);
    const ranges = prevSlice.map(getRange).filter(isNum);
    const currentRange = getRange(bar);
    const currentBodyRatio = getBodyRatio(bar);

    const rangeZ = zScore(currentRange, ranges);
    const rangePct = percentileRank(currentRange, ranges);

    const bodyThreshold =
      adaptiveContext.volatility_regime === "high_vol"
        ? config.displacementBodyRatioThresholdBase * 0.95
        : adaptiveContext.volatility_regime === "low_vol"
          ? config.displacementBodyRatioThresholdBase * 1.05
          : config.displacementBodyRatioThresholdBase;

    const bullish =
      isBullish(bar) &&
      currentBodyRatio >= bodyThreshold &&
      ((isNum(rangeZ) && rangeZ >= config.displacementRangeZScoreThreshold) ||
        (isNum(rangePct) && rangePct >= 0.8));

    const bearish =
      isBearish(bar) &&
      currentBodyRatio >= bodyThreshold &&
      ((isNum(rangeZ) && rangeZ >= config.displacementRangeZScoreThreshold) ||
        (isNum(rangePct) && rangePct >= 0.8));

    return {
      bullish,
      bearish,
      body_ratio: round(currentBodyRatio, 6),
      range_z_score: round(rangeZ, 4),
      range_percentile: round(rangePct, 4)
    };
  };

  const detectRejection = (bar, adaptiveContext) => {
    const bodyTop = Math.max(bar.open ?? 0, bar.close ?? 0);
    const bodyBottom = Math.min(bar.open ?? 0, bar.close ?? 0);
    const upperWick = Math.max(0, (bar.high ?? bodyTop) - bodyTop);
    const lowerWick = Math.max(0, bodyBottom - (bar.low ?? bodyBottom));
    const body = getBody(bar) || 0.0000001;

    const ratio =
      adaptiveContext.volatility_regime === "high_vol"
        ? 1.8
        : adaptiveContext.volatility_regime === "low_vol"
          ? 1.3
          : 1.5;

    return {
      bullish: lowerWick > body * ratio && upperWick < body,
      bearish: upperWick > body * ratio && lowerWick < body,
      upper_wick: round(upperWick, 4),
      lower_wick: round(lowerWick, 4)
    };
  };

  const detectCompression = (sourceBars, i, adaptiveContext) => {
    if (i < config.rangeCompressionLookback) return false;

    const recent = sourceBars.slice(i - 3, i + 1);
    const recentAvg = avg(recent.map(getRange)) ?? 0;

    const older = sourceBars.slice(
      Math.max(0, i - config.rangeCompressionLookback),
      Math.max(0, i - 4)
    );
    const olderAvg = avg(older.map(getRange)) ?? 0;

    if (!olderAvg) return false;

    const threshold =
      adaptiveContext.volatility_regime === "high_vol"
        ? 0.75
        : adaptiveContext.volatility_regime === "low_vol"
          ? 0.65
          : 0.7;

    return recentAvg < olderAvg * threshold;
  };

  const detectMomentum = (sourceBars, i, adaptiveContext) => {
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

    const strengthRatio =
      adaptiveContext.volatility_regime === "high_vol"
        ? 0.85
        : adaptiveContext.volatility_regime === "low_vol"
          ? 1.0
          : 0.9;

    const strongBull = recent.filter(
      (b) => isBullish(b) && getBody(b) >= avgBody && getRange(b) >= avgRange * strengthRatio
    ).length;

    const strongBear = recent.filter(
      (b) => isBearish(b) && getBody(b) >= avgBody && getRange(b) >= avgRange * strengthRatio
    ).length;

    if (strongBull >= 3 && lastClose > firstClose) return "strong_up";
    if (strongBear >= 3 && lastClose < firstClose) return "strong_down";
    if (bullishCount >= 3 && lastClose > firstClose) return "up";
    if (bearishCount >= 3 && lastClose < firstClose) return "down";
    if (lastClose > firstClose) return "up";
    if (lastClose < firstClose) return "down";
    return "flat";
  };

  const detectFVG = (sourceBars, i, currentPrice, atrValue, adaptiveContext) => {
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

    const minFvgAtrFraction = getAdaptiveMinFvgAtrFraction(adaptiveContext.volatility_regime);

    const minSizeValid = isNum(atrValue)
      ? fvg.size >= atrValue * minFvgAtrFraction
      : true;

    const futureBars = sourceBars.slice(i + 1);

    const isFilled =
      fvg.type === "bullish"
        ? futureBars.some((x) => (x.low ?? Infinity) <= fvg.bottom)
        : futureBars.some((x) => (x.high ?? -Infinity) >= fvg.top);

    const isTouched =
      fvg.type === "bullish"
        ? futureBars.some(
            (x) => (x.low ?? Infinity) <= fvg.top && (x.high ?? -Infinity) >= fvg.bottom
          )
        : futureBars.some(
            (x) => (x.high ?? -Infinity) >= fvg.bottom && (x.low ?? Infinity) <= fvg.top
          );

    const cRange = getRange(c);
    const bRange = getRange(b);
    const rangeZ = zScore(cRange, sourceBars.slice(Math.max(0, i - 10), i).map(getRange));

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
      formed_with_displacement:
        (isNum(rangeZ) && rangeZ >= config.displacementRangeZScoreThreshold) ||
        (bRange > 0 && cRange > bRange * 1.15),
      distance_from_price: isNum(currentPrice) ? round(Math.abs(currentPrice - fvg.midpoint), 4) : null,
      distance_from_price_atr:
        isNum(currentPrice) && isNum(atrValue) && atrValue > 0
          ? round(Math.abs(currentPrice - fvg.midpoint) / atrValue, 4)
          : null,
      age_bars: 0
    };
  };

  const detectOrderBlock = (sourceBars, i, structureBreak, adaptiveContext) => {
    const dynamicObLookback = getDynamicObLookback(adaptiveContext.volatility_regime);

    if (i < 3 || !structureBreak) return null;

    for (let j = i - 1; j >= Math.max(0, i - dynamicObLookback); j--) {
      const c = sourceBars[j];

      if (structureBreak === "bullish" && isBearish(c)) {
        return {
          type: "bullish",
          high: c.high,
          low: c.low,
          midpoint: ((c.high ?? 0) + (c.low ?? 0)) / 2,
          index: j,
          created_by_bos: true,
          created_by_displacement: true
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
          created_by_displacement: true
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
   * Micro structure: where price sits inside the local leg (impulse vs pullback, continuation vs reversal).
   */
  const buildMicroStructure = (feature, sourceBars, i) => {
    const bar = sourceBars[i];
    let last_leg = "flat";
    if (i >= 1 && bar) {
      const c0 = bar.close ?? 0;
      const c1 = sourceBars[i - 1]?.close ?? c0;
      if (c0 > c1) last_leg = "up";
      else if (c0 < c1) last_leg = "down";
    }

    let impulse_strength = "weak";
    if (feature.displacement?.bullish || feature.displacement?.bearish) {
      impulse_strength = "strong";
    } else if (feature.momentum === "strong_up" || feature.momentum === "strong_down") {
      impulse_strength = "strong";
    } else if (feature.momentum === "up" || feature.momentum === "down") {
      impulse_strength = "medium";
    }

    let phase = "extension";
    if (feature.displacement?.bullish || feature.displacement?.bearish) {
      phase = "impulse";
    } else if (feature.compression) {
      phase = "consolidation";
    } else if (
      (feature.bos_bearish && last_leg === "up") ||
      (feature.bos_bullish && last_leg === "down")
    ) {
      phase = "retracement";
    } else if (
      feature.structure_state === "range" ||
      feature.equal_highs ||
      feature.equal_lows
    ) {
      phase = "retracement";
    }

    const last_bos = feature.bos_bullish ? "bullish" : feature.bos_bearish ? "bearish" : "none";
    const last_choch = !!feature.choch;
    const is_compression = !!feature.compression;
    const range_behavior =
      feature.structure_state === "range" ||
      ((!feature.bos_bullish && !feature.bos_bearish) &&
        (feature.equal_highs || feature.equal_lows || is_compression));

    let bias_phase = "unknown";
    if (last_choch) {
      bias_phase = "reversal_candidate";
    } else if (
      (feature.bos_bearish && last_leg === "up") ||
      (feature.bos_bullish && last_leg === "down")
    ) {
      bias_phase = "retracement";
    } else if (
      (feature.bos_bearish && last_leg === "down") ||
      (feature.bos_bullish && last_leg === "up")
    ) {
      bias_phase = "continuation";
    } else if (range_behavior) {
      bias_phase = "retracement";
    }

    let state = "neutral_drifting";
    if (feature.displacement?.bullish) state = "bullish_impulse";
    else if (feature.displacement?.bearish) state = "bearish_impulse";
    else if (feature.bos_bearish && last_leg === "up") state = "bearish_pullback";
    else if (feature.bos_bullish && last_leg === "down") state = "bullish_pullback";
    else if (feature.bos_bullish && last_leg === "up") state = "bullish_continuation";
    else if (feature.bos_bearish && last_leg === "down") state = "bearish_continuation";
    else if (last_choch) state = "structure_shift_choch";
    else if (range_behavior) state = "balanced_range";

    return {
      state,
      phase,
      last_leg,
      impulse_strength,
      last_bos,
      last_choch,
      is_compression,
      range_behavior,
      bias_phase
    };
  };

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
        isNum(feature.last_swing_high) || isNum(feature.last_swing_low) ? "medium" : "low",
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

    if (feature.order_block?.type === "bullish" && feature.order_block?.is_valid) {
      bullish.push("fresh_bullish_ob");
    }
    if (feature.order_block?.type === "bearish" && feature.order_block?.is_valid) {
      bearish.push("fresh_bearish_ob");
    }

    if (feature.volume_spike) bullish.push("volume_activity");

    if (bullish.length && bearish.length) conflicts.push("mixed_signals");
    if (!config.volumeAsPenaltyOnly && feature.feature_reliability?.volume === "low") {
      conflicts.push("low_volume_reliability");
    }

    return {
      bullish_points: bullish,
      bearish_points: bearish,
      conflicts
    };
  };

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
    else direction = "at_target";

    const geometry_note =
      direction === "at_target"
        ? "price_at_reference_liquidity"
        : "direction_is_sign_target_minus_price";

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

  /** When traps classifier returns none but SMC structure exists (FVG + PD zone, etc.). */
  const inferStructuralSetupType = (feature) => {
    if (!feature) return null;
    const z = feature.pd_array?.zone;
    const fvg = feature.fvg;
    const inRange =
      feature.structure_state === "range" ||
      feature.equal_highs ||
      feature.equal_lows ||
      feature.compression;

    if (fvg?.is_valid && fvg.type === "bullish" && (z === "discount" || z === "extreme_discount")) {
      return {
        type: inRange ? "range_fvg_discount" : "trend_bullish_fvg_discount",
        confidence: Math.min(0.62, 0.35 + (fvg.strength ?? 0) * 0.06),
        reasons: ["bullish_fvg", z, inRange ? "range_context" : "structure_context"]
      };
    }
    if (fvg?.is_valid && fvg.type === "bearish" && (z === "premium" || z === "extreme_premium")) {
      return {
        type: inRange ? "range_fvg_premium" : "trend_bearish_fvg_premium",
        confidence: Math.min(0.62, 0.35 + (fvg.strength ?? 0) * 0.06),
        reasons: ["bearish_fvg", z, inRange ? "range_context" : "structure_context"]
      };
    }
    if (
      (z === "discount" || z === "extreme_discount") &&
      (feature.sweep_low || feature.rejection?.bullish)
    ) {
      return {
        type: "potential_reversal_discount",
        confidence: 0.36,
        reasons: ["discount", feature.sweep_low ? "sweep_low" : "bullish_rejection"]
      };
    }
    if (
      (z === "premium" || z === "extreme_premium") &&
      (feature.sweep_high || feature.rejection?.bearish)
    ) {
      return {
        type: "potential_reversal_premium",
        confidence: 0.36,
        reasons: ["premium", feature.sweep_high ? "sweep_high" : "bearish_rejection"]
      };
    }
    return null;
  };

  const buildSetupAnalysis = (feature) => {
    const missing = [];

    const hasStructureEvent =
      feature.bos_bullish || feature.bos_bearish || feature.sweep_low || feature.sweep_high;

    if (!hasStructureEvent) missing.push("no_structure_event");
    if (!config.volumeAsPenaltyOnly && !feature.volume_spike) {
      missing.push("no_volume_confirmation");
    } else if (config.volumeAsPenaltyOnly && !feature.volume_spike) {
      missing.push("volume_penalty_soft_no_spike");
    }
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
    if (feature.displacement?.bullish || feature.displacement?.bearish) {
      confirmationSignals.push("displacement");
    }
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

  const buildTradeCandidates = (feature, adaptiveContext) => {
    const candidates = {
      long: null,
      short: null
    };

    const atr = adaptiveContext.working_atr;
    const pad = isNum(atr) && isNum(adaptiveContext.candidate_atr_pad)
      ? atr * adaptiveContext.candidate_atr_pad
      : null;

    const addCandidate = (side, entryRef, invalidationRef, targetRef, rationale) => {
      if (!isNum(entryRef) || !isNum(invalidationRef) || !isNum(targetRef)) return;

      const risk =
        side === "long" ? entryRef - invalidationRef : invalidationRef - entryRef;

      const reward =
        side === "long" ? targetRef - entryRef : entryRef - targetRef;

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

    const fvgLongOk =
      feature.fvg?.type === "bullish" &&
      feature.fvg.is_valid &&
      (feature.fvg.strength ?? 0) >= config.minStrengthForFvgObEntry;
    const obLongOk =
      feature.order_block?.type === "bullish" &&
      feature.order_block.is_valid &&
      (feature.order_block.strength ?? 0) >= config.minStrengthForFvgObEntry;

    const longEntry = fvgLongOk
      ? feature.fvg.midpoint
      : obLongOk
        ? feature.order_block.midpoint
        : feature.pd_array?.optimal_long && isNum(feature.last_swing_low)
          ? feature.last_swing_low + (atr ?? 0) * 0.25
          : null;

    const longInvalidation = isNum(feature.last_swing_low)
      ? pad != null
        ? feature.last_swing_low - pad
        : feature.last_swing_low
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
        fvgLongOk ? "bullish_fvg_midpoint" : null,
        obLongOk ? "bullish_order_block_midpoint" : null,
        feature.pd_array?.optimal_long ? "pd_discount_context" : null,
        feature.liquidity_target?.direction === "up" ? "upside_liquidity_target" : null
      ].filter(Boolean)
    );

    const fvgShortOk =
      feature.fvg?.type === "bearish" &&
      feature.fvg.is_valid &&
      (feature.fvg.strength ?? 0) >= config.minStrengthForFvgObEntry;
    const obShortOk =
      feature.order_block?.type === "bearish" &&
      feature.order_block.is_valid &&
      (feature.order_block.strength ?? 0) >= config.minStrengthForFvgObEntry;

    const shortEntry = fvgShortOk
      ? feature.fvg.midpoint
      : obShortOk
        ? feature.order_block.midpoint
        : feature.pd_array?.optimal_short && isNum(feature.last_swing_high)
          ? feature.last_swing_high - (atr ?? 0) * 0.25
          : null;

    const shortInvalidation = isNum(feature.last_swing_high)
      ? pad != null
        ? feature.last_swing_high + pad
        : feature.last_swing_high
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
        fvgShortOk ? "bearish_fvg_midpoint" : null,
        obShortOk ? "bearish_order_block_midpoint" : null,
        feature.pd_array?.optimal_short ? "pd_premium_context" : null,
        feature.liquidity_target?.direction === "down" ? "downside_liquidity_target" : null
      ].filter(Boolean)
    );

    const minRr = adaptiveContext.min_rr_required;
    const maxRiskAtr =
      isNum(atr) && atr > 0 && isNum(adaptiveContext.max_candidate_risk_atr_multiple)
        ? atr * adaptiveContext.max_candidate_risk_atr_multiple
        : null;

    const filterCandidate = (c) => {
      if (!c) return null;
      if (isNum(c.rr_estimate) && c.rr_estimate < minRr) return null;
      if (maxRiskAtr != null && isNum(c.risk_distance) && c.risk_distance > maxRiskAtr) {
        return null;
      }
      return c;
    };

    candidates.long = filterCandidate(candidates.long);
    candidates.short = filterCandidate(candidates.short);

    return candidates;
  };

  const buildNoTradeContext = (feature) => {
    const reasons = [];

    if (feature.setup?.type === "none") reasons.push("no_clear_setup");
    if (!config.volumeAsPenaltyOnly && !feature.volume_spike) {
      reasons.push("no_volume_confirmation");
    }
    if (feature.confluence?.conflicts?.includes("mixed_signals")) reasons.push("mixed_signals");
    if (["after_hours", "overnight", "pre_market"].includes(feature.session)) {
      reasons.push("weak_session");
    }
    if (!config.volumeAsPenaltyOnly && feature.feature_reliability?.volume === "low") {
      reasons.push("low_volume_reliability");
    }

    const volPctThresh = feature.adaptive_context?.volume_spike_percentile_threshold ?? 0.9;
    const volZThresh = feature.adaptive_context?.volume_spike_z_score_threshold ?? 1.5;

    const what_to_wait_for = {
      short: [
        "price_rejects_bearish_fvg_or_ob",
        "mtf_alignment_bearish",
        `volume_percentile >= ${volPctThresh} or volume_z >= ${volZThresh}`,
        "bearish_displacement_or_sweep_high",
        "engine_conflict_alert_cleared"
      ],
      long: [
        "sweep_low_then_reclaim_structure",
        "bullish_choch_or_bos",
        "reclaim_vwap_with_volume",
        "valid_bullish_fvg_retest",
        "engine_conflict_alert_cleared"
      ]
    };

    return {
      reasons,
      what_to_wait_for,
      volume_policy: config.volumeAsPenaltyOnly ? "penalty_not_hard_block" : "strict",
      confidence_penalty: config.volumeAsPenaltyOnly && !feature.volume_spike
    };
  };

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

    const atrBundle = getATRBundle(bars, i);
    const atrHistory = [];
    for (let j = Math.max(1, i - 50); j < i; j++) {
      const x = getATR(bars, j, config.atrLength);
      if (isNum(x)) atrHistory.push(x);
    }

    const volatilityRegime = getVolatilityRegime(atrBundle.atr_14, atrHistory);
    const workingATR = getWorkingATR(atrBundle, volatilityRegime);
    const dynamicLookback = getDynamicLookback(volatilityRegime);
    const liquidityTolerance = getLiquidityTolerance(bar.close, workingATR);

    const volumeSlice = bars.slice(Math.max(0, i - config.percentileWindow + 1), i + 1);
    const volumeValues = volumeSlice.map((b) => b.volume ?? 0);
    const volumePct = percentileRank(bar.volume ?? 0, volumeValues);
    const volumeZ = zScore(bar.volume ?? 0, volumeValues);

    const adaptiveContext = {
      volatility_regime: volatilityRegime,
      atr_bundle: {
        atr_5: round(atrBundle.atr_5, 4),
        atr_14: round(atrBundle.atr_14, 4),
        atr_30: round(atrBundle.atr_30, 4)
      },
      working_atr: round(workingATR, 4),
      dynamic_lookback: dynamicLookback,
      dynamic_ob_lookback: getDynamicObLookback(volatilityRegime),
      liquidity_tolerance: round(liquidityTolerance, 4),
      volume_percentile: round(volumePct, 4),
      volume_z_score: round(volumeZ, 4),
      volume_spike_percentile_threshold: config.volumeSpikePercentileThreshold,
      volume_spike_z_score_threshold: config.volumeSpikeZScoreThreshold,
      min_fvg_atr_fraction: round(getAdaptiveMinFvgAtrFraction(volatilityRegime), 4),
      candidate_atr_pad: round(getAdaptiveCandidateAtrPad(volatilityRegime), 4),
      min_rr_required: round(getAdaptiveMinRR("moderate", volatilityRegime, session), 4),
      max_candidate_risk_atr_multiple: round(getAdaptiveMaxRiskAtrMultiple(volatilityRegime), 4)
    };

    const volSlice = bars.slice(Math.max(0, i - config.volumeLookback + 1), i + 1);
    const avgVol = avg(volSlice.map((b) => b.volume ?? 0)) ?? 0;
    const volumeRelative = avgVol > 0 ? (bar.volume ?? 0) / avgVol : null;

    const vwap = getVWAP(bars.slice(0, i + 1));
    const aboveVWAP = vwap == null ? null : bar.close > vwap;
    const distanceToVWAP = vwap == null ? null : bar.close - vwap;

    const swingHigh = detectSwingHigh(bars, i, dynamicLookback);
    const swingLow = detectSwingLow(bars, i, dynamicLookback);

    if (swingHigh) lastSwingHigh = bar.high;
    if (swingLow) lastSwingLow = bar.low;

    const eq = detectEqualHighLow(bars, i, liquidityTolerance);

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

    const displacement = detectDisplacement(bars, i, adaptiveContext);
    const rejection = detectRejection(bar, adaptiveContext);
    const compression = detectCompression(bars, i, adaptiveContext);
    const momentum = detectMomentum(bars, i, adaptiveContext);

    const pdArray = calculatePDArray(bar.close, lastSwingHigh, lastSwingLow);

    const rawFVG = detectFVG(bars, i, bar.close, workingATR, adaptiveContext);
    if (rawFVG) activeFVG = rawFVG;

    if (activeFVG) {
      activeFVG = {
        ...activeFVG,
        age_bars: i - activeFVG.created_at_index,
        distance_from_price: round(Math.abs(bar.close - activeFVG.midpoint), 4),
        distance_from_price_atr:
          isNum(workingATR) && workingATR > 0
            ? round(Math.abs(bar.close - activeFVG.midpoint) / workingATR, 4)
            : null
      };
    }

    const rawOB = detectOrderBlock(bars, i, bos, adaptiveContext);
    if (rawOB) activeOrderBlock = rawOB;

    if (activeOrderBlock) {
      const touched = bars
        .slice(activeOrderBlock.index + 1, i + 1)
        .some((x) => (x.low ?? Infinity) <= activeOrderBlock.high && (x.high ?? -Infinity) >= activeOrderBlock.low);

      activeOrderBlock = {
        ...activeOrderBlock,
        high: round(activeOrderBlock.high, 4),
        low: round(activeOrderBlock.low, 4),
        midpoint: round(activeOrderBlock.midpoint, 4),
        fresh: !touched,
        mitigated: touched,
        is_valid: !touched,
        distance_from_price: round(Math.abs(bar.close - activeOrderBlock.midpoint), 4),
        distance_from_price_atr:
          isNum(workingATR) && workingATR > 0
            ? round(Math.abs(bar.close - activeOrderBlock.midpoint) / workingATR, 4)
            : null,
        age_bars: i - activeOrderBlock.index
      };
    }

    const volumeSpike =
      adaptiveThreshold(bar.volume, volumePct, config.volumeSpikePercentileThreshold) ||
      (isNum(volumeZ) && volumeZ >= config.volumeSpikeZScoreThreshold);

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

      adaptive_context: adaptiveContext,

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

      volume_spike: volumeSpike,
      volume_relative: round(volumeRelative, 4),
      volume_percentile: round(volumePct, 4),
      volume_z_score: round(volumeZ, 4),

      vwap: round(vwap, 4),
      above_vwap: aboveVWAP,
      distance_to_vwap: round(distanceToVWAP, 4),
      distance_to_vwap_atr:
        isNum(distanceToVWAP) && isNum(workingATR) && workingATR > 0
          ? round(Math.abs(distanceToVWAP) / workingATR, 4)
          : null,

      atr: round(workingATR, 4),
      atr_bundle: adaptiveContext.atr_bundle,
      trend_strength:
        i >= 5 ? round((bar.close - bars[i - 5].close) / (bars[i - 5].close || 1), 6) : null,
      momentum,

      pd_array: pdArray,
      fvg: activeFVG,
      order_block: activeOrderBlock,

      displacement,
      rejection,
      compression
    };

    feature.liquidity_target = buildLiquidityTarget(feature);
    feature.feature_reliability = buildFeatureReliability(feature, avgVol, volumePct, bar.volume);

    feature.market_regime = classifyMarketRegime(feature);
    feature.fvg = scoreFVG(feature.fvg, feature);
    feature.order_block = scoreOrderBlock(feature.order_block, feature);

    feature.structure_state = inferStructureState(feature);
    feature.micro_structure = buildMicroStructure(feature, bars, i);

    feature.setup = classifySetup(feature, prevFeature);
    if (feature.setup.type === "none") {
      const inferred = inferStructuralSetupType(feature);
      if (inferred) {
        feature.setup = { ...inferred, source: "engine_structural_infer" };
      }
    } else {
      const inferred = inferStructuralSetupType(feature);
      if (inferred) {
        feature.setup = { ...feature.setup, structural_overlay: inferred };
      }
    }

    feature.setup_analysis = buildSetupAnalysis(feature);

    feature.adaptive_context.min_rr_required = round(
      getAdaptiveMinRR(feature.setup_analysis.setup_quality, volatilityRegime, session),
      4
    );

    feature.intent = inferIntent(feature);
    feature.market_context = inferMarketContext(feature);
    feature.breakout_strength = buildBreakoutStrength(feature);
    feature.trigger_context = buildTriggerContext(feature);

    feature.confluence = buildConfluence(feature);
    feature.conflict_alert = buildConflictAlert(feature);
    feature.state_transition = buildStateTransition(prevFeature, feature);

    feature.trade_candidates = buildTradeCandidates(feature, feature.adaptive_context);
    feature.no_trade_context = buildNoTradeContext(feature);

    const atrForSafe = feature.atr;
    feature.safe_trade_candidates = buildSafeTradeCandidates(feature, atrForSafe);

    const compactTailStart = Math.max(0, i - config.recentTailSize + 1);
    feature.recent_tail = results
      .slice(compactTailStart, i)
      .map((x) => ({
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
      .concat([
        {
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
        }
      ]);

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

module.exports = { featureEngineV4 };
