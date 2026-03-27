function calculatePDArrayAdvanced(price, swingHigh, swingLow) {
  if (swingHigh == null || swingLow == null) return null;

  const range = swingHigh - swingLow;
  if (!Number.isFinite(range) || range <= 0) return null;

  const midpoint = swingLow + range / 2;

  const position = (price - swingLow) / range;

  let zone = "equilibrium";

  if (position < 0.45) zone = "discount";
  else if (position > 0.55) zone = "premium";

  return {
    zone, // discount / premium / equilibrium
    position, // ~0–1 (can go outside if price leaves range)
    midpoint,
    distance_to_high: (swingHigh - price) / range,
    distance_to_low: (price - swingLow) / range,
    optimal_long: zone === "discount",
    optimal_short: zone === "premium"
  };
}

function detectMomentumV2(bars, i) {
  if (i < 3) return null;

  const recent = bars.slice(i - 3, i + 1);
  const getBodySize = (b) => Math.abs(b.close - b.open);
  const getRange = (b) => Math.max(0, b.high - b.low);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const bodies = recent.map(getBodySize);
  const ranges = recent.map(getRange);
  const avgBody = avg(bodies);
  const avgRange = avg(ranges);

  const isBullish = (b) => b.close > b.open;
  const isBearish = (b) => b.close < b.open;

  const strongBullish = recent.filter(
    (b) => isBullish(b) && getBodySize(b) > avgBody * 1.1 && getRange(b) > avgRange * 0.9
  ).length;

  const strongBearish = recent.filter(
    (b) => isBearish(b) && getBodySize(b) > avgBody * 1.1 && getRange(b) > avgRange * 0.9
  ).length;

  if (strongBullish >= 3) return "strong_up";
  if (strongBearish >= 3) return "strong_down";

  const firstClose = recent[0].close;
  const lastClose = recent[3].close;

  if (lastClose > firstClose) return "up";
  if (lastClose < firstClose) return "down";
  return "flat";
}

function classifySetupAdvanced(feature, prev) {
  if (!feature || !prev) return { type: "none", confidence: 0, reasons: [] };

  let type = "none";
  let confidence = 0;
  const reasons = [];

  // =========================
  // TRAP
  // =========================
  if (
    prev.bos_bullish &&
    feature.close < prev.close &&
    !feature.volume_spike &&
    feature.momentum !== "strong_up"
  ) {
    type = "bull_trap";
    confidence = 0.7;
    reasons.push("failed_bos", "no_volume", "reversal");
  }

  if (
    prev.bos_bearish &&
    feature.close > prev.close &&
    !feature.volume_spike &&
    feature.momentum !== "strong_down"
  ) {
    type = "bear_trap";
    confidence = 0.7;
    reasons.push("failed_bos", "no_volume", "reversal");
  }

  // =========================
  // SWEEP REVERSAL
  // =========================
  if (
    feature.sweep_low &&
    feature.momentum === "strong_up" &&
    feature.volume_spike
  ) {
    type = "sweep_reversal_bullish";
    confidence = 0.85;
    reasons.push("liquidity_taken", "strong_reversal", "volume");
  }

  if (
    feature.sweep_high &&
    feature.momentum === "strong_down" &&
    feature.volume_spike
  ) {
    type = "sweep_reversal_bearish";
    confidence = 0.85;
    reasons.push("liquidity_taken", "strong_reversal", "volume");
  }

  // =========================
  // CONTINUATION
  // =========================
  if (
    feature.bos_bullish &&
    feature.momentum === "strong_up" &&
    feature.volume_spike &&
    feature.pd_array?.zone === "discount"
  ) {
    type = "continuation_bullish";
    confidence = 0.75;
    reasons.push("bos", "momentum", "volume", "discount_zone");
  }

  if (
    feature.bos_bearish &&
    feature.momentum === "strong_down" &&
    feature.volume_spike &&
    feature.pd_array?.zone === "premium"
  ) {
    type = "continuation_bearish";
    confidence = 0.75;
    reasons.push("bos", "momentum", "volume", "premium_zone");
  }

  return {
    type,
    confidence,
    reasons
  };
}

