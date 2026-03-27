/** Yahoo (and others) often send null intraday volume; never treat that as 0 without a real zero. */
function parseVolume(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ema(values, period) {
  if (!values || values.length < period) return null;

  const k = 2 / (period + 1);
  let emaValue = values[0];

  for (let i = 1; i < values.length; i++) {
    emaValue = values[i] * k + emaValue * (1 - k);
  }

  return Number(emaValue.toFixed(2));
}

function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  const rsi = 100 - 100 / (1 + rs);
  return Number(rsi.toFixed(2));
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trueRanges.push(tr);
  }

  const recentTR = trueRanges.slice(-period);
  const atr = recentTR.reduce((sum, x) => sum + x, 0) / recentTR.length;

  return Number(atr.toFixed(2));
}

function findPivotLevels(candles) {
  const levels = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];

    const isResistance =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high;

    const isSupport =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low;

    if (isResistance) {
      levels.push({
        type: "resistance",
        price: Number(c.high.toFixed(2))
      });
    }

    if (isSupport) {
      levels.push({
        type: "support",
        price: Number(c.low.toFixed(2))
      });
    }
  }

  return levels;
}

function clusterLevels(levels, tolerancePercent = 0.35) {
  if (!levels.length) return [];

  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const level of sorted) {
    const last = clusters[clusters.length - 1];

    if (!last) {
      clusters.push({
        type: level.type,
        prices: [level.price],
        touches: 1
      });
      continue;
    }

    const avg = last.prices.reduce((s, p) => s + p, 0) / last.prices.length;
    const tolerance = avg * (tolerancePercent / 100);

    if (last.type === level.type && Math.abs(level.price - avg) <= tolerance) {
      last.prices.push(level.price);
      last.touches += 1;
    } else {
      clusters.push({
        type: level.type,
        prices: [level.price],
        touches: 1
      });
    }
  }

  return clusters.map((c) => {
    const avg = c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
    return {
      type: c.type,
      price: Number(avg.toFixed(2)),
      touches: c.touches
    };
  });
}

function getNearestLevels(currentPrice, levels, count = 2) {
  const supports = levels
    .filter((l) => l.type === "support" && l.price <= currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, count);

  const resistances = levels
    .filter((l) => l.type === "resistance" && l.price >= currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, count);

  return { supports, resistances };
}

function detectVolumeTrend(candles, window = 20) {
  if (!candles || candles.length < window + 5) return "unknown";
  const vols = candles
    .slice(-window)
    .map((c) => parseVolume(c.volume))
    .filter((v) => v != null);
  if (vols.length < window * 0.5) return "unknown";
  const half = Math.floor(vols.length / 2);
  const first = vols.slice(0, half);
  const last = vols.slice(half);
  if (!first.length || !last.length) return "unknown";
  const avgFirst = first.reduce((s, v) => s + v, 0) / first.length;
  const avgLast = last.reduce((s, v) => s + v, 0) / last.length;
  if (avgLast > avgFirst * 1.15) return "rising";
  if (avgLast < avgFirst * 0.85) return "declining";
  return "flat";
}

function detectLiquiditySweeps(candles) {
  if (!candles || candles.length < 10) {
    return { sweep_high: false, sweep_low: false };
  }
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const last = candles[candles.length - 1];
  const prevHigh = Math.max(...highs.slice(0, -1));
  const prevLow = Math.min(...lows.slice(0, -1));
  const sweep_high = last.high > prevHigh && last.close < prevHigh;
  const sweep_low = last.low < prevLow && last.close > prevLow;
  return { sweep_high, sweep_low };
}

function classifyLastCandle(candle) {
  if (!candle) {
    return {
      rejection: false,
      engulfing: false,
      indecision: false
    };
  }
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const totalRange = candle.high - candle.low || 1e-9;

  const bodyRatio = body / totalRange;
  const upperRatio = upperWick / totalRange;
  const lowerRatio = lowerWick / totalRange;

  const indecision = bodyRatio < 0.25 && (upperRatio > 0.25 || lowerRatio > 0.25);
  const rejection = upperRatio > 0.4 || lowerRatio > 0.4;

  return {
    rejection,
    engulfing: false, // requires previous candle; keep simple for now
    indecision
  };
}

