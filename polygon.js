const axios = require("axios");

const POLYGON_API_KEY = "MppLpPzjBcKzeTikIZH4ZkixRCWp62Qx";
const BASE_URL = "https://api.polygon.io";

// All timeframes use YYYY-MM-DD for from/to. If you get fewer bars than limit:
// 1. Plan limitation – free/basic plans may restrict intraday history.
// 2. End date – to= may be non-trading day or incomplete session.
// 3. Market hours – RTH only → fewer 5m bars per day.

function normalizeBars(results = []) {
  return results.map((bar) => ({
    timestamp: bar.t,
    datetime: new Date(bar.t).toISOString(),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    vwap: bar.vw ?? null,
    transactions: bar.n ?? null
  }));
}

async function getAggregates({
  ticker,
  multiplier,
  timespan,
  from,
  to,
  limit = 5000,
  adjusted = true,
  sort = "asc"
}) {
  if (!ticker) throw new Error("ticker is required");
  if (!multiplier) throw new Error("multiplier is required");
  if (!timespan) throw new Error("timespan is required");
  if (!from) throw new Error("from is required");
  if (!to) throw new Error("to is required");

  const url = `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(
    ticker
  )}/range/${multiplier}/${timespan}/${from}/${to}`;

  console.log("[polygon.io] %s %s from=%s to=%s limit=%s", timespan, ticker, from, to, limit);

  const response = await axios.get(url, {
    params: {
      adjusted,
      sort,
      limit,
      apiKey: POLYGON_API_KEY
    },
    timeout: 30000
  });

  if (!response.data) {
    throw new Error("Empty response from Polygon");
  }

  if (response.data.status !== "OK" && response.data.status !== "DELAYED") {
    throw new Error(
      `Polygon returned status ${response.data.status}: ${JSON.stringify(
        response.data
      )}`
    );
  }

  const resultsCount = response.data.resultsCount || 0;
  const barCount = (response.data.results || []).length;
  console.log("[polygon.io] %s %s -> resultsCount=%s bars=%d", timespan, ticker, resultsCount, barCount);

  return {
    ticker,
    query: { multiplier, timespan, from, to, limit, adjusted, sort },
    resultsCount,
    bars: normalizeBars(response.data.results || [])
  };
}

async function getDailyData(ticker, from, to, limit = 60) {
  return getAggregates({
    ticker,
    multiplier: 1,
    timespan: "day",
    from,
    to,
    limit
  });
}

async function getHourlyData(ticker, from, to, limit = 100) {
  return getAggregates({
    ticker,
    multiplier: 1,
    timespan: "hour",
    from,
    to,
    limit
  });
}

async function get5MinData(ticker, from, to, limit = 120) {
  return getAggregates({
    ticker,
    multiplier: 5,
    timespan: "minute",
    from,
    to,
    limit
  });
}

async function getMultiTimeframeData({
  ticker,
  dailyFrom,
  dailyTo,
  hourlyFrom,
  hourlyTo,
  min5From,
  min5To,
  dailyLimit = 60,
  hourlyLimit = 100,
  min5Limit = 120
}) {
  const [daily, hourly, min5] = await Promise.all([
    getDailyData(ticker, dailyFrom, dailyTo, dailyLimit),
    getHourlyData(ticker, hourlyFrom, hourlyTo, hourlyLimit),
    get5MinData(ticker, min5From, min5To, min5Limit)
  ]);

  return {
    ticker,
    daily,
    hourly,
    min5
  };
}

module.exports = {
  getAggregates,
  getDailyData,
  getHourlyData,
  get5MinData,
  getMultiTimeframeData
};