function featureEngineV2(bars) {
  const results = [];

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const getVWAP = (slice) => {
    let totalPV = 0;
    let totalVol = 0;

    slice.forEach((b) => {
      const typical = (b.high + b.low + b.close) / 3;
      totalPV += typical * b.volume;
      totalVol += b.volume;
    });

    return totalVol === 0 ? null : totalPV / totalVol;
  };

  const detectSwingHigh = (bars, i) => {
    if (i < 2 || i > bars.length - 3) return false;
    return (
      bars[i].high > bars[i - 1].high &&
      bars[i].high > bars[i - 2].high &&
      bars[i].high > bars[i + 1].high &&
      bars[i].high > bars[i + 2].high
    );
  };

  const detectSwingLow = (bars, i) => {
    if (i < 2 || i > bars.length - 3) return false;
    return (
      bars[i].low < bars[i - 1].low &&
      bars[i].low < bars[i - 2].low &&
      bars[i].low < bars[i + 1].low &&
      bars[i].low < bars[i + 2].low
    );
  };

  let lastSwingHighPrice = null;
  let lastSwingLowPrice = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    const slice = bars.slice(Math.max(0, i - 20), i + 1);

    const volumes = slice.map((b) => b.volume);
    const avgVol = avg(volumes);

    const vwap = getVWAP(slice);

    const swingHigh = detectSwingHigh(bars, i);
    const swingLow = detectSwingLow(bars, i);

    const prevSwingHigh = lastSwingHighPrice;
    const prevSwingLow = lastSwingLowPrice;

    const feature = {
      index: i,
      price: bar.close,
      close: bar.close,

      // --- Structure
      swing_high: swingHigh,
      swing_low: swingLow,

      sweep_low: false,
      sweep_high: false,

      // --- CHOCH / BOS
      choch: false,
      bos: false,
      bos_bullish: false,
      bos_bearish: false,

      // --- Liquidity zones
      equal_highs: false,
      equal_lows: false,

      // --- Volume
      volume_spike: bar.volume > avgVol * 1.5,

      // --- VWAP
      above_vwap: vwap ? bar.close > vwap : null,

      // --- Trend strength
      trend_strength: null,

      momentum: null,

      pd_array: null,
      setup: null
    };

    // --- Equal highs/lows (liquidity pools)
    if (i >= 3) {
      const prevHighs = bars.slice(i - 3, i).map((b) => b.high);
      const prevLows = bars.slice(i - 3, i).map((b) => b.low);

      const tolerance = 0.1;

      feature.equal_highs = prevHighs.every((h) => Math.abs(h - bar.high) < tolerance);
      feature.equal_lows = prevLows.every((l) => Math.abs(l - bar.low) < tolerance);
    }

    // --- BOS
    if (i >= 5) {
      const highs = bars.slice(i - 5, i).map((b) => b.high);
      const lows = bars.slice(i - 5, i).map((b) => b.low);

      const maxHigh = Math.max(...highs);
      const minLow = Math.min(...lows);

      if (bar.close > maxHigh) {
        feature.bos = "bullish";
      }

      if (bar.close < minLow) {
        feature.bos = "bearish";
      }
    }

    feature.bos_bullish = feature.bos === "bullish";
    feature.bos_bearish = feature.bos === "bearish";

    // --- Trend strength
    if (i >= 5) {
      const closes = bars.slice(i - 5, i).map((b) => b.close);

      const change = closes[closes.length - 1] - closes[0];
      feature.trend_strength = change / closes[0];
    }

    feature.momentum = detectMomentumV2(bars, i);

    // --- Liquidity sweep vs last confirmed swing levels
    if (prevSwingLow != null && bar.low < prevSwingLow && bar.close > prevSwingLow) {
      feature.sweep_low = true;
    }
    if (prevSwingHigh != null && bar.high > prevSwingHigh && bar.close < prevSwingHigh) {
      feature.sweep_high = true;
    }

    if (swingHigh) lastSwingHighPrice = bar.high;
    if (swingLow) lastSwingLowPrice = bar.low;

    feature.pd_array = calculatePDArrayAdvanced(bar.close, lastSwingHighPrice, lastSwingLowPrice);

    const prevFeature = results.length ? results[results.length - 1] : null;
    feature.setup = classifySetupAdvanced(feature, prevFeature);

    results.push(feature);
  }

  return results;
}

module.exports = {
  featureEngineV2,
  calculatePDArrayAdvanced,
  classifySetupAdvanced
};