function analyzeSymbol(symbol, candles) {
  if (!candles || candles.length < 20) {
    throw new Error("Need at least 20 candles");
  }

  // OHLC only — do not drop bars just because volume is null (fixes 1h/5m "current: 0").
  const valid = candles.filter(
    (c) =>
      c.open != null &&
      c.high != null &&
      c.low != null &&
      c.close != null
  );

  if (valid.length < 20) {
    throw new Error("Need at least 20 candles with complete OHLC");
  }

  const closes = valid.map((c) => c.close);
  const last = valid[valid.length - 1];
  const recent20 = valid.slice(-20);

  const vols20 = recent20.map((c) => parseVolume(c.volume)).filter((v) => v != null);
  const avgVolume20 =
    vols20.length > 0 ? vols20.reduce((sum, v) => sum + v, 0) / vols20.length : null;

  let currentVolume = parseVolume(last.volume);
  if (currentVolume == null) {
    for (let i = valid.length - 2; i >= 0; i--) {
      const pv = parseVolume(valid[i].volume);
      if (pv != null) {
        currentVolume = pv;
        break;
      }
    }
  }

  const relativeVolume =
    avgVolume20 != null && avgVolume20 > 0 && currentVolume != null
      ? currentVolume / avgVolume20
      : null;
  const volumeSpike = relativeVolume != null && relativeVolume >= 1.5;

  const rawLevels = findPivotLevels(valid);
  const clusteredLevels = clusterLevels(rawLevels);
  const nearest = getNearestLevels(last.close, clusteredLevels, 2);

  const ema20 = ema(closes.slice(-20), 20);
  const ema50 = ema(closes.slice(-50), 50);
  const ema200 = closes.length >= 200 ? ema(closes.slice(-200), 200) : null;
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(valid, 14);
  const volTrend = detectVolumeTrend(valid, 20);
  const candleSignals = classifyLastCandle(last);

  let trendDirection = "sideways";
  if (ema20 && ema50) {
    if (ema20 > ema50 && last.close > ema20) trendDirection = "bullish";
    else if (ema20 < ema50 && last.close < ema20) trendDirection = "bearish";
  }

  const supports = nearest.supports;
  const resistances = nearest.resistances;

  const nearestSupport = supports[0] || null;
  const nearestResistance = resistances[0] || null;

  const { sweep_high, sweep_low } = detectLiquiditySweeps(valid);

  const nearSupport =
    nearestSupport != null && atr != null
      ? Math.abs(last.close - nearestSupport.price) <= atr * 0.5
      : false;

  const nearResistance =
    nearestResistance != null && atr != null
      ? Math.abs(last.close - nearestResistance.price) <= atr * 0.5
      : false;

  const range =
    nearestSupport != null && nearestResistance != null
      ? (nearestResistance.price - nearestSupport.price) / nearestSupport.price < 0.03
      : false;

  const volatility =
    atr == null
      ? "unknown"
      : atr / last.close > 0.02
      ? "high"
      : atr / last.close > 0.01
      ? "medium"
      : "low";

  return {
    symbol,
    timestamp: last.datetime || last.timestamp || new Date().toISOString(),

    price: {
      current: Number(last.close.toFixed(2)),
      open: Number(last.open.toFixed(2)),
      high: Number(last.high.toFixed(2)),
      low: Number(last.low.toFixed(2))
    },

    trend: {
      direction: trendDirection,
      strength:
        ema20 && ema50
          ? Number((Math.abs(ema20 - ema50) / ema50).toFixed(4))
          : null,
      structure:
        trendDirection === "bullish"
          ? "higher_lows"
          : trendDirection === "bearish"
          ? "lower_highs"
          : "range"
    },

    levels: {
      support: supports,
      resistance: resistances
    },

    volume: {
      current: currentVolume,
      average_20: avgVolume20 != null ? Math.round(avgVolume20) : null,
      spike: volumeSpike,
      relative: relativeVolume != null ? Number(relativeVolume.toFixed(2)) : null,
      last_bar_volume_missing: parseVolume(last.volume) == null
    },

    volume_context: {
      trend: volTrend,
      last_move_supported: volTrend === "rising" && !volumeSpike ? false : volumeSpike,
      data_quality: (() => {
        const missing = valid.some((c) => parseVolume(c.volume) == null);
        const zeros = valid.some((c) => parseVolume(c.volume) === 0);
        if (missing) return "missing_or_null_volume_bars";
        if (zeros) return "mixed_due_to_zero_volume_bars";
        return "good";
      })(),
      zero_volume_bars_present: valid.some((c) => parseVolume(c.volume) === 0),
      null_volume_bars_present: valid.some((c) => parseVolume(c.volume) == null),
      use_volume_for_decision:
        !valid.some((c) => parseVolume(c.volume) == null) &&
        !valid.some((c) => parseVolume(c.volume) === 0)
    },

    location: {
      range_position:
        nearestSupport != null && nearestResistance != null
          ? Number(
              Math.min(
                1,
                Math.max(
                  0,
                  (last.close - nearestSupport.price) /
                    ((nearestResistance.price - nearestSupport.price) || 1e-9)
                )
              ).toFixed(2)
            )
          : null,
      distance_to_support:
        nearestSupport != null
          ? Number(Math.abs(last.close - nearestSupport.price).toFixed(2))
          : null,
      distance_to_resistance:
        nearestResistance != null
          ? Number(Math.abs(nearestResistance.price - last.close).toFixed(2))
          : null
    },

    price_action: {
      bos: false,
      choch: false,
      near_resistance: nearResistance,
      near_support: nearSupport,
      range
    },

    indicators: {
      rsi,
      ema_20: ema20,
      ema_50: ema50,
      ema_200: ema200
    },

    risk: {
      volatility,
      atr
    },

    context: {
      market_session: "regular",
      timeframe: "1D"
    },

    liquidity: {
      equal_highs: clusteredLevels
        .filter((l) => l.type === "resistance" && l.touches >= 2)
        .map((l) => ({ price: l.price, touches: l.touches })),
      equal_lows: clusteredLevels
        .filter((l) => l.type === "support" && l.touches >= 2)
        .map((l) => ({ price: l.price, touches: l.touches })),
      sweep_high,
      sweep_low
    },

    candle_signals: candleSignals,

    trade_context: {
      range_environment: range,
      trend_alignment:
        trendDirection === "bullish"
          ? last.close > (ema20 || last.close)
          : trendDirection === "bearish"
          ? last.close < (ema20 || last.close)
          : false,
      risk_reward_favorable:
        nearestSupport != null && nearestResistance != null
          ? (nearestResistance.price - last.close) >
            1.8 * (last.close - nearestSupport.price)
          : false
    }
  };
}

module.exports = {
  analyzeSymbol
};

