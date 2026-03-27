const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance();

function computePeriod(interval) {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);

  if (interval === "1d") {
    from.setMonth(from.getMonth() - 6);
  } else if (interval === "1h") {
    from.setDate(from.getDate() - 30);
  } else {
    from.setDate(from.getDate() - 10);
  }

  return { period1: from, period2: to };
}

function normalizeVolume(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapQuotes(quotes) {
  return (quotes || []).map((q) => {
    const vol = normalizeVolume(q.volume);
    return {
      timestamp: q.date,
      datetime: new Date(q.date).toISOString(),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: vol
    };
  });
}

/**
 * Fill null volumes on primary rows when the same timestamp exists on secondary
 * (Yahoo often omits volume on one of includePrePost modes but not the other).
 */
function mergeIntradayVolumes(primary, secondary) {
  if (!primary?.length || !secondary?.length) return primary;
  const byTime = new Map();
  for (const row of secondary) {
    const t = new Date(row.timestamp).getTime();
    if (Number.isFinite(t)) byTime.set(t, row.volume);
  }
  return primary.map((row) => {
    if (row.volume != null) return row;
    const t = new Date(row.timestamp).getTime();
    const v = byTime.get(t);
    if (v != null && Number.isFinite(v)) {
      return { ...row, volume: v };
    }
    return row;
  });
}

function nullVolumeRatio(rows) {
  if (!rows.length) return 1;
  let nulls = 0;
  for (const r of rows) {
    if (r.volume == null) nulls++;
  }
  return nulls / rows.length;
}

async function fetchChartMapped({ ticker, interval, period1, period2, includePrePost }) {
  const result = await yahooFinance.chart(ticker, {
    interval,
    period1,
    period2,
    includePrePost
  });
  return mapQuotes(result?.quotes || []);
}

async function getYahooData({ ticker = "QQQ", interval = "5m" } = {}) {
  const { period1, period2 } = computePeriod(interval);

  const chartOptionsBase = {
    interval,
    period1,
    period2
  };

  let rows;
  if (interval === "1d") {
    rows = await fetchChartMapped({
      ticker,
      ...chartOptionsBase,
      includePrePost: false
    });
  } else {
    // Primary: regular session only (often cleaner OHLC).
    const primary = await fetchChartMapped({
      ticker,
      ...chartOptionsBase,
      includePrePost: false
    });
    const ratio = nullVolumeRatio(primary);
    // If Yahoo stripped volume on most bars, merge from pre+post series for matching timestamps.
    if (ratio > 0.35) {
      const alt = await fetchChartMapped({
        ticker,
        ...chartOptionsBase,
        includePrePost: true
      });
      rows = mergeIntradayVolumes(primary, alt);
    } else {
      rows = primary;
    }
  }

  return rows;
}

async function getMultiTimeframeYahoo(ticker = "QQQ") {
  const [daily, hourly, min5] = await Promise.all([
    getYahooData({ ticker, interval: "1d" }),
    getYahooData({ ticker, interval: "1h" }),
    getYahooData({ ticker, interval: "5m" })
  ]);

  return { ticker, daily, hourly, min5 };
}

module.exports = {
  getYahooData,
  getMultiTimeframeYahoo
};
