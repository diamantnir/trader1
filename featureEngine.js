function featureEngineAdvanced({
  bars,
  htfBars4h = [],
  htfBars1d = [],
  optionsData = [],
  market = "US",
  intervalMinutes = 5
}) {
  const results = [];

  const swingLookback = 3;
  const volumeLookback = 10;
  const equalTolerancePct = 0.0015; // 0.15%
  const obBodyRatioThreshold = 0.4;
  const impulseMultiplier = 1.5;
  const volumeSpikeMultiplier = 2;

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const max = (arr) => arr.length ? Math.max(...arr) : null;
  const min = (arr) => arr.length ? Math.min(...arr) : null;

  const getBodySize = (bar) => Math.abs(bar.close - bar.open);
  const getRange = (bar) => Math.max(0, bar.high - bar.low);
  const getBodyRatio = (bar) => {
    const range = getRange(bar);
    if (!range) return 0;
    return getBodySize(bar) / range;
  };
  const isBullish = (bar) => bar.close > bar.open;
  const isBearish = (bar) => bar.close < bar.open;

  const parseDate = (bar) => {
    // bar.time / bar.date / timestamp supported
    const raw = bar.time ?? bar.date ?? bar.timestamp;
    return raw instanceof Date ? raw : new Date(raw);
  };

  const percentDiff = (a, b) => {
    if (!a || !b) return Infinity;
    return Math.abs(a - b) / ((a + b) / 2);
  };

  function detectSession(barDate) {
    // מניח UTC בניו יורק/לונדון לפי שעה מקורית שכבר הבאת.
    // אם אתה מביא הכל כ-UTC זה יעבוד טוב יותר.
    const hour = barDate.getUTCHours();
    const minute = barDate.getUTCMinutes();
    const totalMinutes = hour * 60 + minute;

    // approx windows in UTC (DST לא מדויק ב-100%, אבל טוב כבסיס)
    const londonStart = 8 * 60;
    const londonEnd = 16 * 60 + 30;

    const nyStart = 13 * 60 + 30;
    const nyEnd = 20 * 60;

    return {
      london: totalMinutes >= londonStart && totalMinutes <= londonEnd,
      new_york: totalMinutes >= nyStart && totalMinutes <= nyEnd,
      overlap:
        totalMinutes >= nyStart &&
        totalMinutes <= londonEnd
    };
  }

  function findSwings(sourceBars, lookback = 3) {
    const swings = [];

    for (let i = lookback; i < sourceBars.length - lookback; i++) {
      const bar = sourceBars[i];
      const left = sourceBars.slice(i - lookback, i);
      const right = sourceBars.slice(i + 1, i + 1 + lookback);

      const swingHigh =
        left.every(b => b.high < bar.high) &&
        right.every(b => b.high < bar.high);

      const swingLow =
        left.every(b => b.low > bar.low) &&
        right.every(b => b.low > bar.low);

      if (swingHigh) {
        swings.push({
          index: i,
          type: "high",
          price: bar.high,
          time: parseDate(bar).toISOString()
        });
      }

      if (swingLow) {
        swings.push({
          index: i,
          type: "low",
          price: bar.low,
          time: parseDate(bar).toISOString()
        });
      }
    }

    return swings;
  }

  function getTrendFromSwings(sourceBars) {
    const swings = findSwings(sourceBars, 3);
    const highs = swings.filter(s => s.type === "high").slice(-2);
    const lows = swings.filter(s => s.type === "low").slice(-2);

    if (highs.length < 2 || lows.length < 2) {
      return {
        trend: null,
        swings
      };
    }

    const hh = highs[1].price > highs[0].price;
    const hl = lows[1].price > lows[0].price;
    const lh = highs[1].price < highs[0].price;
    const ll = lows[1].price < lows[0].price;

    let trend = null;
    if (hh && hl) trend = "up";
    else if (lh && ll) trend = "down";
    else trend = "range";

    return { trend, swings };
  }

  function detectFVGAdvanced(sourceBars, i) {
    if (i < 2) return null;

    const b0 = sourceBars[i - 2];
    const b1 = sourceBars[i - 1];
    const b2 = sourceBars[i];

    const range1 = b1.high - b1.low;
    const range2 = b2.high - b2.low;

    const avgRange = (range1 + range2) / 2;

    // --- displacement condition
    const isImpulse = range2 > avgRange * 1.5;

    if (!isImpulse) return null;

    // --- bullish FVG
    if (b2.low > b0.high) {
      const size = b2.low - b0.high;

      if (size < avgRange * 0.3) return null; // too small

      const filled = sourceBars.slice(i + 1).some(b => b.low <= b0.high);

      return {
        type: "bullish",
        top: b2.low,
        bottom: b0.high,
        size,
        midpoint: (b2.low + b0.high) / 2,
        filled
      };
    }

    // --- bearish FVG
    if (b2.high < b0.low) {
      const size = b0.low - b2.high;

      if (size < avgRange * 0.3) return null;

      const filled = sourceBars.slice(i + 1).some(b => b.high >= b0.low);

      return {
        type: "bearish",
        top: b0.low,
        bottom: b2.high,
        size,
        midpoint: (b0.low + b2.high) / 2,
        filled
      };
    }

    return null;
  }

  function detectOrderBlockAdvanced(bars, i, lastSwingHigh, lastSwingLow) {
    if (i < 5) return null;
  
    const current = bars[i];
  
    const range = current.high - current.low;
  
    // --- bullish OB (after BOS up)
    if (lastSwingHigh && current.close > lastSwingHigh) {
      for (let j = i - 1; j >= i - 5; j--) {
        const c = bars[j];
  
        const isValid =
          c.close < c.open && // bearish candle
          (c.high - c.low) > range * 0.5;
  
        if (isValid) {
          const mitigated = bars.slice(j + 1, i + 1).some(
            b => b.low <= c.high && b.high >= c.low
          );
  
          return {
            type: "bullish",
            index: j,
            high: c.high,
            low: c.low,
            mitigated
          };
        }
      }
    }
  
    // --- bearish OB
    if (lastSwingLow && current.close < lastSwingLow) {
      for (let j = i - 1; j >= i - 5; j--) {
        const c = bars[j];
  
        const isValid =
          c.close > c.open &&
          (c.high - c.low) > range * 0.5;
  
        if (isValid) {
          const mitigated = bars.slice(j + 1, i + 1).some(
            b => b.low <= c.high && b.high >= c.low
          );
  
          return {
            type: "bearish",
            index: j,
            high: c.high,
            low: c.low,
            mitigated
          };
        }
      }
    }
  
    return null;
  }

  function detectVolumeSpike(sourceBars, i) {
    if (i < volumeLookback) return false;
    const recentVolumes = sourceBars.slice(i - volumeLookback, i).map(b => b.volume || 0);
    const avgVolume = avg(recentVolumes);
    if (!avgVolume) return false;
    return (sourceBars[i].volume || 0) > avgVolume * volumeSpikeMultiplier;
  }

  function detectMomentum(sourceBars, i) {
    if (i < 3) return null;

    const recent = sourceBars.slice(i - 3, i + 1);
    const bodies = recent.map(getBodySize);
    const ranges = recent.map(getRange);
    const avgBody = avg(bodies);
    const avgRange = avg(ranges);

    const strongBullish = recent.filter(
      b => isBullish(b) && getBodySize(b) > avgBody * 1.1 && getRange(b) > avgRange * 0.9
    ).length;

    const strongBearish = recent.filter(
      b => isBearish(b) && getBodySize(b) > avgBody * 1.1 && getRange(b) > avgRange * 0.9
    ).length;

    if (strongBullish >= 3) return "strong_up";
    if (strongBearish >= 3) return "strong_down";

    const firstClose = recent[0].close;
    const lastClose = recent[3].close;

    if (lastClose > firstClose) return "up";
    if (lastClose < firstClose) return "down";
    return "flat";
  }

  function findNearestLiquidity(swings, price) {
    const highs = swings.filter(s => s.type === "high");
    const lows = swings.filter(s => s.type === "low");

    let nearestHigh = null;
    let nearestLow = null;

    for (const h of highs) {
      if (h.price >= price) {
        if (!nearestHigh || h.price < nearestHigh.price) nearestHigh = h;
      }
    }

    for (const l of lows) {
      if (l.price <= price) {
        if (!nearestLow || l.price > nearestLow.price) nearestLow = l;
      }
    }

    return { nearestHigh, nearestLow };
  }

  function detectEqualHighLow(swings) {
    const equalHighs = [];
    const equalLows = [];

    for (let i = 1; i < swings.length; i++) {
      const prev = swings[i - 1];
      const curr = swings[i];

      if (prev.type === "high" && curr.type === "high") {
        if (percentDiff(prev.price, curr.price) <= equalTolerancePct) {
          equalHighs.push([prev, curr]);
        }
      }

      if (prev.type === "low" && curr.type === "low") {
        if (percentDiff(prev.price, curr.price) <= equalTolerancePct) {
          equalLows.push([prev, curr]);
        }
      }
    }

    return { equalHighs, equalLows };
  }

  function getLatestHTFTrend(htfBars) {
    if (!htfBars || htfBars.length < 10) {
      return { trend: null, swings: [] };
    }
    return getTrendFromSwings(htfBars);
  }

  function getOptionsContextForBar(barTime, optionsFeed) {
    if (!optionsFeed || !optionsFeed.length) {
      return {
        bullishFlow: false,
        bearishFlow: false,
        smartMoneyBias: null,
        callPutSkew: null,
        unusualActivity: false
      };
    }

    const t = parseDate({ time: barTime }).getTime();

    const near = optionsFeed.filter(item => {
      const itemTime = new Date(item.time).getTime();
      const diffMinutes = Math.abs(itemTime - t) / 60000;
      return diffMinutes <= 60;
    });

    if (!near.length) {
      return {
        bullishFlow: false,
        bearishFlow: false,
        smartMoneyBias: null,
        callPutSkew: null,
        unusualActivity: false
      };
    }

    const callPremium = near
      .filter(x => x.side === "call")
      .reduce((sum, x) => sum + (x.premium || 0), 0);

    const putPremium = near
      .filter(x => x.side === "put")
      .reduce((sum, x) => sum + (x.premium || 0), 0);

    const unusualActivity = near.some(x => x.unusual === true || x.volumeOiRatio > 2);

    let smartMoneyBias = null;
    if (callPremium > putPremium * 1.5) smartMoneyBias = "bullish";
    else if (putPremium > callPremium * 1.5) smartMoneyBias = "bearish";
    else smartMoneyBias = "mixed";

    return {
      bullishFlow: smartMoneyBias === "bullish",
      bearishFlow: smartMoneyBias === "bearish",
      smartMoneyBias,
      callPutSkew: callPremium - putPremium,
      unusualActivity
    };
  }

  const localSwings = findSwings(bars, swingLookback);
  const { equalHighs, equalLows } = detectEqualHighLow(localSwings);

  const htf4h = getLatestHTFTrend(htfBars4h);
  const htf1d = getLatestHTFTrend(htfBars1d);

  let trend = null;
  let lastSwingHigh = null;
  let lastSwingLow = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barDate = parseDate(bar);

    const feature = {
      index: i,
      time: barDate.toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume ?? null,

      bullish: isBullish(bar),
      bearish: isBearish(bar),

      structure: null,
      trend: null,

      swing_high: false,
      swing_low: false,

      bos_bullish: false,
      bos_bearish: false,
      choch: false,

      sweep_high: false,
      sweep_low: false,

      momentum: null,
      volume_spike: false,

      bullish_fvg: false,
      bearish_fvg: false,
      bullish_fvg_zone: null,
      bearish_fvg_zone: null,

      bullish_order_block: null,
      bearish_order_block: null,

      session_london: false,
      session_new_york: false,
      session_overlap: false,

      htf_4h_trend: htf4h.trend,
      htf_1d_trend: htf1d.trend,
      htf_alignment_bullish: false,
      htf_alignment_bearish: false,

      options_bullish_flow: false,
      options_bearish_flow: false,
      options_unusual: false,
      options_bias: null,

      liquidity_above: null,
      liquidity_below: null,
      equal_high_pool_nearby: false,
      equal_low_pool_nearby: false
    };

    // swing flags
    const swingPoint = localSwings.find(s => s.index === i && s.type === "high");
    if (swingPoint) {
      feature.swing_high = true;
      lastSwingHigh = bar.high;
    }

    const swingLowPoint = localSwings.find(s => s.index === i && s.type === "low");
    if (swingLowPoint) {
      feature.swing_low = true;
      lastSwingLow = bar.low;
    }

    // structure
    if (feature.swing_high) feature.structure = "swing_high";
    if (feature.swing_low) feature.structure = "swing_low";

    // BOS / CHOCH
    if (lastSwingHigh && bar.close > lastSwingHigh) {
      feature.bos_bullish = true;
      if (trend === "down") feature.choch = true;
      trend = "up";
    }

    if (lastSwingLow && bar.close < lastSwingLow) {
      feature.bos_bearish = true;
      if (trend === "up") feature.choch = true;
      trend = "down";
    }

    feature.trend = trend;

    // sweep
    if (lastSwingLow && bar.low < lastSwingLow && bar.close > lastSwingLow) {
      feature.sweep_low = true;
    }

    if (lastSwingHigh && bar.high > lastSwingHigh && bar.close < lastSwingHigh) {
      feature.sweep_high = true;
    }

    // momentum + volume
    feature.momentum = detectMomentum(bars, i);
    feature.volume_spike = detectVolumeSpike(bars, i);

    // FVG
    const fvg = detectFVGAdvanced(bars, i);

    if (fvg) {
      feature.fvg = fvg;
      feature.fvg_valid = !fvg.filled;
    }

    // OB
    const ob = detectOrderBlockAdvanced(bars, i, lastSwingHigh, lastSwingLow);

    if (ob) {
      feature.order_block = ob;
      feature.ob_valid = !ob.mitigated;
    }

    // Session
    const session = detectSession(barDate);
    feature.session_london = session.london;
    feature.session_new_york = session.new_york;
    feature.session_overlap = session.overlap;

    // HTF alignment
    feature.htf_alignment_bullish =
      feature.trend === "up" &&
      htf4h.trend === "up" &&
      htf1d.trend === "up";

    feature.htf_alignment_bearish =
      feature.trend === "down" &&
      htf4h.trend === "down" &&
      htf1d.trend === "down";

    // liquidity context
    const liquidity = findNearestLiquidity(localSwings, bar.close);
    feature.liquidity_above = liquidity.nearestHigh?.price ?? null;
    feature.liquidity_below = liquidity.nearestLow?.price ?? null;

    feature.equal_high_pool_nearby = equalHighs.some(([a, b]) =>
      percentDiff(((a.price + b.price) / 2), bar.close) <= 0.003
    );

    feature.equal_low_pool_nearby = equalLows.some(([a, b]) =>
      percentDiff(((a.price + b.price) / 2), bar.close) <= 0.003
    );

    // options flow
    const options = getOptionsContextForBar(barDate.toISOString(), optionsData);
    feature.options_bullish_flow = options.bullishFlow;
    feature.options_bearish_flow = options.bearishFlow;
    feature.options_unusual = options.unusualActivity;
    feature.options_bias = options.smartMoneyBias;

    results.push(feature);
  }

  return {
    summary: {
      totalBars: bars.length,
      localSwingCount: localSwings.length,
      htf4hTrend: htf4h.trend,
      htf1dTrend: htf1d.trend,
      equalHighPools: equalHighs.length,
      equalLowPools: equalLows.length
    },
    features: results
  };
}

module.exports = { featureEngineAdvanced };