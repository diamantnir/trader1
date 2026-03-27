const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { captureTradingViewChart } = require("./capture-tradingview");
const { getMultiTimeframeData } = require("./polygon");
const { getMultiTimeframeYahoo } = require("./yahoo");
const { analyzeSymbol } = require("./analysis");
const {
  askChatGPT,
  askGemini,
  askTradingPipelineStep,
  normalizeTradingDecision
} = require("./llm");
const {
  evaluatePreFilter,
  buildFiveStepRequestBodies,
  runFiveStepPipeline
} = require("./decisionPipeline");
const { featureEngineV5 } = require("./featureEngineV5");
const { mapFeatureToLLM, setupPriority } = require("./smartMoneyMapper");
const { buildExecutionState, buildSetupAlignment } = require("./executionEngine");
const { buildTriggers } = require("./triggerEngine");
const { buildPayload } = require("./decisionPayloadBuilder");
const { buildLiquidityMap } = require("./liquidityMapBuilder");
const { buildDecisionScore } = require("./decisionScoreBuilder");

/** Overrides for featureEngineV5 (core: featureEngineV4.js `config`). */
const FEATURE_ENGINE_V5_OPTIONS = {
  recentTailSize: 8,
  featuresRecentCount: 15,
  minTradeCandidateRrBase: 1.2,
  maxCandidateRiskAtrMultipleBase: 3
};

/**
 * Per-timeframe outputs from featureEngineV5 (full bars for /analysis).
 * `engineOpts.volumeAsPenaltyOnly` — set from hard_constraints.ignore_volume when building decision context.
 */
function buildFeatureEnginePayload(dailyCandles, hourlyCandles, min5Candles, engineOpts = {}) {
  const feOpts = {
    ...FEATURE_ENGINE_V5_OPTIONS,
    volumeAsPenaltyOnly: !!engineOpts.volumeAsPenaltyOnly
  };
  function summarizeV5(bars) {
    const out = featureEngineV5(bars || [], feOpts);
    return {
      bar_count: out.bar_count,
      last_bar: out.last_bar,
      features_recent: out.features_recent ?? [],
      engine_config: out.config_used ?? null
    };
  }

  return {
    feature_engine_v5: {
      daily: summarizeV5(dailyCandles),
      "1h": summarizeV5(hourlyCandles),
      "5m": summarizeV5(min5Candles)
    }
  };
}

const CHROME_PATHS_WIN = [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
];
const DEBUG_PORT = 9222;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// API status (for scripts)
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    message: "TradingView capture server is running"
  });
});

// Launch Chrome with remote debugging so "Use my Chrome" can connect
app.post("/launch-chrome", (req, res) => {
  let chromePath = null;
  if (process.platform === "win32") {
    chromePath = CHROME_PATHS_WIN.find(p => fs.existsSync(p));
  }
  if (!chromePath) {
    return res.status(500).json({
      success: false,
      error: "Chrome not found. Install Chrome or start it manually with --remote-debugging-port=9222"
    });
  }
  try {
    spawn(chromePath, [`--remote-debugging-port=${DEBUG_PORT}`], {
      detached: true,
      stdio: "ignore"
    }).unref();
    return res.json({
      success: true,
      message: "Chrome launched. Wait 5–10 seconds, then check 'Use my open Chrome' and click Capture."
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || String(err)
    });
  }
});

// Simple page to trigger capture from the browser
app.get("/", (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TradingView Capture</title>
  <style>
    body { font-family: system-ui; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; }
    h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; color: #333; }
    button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; background: #2962ff; color: #fff; border: none; border-radius: 6px; }
    button:hover { background: #1e53e5; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .result { margin-top: 1rem; padding: 0.75rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
    .success { background: #e8f5e9; color: #2e7d32; }
    .error { background: #ffebee; color: #c62828; }
    a { color: #2962ff; }
    .polygon-section { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #ddd; }
    .polygon-section input { padding: 0.4rem 0.5rem; font-size: 1rem; width: 8rem; margin-right: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem; }
    th, td { text-align: right; padding: 0.35rem 0.5rem; border-bottom: 1px solid #eee; }
    th { text-align: left; background: #f5f5f5; }
    td:first-child { text-align: left; }
    #polygonOut { margin-top: 0.75rem; }
  </style>
</head>
<body>
  <h1>TradingView capture</h1>
  <p>Click to open TradingView and save a screenshot to the <code>screenshots</code> folder.</p>
  <p style="margin: 0.5rem 0;">
    <label><input type="checkbox" id="useMyChrome"> Use my open Chrome</label>
    <small style="display:block; color:#666; margin-top:0.25rem;">Close Chrome first, then click: </small>
    <button type="button" id="launchChrome" style="margin-top:0.35rem; background:#0d7d4a;">Launch Chrome for remote debugging</button>
  </p>
  <button id="btn">Capture screenshot</button>
  <div id="out"></div>

  <div class="polygon-section">
    <h2>Polygon & Yahoo data (5m, hourly, daily)</h2>
    <p>
      <input type="text" id="polygonTicker" placeholder="e.g. QQQ" value="QQQ" />
      <input type="date" id="polygonTo" value="2025-03-13" title="Use a date when Polygon has intraday data (e.g. 2025-03-13). Future dates return few bars." />
      <button type="button" id="btnPolygon">Fetch Polygon data</button>
    </p>
    <div id="polygonOut"></div>
    <p style="margin-top:0.75rem;">
      <button type="button" id="btnYahoo" style="background:#ff9800;">Fetch Yahoo Finance data</button>
      <span id="yahooSummary" style="margin-left:0.5rem; font-size:0.9rem; color:#555;"></span>
    </p>
    <p style="margin-top:0.5rem;">
      <button type="button" id="btnContext" style="background:#673ab7;">Build LLM JSON (charts + OHLCV)</button>
    </p>
    <p style="margin-top:0.5rem;">
      <button type="button" id="btnDecision" style="background:#009688;">Pipeline: 6 steps + pre-filter (preview)</button>
      <button type="button" id="btnPayloadOnly" style="background:#00695c;">Classic single LLM payload only</button>
    </p>
  </div>

  <script>
    document.getElementById("launchChrome").onclick = async function () {
      var out = document.getElementById("out");
      out.textContent = "Launching Chrome…";
      out.className = "result";
      try {
        var r = await fetch("/launch-chrome", { method: "POST" });
        var data = await r.json();
        if (data.success) {
          out.className = "result success";
          out.textContent = data.message;
        } else {
          out.className = "result error";
          out.textContent = data.error || "Failed";
        }
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };
    document.getElementById("btn").onclick = async function () {
      var btn = this, out = document.getElementById("out");
      btn.disabled = true;
      out.textContent = document.getElementById("useMyChrome").checked ? "Using your Chrome…" : "Opening Chrome and capturing…";
      out.className = "result";
      try {
        var r = await fetch("/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headless: false,
            useExistingChrome: document.getElementById("useMyChrome").checked
          })
        });
        var data = await r.json();
        if (data.success) {
          out.className = "result success";
          out.innerHTML = "Saved: " + data.fileName + "\\nPath: " + data.path + "\\n<a href=\\"/file?name=" + encodeURIComponent(data.fileName) + "\\\" target=_blank>Open image</a>";
        } else {
          out.className = "result error";
          out.textContent = "Error: " + (data.error || "Unknown");
        }
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
    };

    function formatBarTable(bars, title) {
      if (!bars || bars.length === 0) return "<p>No bars</p>";
      var last = bars.slice(-15).reverse();
      var rows = last.map(function(b) {
        var vol = b.volume;
        var volStr = vol != null && vol !== "" ? String(vol) : "—";
        return "<tr><td>" + (b.datetime || new Date(b.timestamp).toISOString()).slice(0, 19) + "</td><td>" + b.open + "</td><td>" + b.high + "</td><td>" + b.low + "</td><td>" + b.close + "</td><td>" + volStr + "</td></tr>";
      }).join("");
      return "<h3>" + title + " (" + bars.length + " bars, last 15)</h3><table><thead><tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Vol</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    document.getElementById("btnPolygon").onclick = async function () {
      var ticker = (document.getElementById("polygonTicker").value || "QQQ").trim();
      var toInput = document.getElementById("polygonTo").value;
      var url = "/polygon?ticker=" + encodeURIComponent(ticker);
      if (toInput) url += "&to=" + encodeURIComponent(toInput);
      var out = document.getElementById("polygonOut");
      out.innerHTML = "Loading…";
      out.className = "";
      try {
        var r = await fetch(url);
        var data = await r.json();
        if (!data.success) {
          out.className = "result error";
          out.textContent = data.error || "Unknown error";
          return;
        }
        out.innerHTML = "<p class=\\"result success\\"><strong>" + data.ticker + "</strong> – daily: " + (data.daily && data.daily.bars ? data.daily.bars.length : 0) + " bars, hourly: " + (data.hourly && data.hourly.bars ? data.hourly.bars.length : 0) + ", 5m: " + (data.min5 && data.min5.bars ? data.min5.bars.length : 0) + "</p>" + formatBarTable(data.daily && data.daily.bars ? data.daily.bars : [], "Daily") + formatBarTable(data.hourly && data.hourly.bars ? data.hourly.bars : [], "Hourly") + formatBarTable(data.min5 && data.min5.bars ? data.min5.bars : [], "5 min");
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };

    document.getElementById("btnYahoo").onclick = async function () {
      var ticker = (document.getElementById("polygonTicker").value || "QQQ").trim();
      var s = document.getElementById("yahooSummary");
      var out = document.getElementById("polygonOut");
      s.textContent = "Loading Yahoo Finance…";
      out.innerHTML = "Loading Yahoo Finance…";
      out.className = "";
      try {
        var r = await fetch("/yahoo?ticker=" + encodeURIComponent(ticker));
        var data = await r.json();
        if (!data.success) {
          s.textContent = "Error: " + (data.error || "Unknown error");
          out.className = "result error";
          out.textContent = data.error || "Unknown error";
          return;
        }
        s.textContent = "Yahoo – daily: " + data.daily.length + ", hourly: " + data.hourly.length + ", 5m: " + data.min5.length;
        out.innerHTML =
          "<p class=\\\"result success\\\"><strong>Yahoo " + data.ticker + "</strong> – daily: " +
          data.daily.length + " bars, hourly: " + data.hourly.length + ", 5m: " + data.min5.length +
          "</p>" +
          formatBarTable(data.daily || [], "Yahoo Daily") +
          formatBarTable(data.hourly || [], "Yahoo Hourly") +
          formatBarTable(data.min5 || [], "Yahoo 5 min");
      } catch (e) {
        s.textContent = "Error: " + e.message;
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };

    document.getElementById("btnContext").onclick = async function () {
      var ticker = (document.getElementById("polygonTicker").value || "QQQ").trim();
      var out = document.getElementById("polygonOut");
      out.innerHTML = "Building context JSON (Yahoo + TradingView)…";
      out.className = "";
      try {
        var r = await fetch("/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: ticker })
        });
        if (!r.ok) {
          var txt = await r.text();
          out.className = "result error";
          out.textContent = "Error " + r.status + ": " + txt;
          return;
        }
        var data = await r.json();
        out.className = "result";
        out.innerHTML = "<h3>LLM JSON for " + data.symbol + "</h3><pre style=\\"white-space:pre-wrap; font-size:0.8rem; max-height:420px; overflow:auto;\\">" +
          JSON.stringify(data, null, 2) + "</pre>";
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };

    document.getElementById("btnDecision").onclick = async function () {
      var ticker = (document.getElementById("polygonTicker").value || "QQQ").trim();
      var out = document.getElementById("polygonOut");
      out.innerHTML = "Building 6-step pipeline preview (no LLM cost)… Check server terminal for printed JSON.";
      out.className = "";
      try {
        var r = await fetch("/decide-pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: ticker, previewSteps: true, runPipeline: false })
        });
        if (!r.ok) {
          var txt = await r.text();
          out.className = "result error";
          out.textContent = "Error " + r.status + ": " + txt;
          return;
        }
        var data = await r.json();
        var pf = data.pre_filter || {};
        var blocks = [
          "<h3>6-step pipeline preview — " + ticker + "</h3>",
          "<p><strong>Pre-filter pass:</strong> " + (pf.pass ? "YES" : "NO") + "</p>",
          pf.reasons && pf.reasons.length ? "<p><strong>Pre-filter block reasons:</strong> " + pf.reasons.join("; ") + "</p>" : "",
          "<p><strong>Checks:</strong> <code>" + JSON.stringify(pf.checks || {}) + "</code></p>",
          "<p style=\\"font-size:0.85rem;color:#555\\">" + (data.note || "") + "</p>"
        ];
        var reqs = data.five_step_requests || [];
        for (var s = 0; s < reqs.length; s++) {
          blocks.push(
            "<h4>Step " + reqs[s].step + " — " + reqs[s].agent + "</h4>" +
            "<pre style=\\"white-space:pre-wrap; font-size:0.72rem; max-height:320px; overflow:auto; background:#f7f7f7; padding:0.5rem;\\">" +
            JSON.stringify(reqs[s], null, 2).replace(/</g, "&lt;") +
            "</pre>"
          );
        }
        out.className = "result";
        out.innerHTML = blocks.join("");
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };

    document.getElementById("btnPayloadOnly").onclick = async function () {
      var ticker = (document.getElementById("polygonTicker").value || "QQQ").trim();
      var out = document.getElementById("polygonOut");
      out.innerHTML = "Building single LLM payload…";
      out.className = "";
      try {
        var r = await fetch("/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: ticker, previewOnly: true })
        });
        if (!r.ok) {
          var txt = await r.text();
          out.className = "result error";
          out.textContent = "Error " + r.status + ": " + txt;
          return;
        }
        var data = await r.json();
        out.className = "result";
        out.innerHTML = "<h3>Classic single payload for " + ticker + "</h3><pre style=\\"white-space:pre-wrap; font-size:0.8rem; max-height:420px; overflow:auto;\\">" +
          JSON.stringify(data, null, 2) + "</pre>";
      } catch (e) {
        out.className = "result error";
        out.textContent = "Error: " + e.message;
      }
    };
  </script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

/**
 * POST /capture
 * body:
 * {
 *   "url": "https://www.tradingview.com/chart/",
 *   "symbol": "NASDAQ:QQQ",
 *   "timeframe": "5",
 *   "outputDir": "C:\\tmp\\tradingview",
 *   "headless": true
 * }
 */
app.post("/capture", async (req, res) => {
  try {
    const {
      url = "https://www.tradingview.com/chart/",
      symbol = "NASDAQ:QQQ",
      timeframe = "5",
      outputDir = path.join(__dirname, "screenshots"),
      headless = false,
      useExistingChrome = false,
      debuggingPort = 9222
    } = req.body || {};

    const result = await captureTradingViewChart({
      url,
      symbol,
      timeframe,
      outputDir,
      headless,
      useExistingChrome,
      debuggingPort
    });

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

/**
 * GET /polygon?ticker=QQQ  or  POST /polygon { "ticker": "QQQ", "to": "YYYY-MM-DD" }
 * Returns 5-minute, hourly, and daily bar data from Polygon.
 */
function polygonTicker(symbol) {
  if (!symbol) return null;
  const t = String(symbol).trim();
  return t.includes(":") ? t.split(":")[1] : t;
}

function dateString(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchPolygonData(ticker, toDate = new Date()) {
  const toStr = dateString(toDate);
  const dailyFrom = new Date(toDate);
  dailyFrom.setDate(dailyFrom.getDate() - 95);
  const hourlyFrom = new Date(toDate);
  hourlyFrom.setDate(hourlyFrom.getDate() - 20);
  const min5From = new Date(toDate);
  min5From.setDate(min5From.getDate() - 7);

  const dailyFromStr = dateString(dailyFrom);
  const hourlyFromStr = dateString(hourlyFrom);
  const min5FromStr = dateString(min5From);

  console.log("[polygon] ticker=%s to=%s", ticker, toStr);
  console.log("[polygon] daily  from=%s to=%s (limit 60)", dailyFromStr, toStr);
  console.log("[polygon] hourly from=%s to=%s (limit 100)", hourlyFromStr, toStr);
  console.log("[polygon] 5m     from=%s to=%s (limit 120)", min5FromStr, toStr);

  const data = await getMultiTimeframeData({
    ticker,
    dailyFrom: dailyFromStr,
    dailyTo: toStr,
    hourlyFrom: hourlyFromStr,
    hourlyTo: toStr,
    min5From: min5FromStr,
    min5To: toStr,
    dailyLimit: 60,
    hourlyLimit: 100,
    min5Limit: 120
  });

  const nDaily = (data.daily && data.daily.bars && data.daily.bars.length) || 0;
  const nHourly = (data.hourly && data.hourly.bars && data.hourly.bars.length) || 0;
  const n5m = (data.min5 && data.min5.bars && data.min5.bars.length) || 0;
  console.log("[polygon] result daily=%d hourly=%d 5m=%d", nDaily, nHourly, n5m);
  return data;
}

app.get("/polygon", async (req, res) => {
  const ticker = polygonTicker(req.query.ticker || req.query.symbol);
  if (!ticker) {
    return res.status(400).json({ success: false, error: "Missing ticker (e.g. ?ticker=QQQ)" });
  }
  try {
    let to = req.query.to ? new Date(req.query.to) : null;
    if (!to) {
      if (process.env.POLYGON_DEFAULT_TO) {
        to = new Date(process.env.POLYGON_DEFAULT_TO);
      } else {
        to = new Date();
        to.setDate(to.getDate() - 1);
      }
    }
    const data = await fetchPolygonData(ticker, to);
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.post("/polygon", async (req, res) => {
  const ticker = polygonTicker((req.body && req.body.ticker) || req.query.ticker);
  if (!ticker) {
    return res.status(400).json({ success: false, error: "Missing ticker in body (e.g. { \"ticker\": \"QQQ\" })" });
  }
  try {
    let to = (req.body && req.body.to) ? new Date(req.body.to) : null;
    if (!to) {
      if (process.env.POLYGON_DEFAULT_TO) {
        to = new Date(process.env.POLYGON_DEFAULT_TO);
      } else {
        to = new Date();
        to.setDate(to.getDate() - 1);
      }
    }
    const data = await fetchPolygonData(ticker, to);
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

// Build LLM JSON context: Yahoo OHLCV + TradingView screenshots as base64
app.post("/context", async (req, res) => {
  const symbol = (req.body && req.body.symbol) || "QQQ";
  const tvSymbol = symbol; // can be adjusted to TradingView format if needed
  const outputDir = path.join(__dirname, "screenshots");

  try {
    const yahoo = await getMultiTimeframeYahoo(symbol);

    // Capture charts for daily, 1h, 5m (headless to avoid UI popups)
    const [dailyShot, hourlyShot, min5Shot] = await Promise.all([
      captureTradingViewChart({
        symbol: tvSymbol,
        timeframe: "D",
        outputDir,
        headless: true,
        useExistingChrome: false
      }),
      captureTradingViewChart({
        symbol: tvSymbol,
        timeframe: "60",
        outputDir,
        headless: true,
        useExistingChrome: false
      }),
      captureTradingViewChart({
        symbol: tvSymbol,
        timeframe: "5",
        outputDir,
        headless: true,
        useExistingChrome: false
      })
    ]);

    function toBase64(p) {
      try {
        const buf = fs.readFileSync(p);
        return buf.toString("base64");
      } catch {
        return null;
      }
    }

    const dailyBars = yahoo.daily || [];
    const hourlyBars = yahoo.hourly || [];
    const min5Bars = yahoo.min5 || [];

    const prevDaily = dailyBars.length > 1 ? dailyBars[dailyBars.length - 2] : null;
    const lastDaily = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1] : null;
    const last5m = min5Bars.length > 0 ? min5Bars[min5Bars.length - 1] : null;

    const dailyTrend =
      prevDaily && lastDaily
        ? lastDaily.close > prevDaily.close
          ? "bullish"
          : lastDaily.close < prevDaily.close
          ? "bearish"
          : "sideways"
        : "unknown";

    const hourlySlice = hourlyBars.slice(-120);
    const rangeHigh =
      hourlySlice.length > 0 ? Math.max.apply(null, hourlySlice.map((b) => b.high)) : null;
    const rangeLow =
      hourlySlice.length > 0 ? Math.min.apply(null, hourlySlice.map((b) => b.low)) : null;

    const context = {
      symbol,
      timestamp_utc: new Date().toISOString(),
      timeframes: {
        daily: {
          ohlcv: dailyBars,
          levels: {
            prev_high: prevDaily ? prevDaily.high : null,
            prev_low: prevDaily ? prevDaily.low : null,
            trend: dailyTrend
          },
          chart_base64: toBase64(dailyShot.path)
        },
        "1h": {
          ohlcv: hourlyBars,
          levels: {
            range_high: rangeHigh,
            range_low: rangeLow,
            trend: "unknown"
          },
          chart_base64: toBase64(hourlyShot.path)
        },
        "5m": {
          ohlcv: min5Bars,
          levels: {
            trigger_long_above: rangeHigh,
            trigger_short_below: rangeLow,
            current_price: last5m ? last5m.close : null
          },
          chart_base64: toBase64(min5Shot.path)
        }
      },
      features: {
        daily_bias: dailyTrend,
        hourly_bias: "unknown",
        five_min_state: "unknown",
        retest_confirmed: false,
        liquidity_sweep_detected: false,
        risk_reward_long: null,
        risk_reward_short: null
      },
      rules: [
        "Long only after 5m close above resistance and retest hold",
        "Short only after 5m close below support and failed retest",
        "No trade in middle of range",
        "Prefer trade aligned with daily and 1h bias",
        "Minimum RR must be 1.8"
      ]
    };

    return res.json(context);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

/** Normalize V4 no_trade_context ({ reasons, what_to_wait_for }) or legacy string[]. */
function noTradeContextReasons(ntc) {
  if (!ntc) return [];
  if (Array.isArray(ntc)) return ntc;
  return Array.isArray(ntc.reasons) ? ntc.reasons : [];
}

/**
 * Surfaces V4 + MTF conflict state at the top of the JSON (not buried in nested objects).
 */
function buildSignalConflictsBlock(alignmentScore, mtfConflict, featureEngines) {
  const fev5 = featureEngines?.feature_engine_v5 || {};
  const alerts = {
    daily: fev5.daily?.last_bar?.conflict_alert ?? null,
    "1h": fev5["1h"]?.last_bar?.conflict_alert ?? null,
    "5m": fev5["5m"]?.last_bar?.conflict_alert ?? null
  };
  const anyEngineConflict = Object.values(alerts).some((a) => a && a.present);
  const blockTrading = mtfConflict || anyEngineConflict;

  let headline = "clear";
  if (mtfConflict && anyEngineConflict) headline = "mtf_misalignment_and_engine_mixed_signals";
  else if (anyEngineConflict) headline = "engine_mixed_signals_or_low_reliability";
  else if (mtfConflict) headline = "mtf_bias_misalignment";

  return {
    headline,
    block_trading_suggestion: blockTrading,
    // alignment_score lives only on mtf_summary (avoid duplicate in LLM payload)
    mtf: {
      misaligned: mtfConflict
    },
    feature_engine_v5_last_bar: alerts,
    llm_instruction:
      blockTrading
        ? "Treat conflicts as first-class: prefer no_trade until alignment improves or conflicts clear."
        : "No mandatory conflict halt from this block."
  };
}

/**
 * Quantified MTF layer (still descriptive; pairs with mtf_summary).
 * `tradable` is merged in buildDecisionContext from execution_permission.
 * alignment_score lives only on mtf_summary (not under signal_conflicts.mtf).
 */
function buildMtfDecision(dailyBias, hourlyBias, intradayBias, alignmentScore, conflict) {
  const wDaily = 1.2;
  const wHourly = 1.0;
  const wIntra = 0.85;
  let score = 0;
  let denom = 0;
  const bump = (bias, w) => {
    if (bias === "bullish") {
      score += w;
      denom += w;
    } else if (bias === "bearish") {
      score -= w;
      denom += w;
    } else if (bias === "range") {
      denom += w * 0.35;
    }
  };
  bump(dailyBias, wDaily);
  bump(hourlyBias, wHourly);
  bump(intradayBias, wIntra);

  const n = denom > 0 ? score / denom : 0;
  let direction = "neutral";
  if (n > 0.22) direction = "long";
  else if (n < -0.22) direction = "short";
  else if (n > 0.06) direction = "lean_long";
  else if (n < -0.06) direction = "lean_short";

  let agreement = "partial";
  if (alignmentScore >= 0.85 && !conflict) agreement = "strong";
  else if (alignmentScore >= 0.7 && !conflict) agreement = "moderate";
  else if (alignmentScore < 0.55 || conflict) agreement = "weak";

  const confidence = Number(
    Math.min(0.95, Math.max(0.2, alignmentScore * (conflict ? 0.72 : 1)))
  ).toFixed(2);

  return {
    direction,
    agreement,
    confidence: parseFloat(confidence),
    conflict_flag: conflict,
    biases: {
      daily: dailyBias,
      hourly: hourlyBias,
      intraday: intradayBias
    }
  };
}

/** Collapse verbose blocking tags to a small set for the LLM (top N by priority). */
const BLOCKING_PRIORITY = {
  mtf_misalignment: 100,
  top_level_conflict_block: 95,
  mixed_signals: 88,
  weak_session: 78,
  no_clear_setup: 72,
  volume_unreliable: 65,
  engine_conflicts: 60
};

function normalizeBlockingTag(tag) {
  const t = String(tag);
  if (t === "mtf_misalignment") return "mtf_misalignment";
  if (t === "top_level_conflict_block") return "top_level_conflict_block";
  if (/_engine_mixed_signals$/.test(t) || t.endsWith("_mixed_signals")) return "mixed_signals";
  if (/_weak_session$/.test(t)) return "weak_session";
  const stripped = t.replace(/^(daily|1h|5m)_/, "");
  const s = stripped.toLowerCase();
  if (/volume|no_volume|low_volume|reliability/.test(s)) return "volume_unreliable";
  if (/trap|failed|reversal|no_trade|none|setup|bos|choch/.test(s)) return "no_clear_setup";
  if (/conflict|mixed|confluence/.test(s)) return "engine_conflicts";
  return stripped.length > 40 ? stripped.slice(0, 40) : stripped;
}

function selectTopBlockingFactors(blockingList, limit = 5) {
  const raw = [...new Set(blockingList)];
  const buckets = new Map();
  for (const tag of raw) {
    const cat = normalizeBlockingTag(tag);
    const pri = BLOCKING_PRIORITY[cat] ?? 45;
    const prev = buckets.get(cat);
    if (!prev || pri > prev.pri) buckets.set(cat, { cat, pri });
  }
  return [...buckets.values()]
    .sort((a, b) => b.pri - a.pri || String(a.cat).localeCompare(String(b.cat)))
    .map((x) => x.cat)
    .slice(0, limit);
}

function buildConfidenceBreakdown(mtfDecision, mtfSummary, signalConflicts, engineTf) {
  const tfKeys = ["daily", "1h", "5m"];
  const align = Number(mtfSummary?.alignment_score ?? 0.5);
  const conflict = !!(mtfSummary?.conflict || signalConflicts?.block_trading_suggestion);
  const trend_alignment = parseFloat(
    Math.min(1, Math.max(0, align * (conflict ? 0.55 : 1))).toFixed(2)
  );

  let setupSum = 0;
  let setupN = 0;
  for (const k of tfKeys) {
    const c = engineTf[k]?.last_bar?.setup?.confidence;
    if (typeof c === "number" && !Number.isNaN(c)) {
      setupSum += c;
      setupN += 1;
    }
  }
  const setup_quality = setupN
    ? parseFloat(Math.min(1, Math.max(0, setupSum / setupN)).toFixed(2))
    : 0.1;

  let volScore = 0;
  let volN = 0;
  for (const k of tfKeys) {
    const lb = engineTf[k]?.last_bar;
    if (!lb) continue;
    volN += 1;
    if (lb.volume_spike) volScore += 1;
    else if (lb.feature_reliability?.volume === "high") volScore += 0.55;
    else if (lb.feature_reliability?.volume === "low") volScore += 0;
    else volScore += 0.35;
  }
  const volume_confirmation = volN
    ? parseFloat(Math.min(1, Math.max(0, volScore / volN)).toFixed(2))
    : 0;

  let sessScore = 0;
  let sessN = 0;
  for (const k of tfKeys) {
    const lb = engineTf[k]?.last_bar;
    if (!lb) continue;
    sessN += 1;
    if (["after_hours", "overnight", "pre_market"].includes(lb.session)) sessScore += 0.2;
    else sessScore += 1;
  }
  const session_quality = sessN
    ? parseFloat(Math.min(1, Math.max(0, sessScore / sessN)).toFixed(2))
    : 0.5;

  let conflicts_penalty = 0;
  if (mtfSummary?.conflict) conflicts_penalty -= 0.35;
  if (signalConflicts?.block_trading_suggestion) conflicts_penalty -= 0.35;
  if (tfKeys.some((k) => engineTf[k]?.last_bar?.conflict_alert?.present)) {
    conflicts_penalty -= 0.25;
  }
  conflicts_penalty = parseFloat(Math.max(-1, conflicts_penalty).toFixed(2));

  return {
    trend_alignment,
    setup_quality,
    volume_confirmation,
    session_quality,
    conflicts_penalty,
    note: "Additive intuition only; confidence_estimate is still the primary scalar."
  };
}

/**
 * Non-binding hints for the LLM (not execution instructions).
 */
function buildDecisionHints(
  mtfDecision,
  mtfSummary,
  signalConflicts,
  engineTf,
  executionPermission
) {
  const blocking = [];
  const reasoning = [];

  if (mtfSummary?.conflict) blocking.push("mtf_misalignment");
  if (signalConflicts?.block_trading_suggestion) blocking.push("top_level_conflict_block");

  const tfKeys = ["daily", "1h", "5m"];
  for (const k of tfKeys) {
    const lb = engineTf[k]?.last_bar;
    if (!lb) continue;
    if (lb.conflict_alert?.present) blocking.push(`${k}_engine_mixed_signals`);
    noTradeContextReasons(lb.no_trade_context).forEach((r) => blocking.push(`${k}_${r}`));
    if (["after_hours", "overnight", "pre_market"].includes(lb.session)) {
      blocking.push(`${k}_weak_session`);
    }

    if (lb.bos === "bearish") reasoning.push(`${k}_bearish_bos`);
    if (lb.bos === "bullish") reasoning.push(`${k}_bullish_bos`);
    if (lb.above_vwap === false) reasoning.push(`${k}_below_vwap`);
    if (lb.above_vwap === true) reasoning.push(`${k}_above_vwap`);
    if (lb.fvg?.is_valid && lb.fvg.type === "bearish") reasoning.push(`${k}_valid_bearish_fvg`);
    if (lb.fvg?.is_valid && lb.fvg.type === "bullish") reasoning.push(`${k}_valid_bullish_fvg`);
    if (lb.structure_state) reasoning.push(`${k}_structure_${lb.structure_state}`);
  }

  let preferred_side = "none";
  if (executionPermission) {
    const d = mtfDecision?.direction;
    if (d === "long" || d === "lean_long") preferred_side = "long";
    else if (d === "short" || d === "lean_short") preferred_side = "short";

    const bears = tfKeys.filter((k) => engineTf[k]?.last_bar?.bos === "bearish").length;
    const bulls = tfKeys.filter((k) => engineTf[k]?.last_bar?.bos === "bullish").length;
    if (bears >= 2 && bulls === 0) preferred_side = "short";
    if (bulls >= 2 && bears === 0) preferred_side = "long";
  } else {
    preferred_side = null;
  }

  const blocking_factors_full = [...new Set(blocking)];
  const blocking_factors = selectTopBlockingFactors(blocking_factors_full, 5);
  const confidence_breakdown = buildConfidenceBreakdown(
    mtfDecision,
    mtfSummary,
    signalConflicts,
    engineTf
  );

  let confidence_estimate = Number(mtfDecision?.confidence ?? 0.55);
  if (!executionPermission) {
    confidence_estimate = 0;
  } else {
    if (blocking_factors_full.length) confidence_estimate *= 0.55;
    if (signalConflicts?.block_trading_suggestion) confidence_estimate *= 0.62;
    confidence_estimate = parseFloat(
      Number(Math.min(0.9, Math.max(0.08, confidence_estimate))).toFixed(2)
    );
  }

  return {
    disclaimer: "Non-binding synthesis to guide interpretation; not a trade recommendation.",
    preferred_side,
    confidence_estimate,
    confidence_breakdown,
    reasoning: [...new Set(reasoning)].slice(0, 22),
    blocking_factors,
    blocking_factors_full,
    blocking_factors_full_count: blocking_factors_full.length
  };
}

/**
 * Hard “stand down” visibility for the model when gates fire.
 */
function buildNoTradeSignal(signalConflicts, engineTf, mtfSummary) {
  const reasons = [];
  if (signalConflicts?.block_trading_suggestion) {
    reasons.push(signalConflicts.headline || "signal_conflicts_active");
  }
  if (mtfSummary?.conflict) reasons.push("mtf_alignment_below_threshold");

  for (const k of ["daily", "1h", "5m"]) {
    const lb = engineTf[k]?.last_bar;
    if (!lb) continue;
    if (lb.conflict_alert?.present) reasons.push(`${k}_mixed_signals`);
    noTradeContextReasons(lb.no_trade_context).forEach((r) => reasons.push(`${k}_${r}`));
  }

  const unique = [...new Set(reasons)];
  const active =
    !!signalConflicts?.block_trading_suggestion ||
    !!mtfSummary?.conflict ||
    ["daily", "1h", "5m"].some((k) => engineTf[k]?.last_bar?.conflict_alert?.present);

  return {
    active,
    reasons: unique.slice(0, 35),
    note: active
      ? "When active, default stance should be no_trade unless the model explicitly resolves every blocking reason."
      : "No mandatory no-trade gate from this block."
  };
}

/**
 * Best-effort global candidate from per-TF trade_candidates (already RR / risk filtered in V3).
 */
function buildGlobalTradeCandidates(engineTf, mtfDecision) {
  const order = ["daily", "1h", "5m"];

  function pickBest(side) {
    let best = null;
    let bestTf = null;
    for (const tf of order) {
      const cand = engineTf[tf]?.last_bar?.trade_candidates?.[side];
      if (!cand || typeof cand.rr_estimate !== "number") continue;
      if (!best || cand.rr_estimate > best.rr_estimate) {
        best = cand;
        bestTf = tf;
      }
    }
    if (!best) return null;
    const entry = best.entry_reference;
    const pad = Math.max((best.risk_distance || 0) * 0.12, 0.02);
    const reasonParts = [
      `source_tf:${bestTf}`,
      `rr:${best.rr_estimate}`,
      ...(best.rationale || [])
    ];
    return {
      source_timeframe: bestTf,
      entry_zone: [
        Number((entry - pad).toFixed(4)),
        Number((entry + pad).toFixed(4))
      ],
      entry_reference: best.entry_reference,
      invalidation_reference: best.invalidation_reference,
      target_reference: best.target_reference,
      rr_estimate: best.rr_estimate,
      reason: reasonParts.join(" | ").slice(0, 240)
    };
  }

  const long = pickBest("long");
  const short = pickBest("short");
  const dir = mtfDecision?.direction;

  let longOut = long;
  let shortOut = short;
  if (dir === "short" || dir === "lean_short") {
    if (longOut && shortOut && shortOut.rr_estimate >= longOut.rr_estimate * 0.82) {
      longOut = null;
    }
  }
  if (dir === "long" || dir === "lean_long") {
    if (longOut && shortOut && longOut.rr_estimate >= shortOut.rr_estimate * 0.82) {
      shortOut = null;
    }
  }

  return {
    long: longOut,
    short: shortOut
  };
}

/**
 * Rank long/short candidates by RR when both exist (for LLM clarity).
 */
function buildCandidateRanking(globalCandidates) {
  if (!globalCandidates) return null;
  const rows = [];
  if (globalCandidates.long && typeof globalCandidates.long.rr_estimate === "number") {
    rows.push({
      side: "long",
      rr_estimate: globalCandidates.long.rr_estimate,
      source_timeframe: globalCandidates.long.source_timeframe
    });
  }
  if (globalCandidates.short && typeof globalCandidates.short.rr_estimate === "number") {
    rows.push({
      side: "short",
      rr_estimate: globalCandidates.short.rr_estimate,
      source_timeframe: globalCandidates.short.source_timeframe
    });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.rr_estimate - a.rr_estimate);
  const ordered = rows.map((r, i) => ({ ...r, candidate_rank: i + 1 }));
  return {
    primary_side: ordered[0].side,
    candidate_rank: 1,
    ordered
  };
}

/**
 * Labels heuristic probability; borderline ~0.5 → no_edge so the LLM does not fake conviction.
 */
function expectedMoveConfidenceLabel(probability, executionPermission) {
  if (!executionPermission) return "no_edge";
  const p = Number(probability);
  if (!Number.isFinite(p)) return "unknown";
  if (Math.abs(p - 0.5) <= 0.055) return "no_edge";
  if (p < 0.5) return "low_edge";
  if (p < 0.56) return "thin_edge";
  if (p < 0.64) return "moderate_edge";
  return "stronger_edge";
}

/**
 * Heuristic expected band from MTF bias + 5m ATR (not a forecast; for LLM framing only).
 */
function buildExpectedMove(mtfDecision, lastClose, atr5m, executionPermission) {
  const tradable = !!executionPermission;
  if (!Number.isFinite(lastClose) || lastClose <= 0) {
    return {
      direction: "unknown",
      probability: null,
      confidence_label: "no_edge",
      tradable: false,
      range: null,
      reference_price: null,
      disclaimer: "Heuristic_band_from_mtf_bias_and_ATR_not_probability_model"
    };
  }
  const d = mtfDecision?.direction || "neutral";
  let direction = "sideways";
  if (d === "long" || d === "lean_long") direction = "up";
  else if (d === "short" || d === "lean_short") direction = "down";

  const conf = Number(mtfDecision?.confidence ?? 0.5);
  const probability = parseFloat(
    Math.min(0.82, Math.max(0.38, 0.52 + (conf - 0.55) * 0.65)).toFixed(2)
  );
  const confidence_label = expectedMoveConfidenceLabel(probability, tradable);

  const atr =
    Number.isFinite(atr5m) && atr5m > 0 ? atr5m : Math.max(lastClose * 0.0025, 0.01);
  const span = atr * 1.35;

  let low = lastClose - span;
  let high = lastClose + span;
  if (direction === "up") {
    low = lastClose - span * 0.35;
    high = lastClose + span;
  } else if (direction === "down") {
    low = lastClose - span;
    high = lastClose + span * 0.35;
  }

  const range = [
    Number(low.toFixed(2)),
    Number(high.toFixed(2))
  ].sort((a, b) => a - b);

  return {
    direction,
    probability,
    confidence_label,
    tradable,
    range,
    reference_price: Number(lastClose.toFixed(4)),
    disclaimer: "Heuristic_band_from_mtf_bias_and_ATR_not_probability_model"
  };
}

function buildCandidateValidity(noTradeActive) {
  if (!noTradeActive) {
    return {
      long: { valid: true, reason: null },
      short: { valid: true, reason: null }
    };
  }
  return {
    long: { valid: false, reason: "blocked_by_no_trade_signal" },
    short: { valid: false, reason: "blocked_by_no_trade_signal" }
  };
}

const BLOCKED_TF_TRADE_CANDIDATES = {
  long: { valid: false, blocked_reason: "global_no_trade_signal" },
  short: { valid: false, blocked_reason: "global_no_trade_signal" }
};

function buildBlockedGlobalCandidates(reason = "global_no_trade_signal") {
  return {
    long: { valid: false, blocked_reason: reason },
    short: { valid: false, blocked_reason: reason }
  };
}

/** Hide misleading RR on last_bar when the global gate blocks trading (same as LLM slim). */
function redactFeatureEngineV5TradeCandidates(fePayload, executionPermission) {
  if (executionPermission || !fePayload?.feature_engine_v5) return fePayload;
  const fev5 = fePayload.feature_engine_v5;
  const next = { ...fePayload, feature_engine_v5: { ...fev5 } };
  for (const tf of ["daily", "1h", "5m"]) {
    const slot = next.feature_engine_v5[tf];
    if (!slot?.last_bar) continue;
    next.feature_engine_v5[tf] = {
      ...slot,
      last_bar: {
        ...slot.last_bar,
        trade_candidates: BLOCKED_TF_TRADE_CANDIDATES
      }
    };
  }
  return next;
}

/**
 * Yahoo often returns volume 0 on the latest 5m bar (session incomplete / not yet reported).
 * Align with volume_context + explicit LLM constraint.
 */
function buildHardConstraints(dailyTf, hourlyTf, min5Tf, min5Candles) {
  const details = [];
  let ignore_volume = false;

  const checkVc = (key, tf) => {
    const vc = tf?.volume_context;
    if (vc?.use_volume_for_decision === false) {
      ignore_volume = true;
      details.push(`${key}_use_volume_for_decision_false`);
    }
    if (vc?.null_volume_bars_present) {
      ignore_volume = true;
      details.push(`${key}_null_or_zero_volume_bars_in_series`);
    }
  };
  checkVc("daily", dailyTf);
  checkVc("1h", hourlyTf);
  checkVc("5m", min5Tf);

  const last5 = min5Candles?.length ? min5Candles[min5Candles.length - 1] : null;
  const vLast = last5?.volume;
  if (last5 && (vLast === 0 || vLast === null || vLast === undefined)) {
    ignore_volume = true;
    details.push("last_5m_bar_volume_zero_or_missing_incomplete_bar_common_on_yahoo");
  }

  return {
    ignore_volume,
    reason: ignore_volume ? "invalid_or_missing_data" : null,
    details: [...new Set(details)],
    note_for_llm:
      "If ignore_volume is true, do NOT use volume_percentile, volume spike, or bar volume levels for conviction; rely on price structure only with lower confidence."
  };
}

function buildCompressedBarRow(b, idx, arr) {
  const isLast = idx === arr.length - 1;
  const vol = b.volume;
  const o = Number(b.open);
  const h = Number(b.high);
  const l = Number(b.low);
  const c = Number(b.close);
  const row = {
    o: Number.isFinite(o) ? Number(o.toFixed(4)) : null,
    h: Number.isFinite(h) ? Number(h.toFixed(4)) : null,
    l: Number.isFinite(l) ? Number(l.toFixed(4)) : null,
    c: Number.isFinite(c) ? Number(c.toFixed(4)) : null
  };
  if (Number.isFinite(vol) && vol > 0) {
    row.v = vol;
  } else if (isLast) {
    row.v = vol === 0 ? 0 : null;
    row.v_note = "zero_or_missing_on_last_bar_often_yahoo_delayed_not_zero_liquidity";
  }
  return row;
}

function summarizeRecentBars5m(slice, dataRows) {
  const closes = dataRows.map((r) => r.c).filter((x) => Number.isFinite(x));
  let trend = "sideways";
  if (closes.length >= 2) {
    const a = closes[0];
    const b = closes[closes.length - 1];
    const pct = (b - a) / (Math.abs(a) || 1e-9);
    if (pct > 0.0012) trend = "up";
    else if (pct < -0.0012) trend = "down";
  }

  const tail = closes.slice(-4);
  let momentum = "weak";
  if (tail.length >= 3) {
    let up = 0;
    let down = 0;
    for (let j = 1; j < tail.length; j++) {
      if (tail[j] > tail[j - 1]) up += 1;
      else if (tail[j] < tail[j - 1]) down += 1;
    }
    if (up >= 2 && down === 0) momentum = "strong_up";
    else if (down >= 2 && up === 0) momentum = "strong_down";
    else if (up > down) momentum = "up";
    else if (down > up) momentum = "down";
  }

  let phase = "extension";
  if (trend === "down" && closes.length >= 2 && closes[closes.length - 1] > closes[closes.length - 2]) {
    phase = "pullback";
  } else if (trend === "up" && closes.length >= 2 && closes[closes.length - 1] < closes[closes.length - 2]) {
    phase = "pullback";
  } else if (trend === "sideways") {
    phase = "drift";
  }

  const highs = slice.map((b) => Number(b.high)).filter(Number.isFinite);
  const lows = slice.map((b) => Number(b.low)).filter(Number.isFinite);
  if (!highs.length || !lows.length) {
    return { trend, momentum, phase: "unknown", structure: "unknown" };
  }
  const hh = Math.max(...highs);
  const ll = Math.min(...lows);
  const rangePct = ll > 0 ? (hh - ll) / ll : 0;
  const structure = rangePct < 0.012 ? "range" : trend === "sideways" ? "range" : "trend";

  return { trend, momentum, phase, structure };
}

/** { data, summary } for LLM — interpretation + compressed OHLC rows */
function buildRecentBars5mPackage(candles, maxBars = 28) {
  if (!Array.isArray(candles) || !candles.length) {
    return { data: [], summary: { trend: "unknown", momentum: "weak", phase: "unknown", structure: "unknown" } };
  }
  const slice = candles.slice(-maxBars);
  const data = slice.map((b, idx, arr) => buildCompressedBarRow(b, idx, arr));
  const summary = summarizeRecentBars5m(slice, data);
  return { data, summary };
}

function buildExecutionLayer(
  executionPermission,
  finalCtx,
  setupPresence,
  decisionContext,
  signalConflicts,
  engineTf
) {
  const blocking = (finalCtx?.trade_block?.reasons || []).join(", ") || "none_listed";
  if (!executionPermission) {
    return {
      market_state: "blocked",
      entry_readiness: false,
      best_side: null,
      reason: `no_execution_permission: ${blocking}`,
      next_expected_move: "liquidity_sweep_or_range_break"
    };
  }

  const micro = engineTf?.["5m"]?.last_bar?.micro_structure;
  let market_state = "mixed";
  if (micro?.range_behavior) market_state = "range";
  else if (micro?.phase === "impulse") market_state = "impulse";
  else if (micro?.bias_phase === "continuation") market_state = "trend_continuation";
  else if (micro?.bias_phase === "retracement") market_state = "pullback_inside_trend";
  else if (decisionContext?.direction && decisionContext.direction !== "neutral") {
    market_state = "trending";
  }

  const entry_readiness =
    !!setupPresence?.exists &&
    setupPresence.quality !== "weak" &&
    !signalConflicts?.block_trading_suggestion;

  let best_side = null;
  const ps = decisionContext?.preferred_side;
  if (ps && ps !== "none") best_side = ps;

  return {
    market_state,
    entry_readiness,
    best_side,
    reason: entry_readiness
      ? "setup_present_and_conflict_gate_clear"
      : "no_clear_setup_or_conflicts_or_weak_quality",
    next_expected_move: entry_readiness ? "use_global_trade_candidates_and_execution_state" : "liquidity_sweep_or_range_break"
  };
}

function buildEntryModelContext(lastClose, globalCandidatesRaw, executionPermission) {
  if (!executionPermission || !Number.isFinite(lastClose)) return null;
  const out = {
    current_price: Number(lastClose.toFixed(4)),
    long: null,
    short: null
  };
  for (const side of ["long", "short"]) {
    const c = globalCandidatesRaw?.[side];
    if (!c?.entry_zone || !Array.isArray(c.entry_zone) || c.entry_zone.length < 2) continue;
    const lo = Math.min(Number(c.entry_zone[0]), Number(c.entry_zone[1]));
    const hi = Math.max(Number(c.entry_zone[0]), Number(c.entry_zone[1]));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const inZone = lastClose >= lo && lastClose <= hi;
    const dist = inZone ? 0 : Math.min(Math.abs(lastClose - lo), Math.abs(lastClose - hi));
    out[side] = {
      valid_entry_zone: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
      is_in_zone: inZone,
      distance_from_entry_zone: Number(dist.toFixed(4))
    };
  }
  return out;
}

function buildSetupPresence(engineTf) {
  const lb = engineTf?.["5m"]?.last_bar;
  const type = lb?.setup?.type ?? "none";
  const exists = !!(type && type !== "none");
  const q = lb?.setup_analysis?.setup_quality;
  return {
    exists,
    type: exists ? type : null,
    quality: exists && q ? q : "none",
    priority: lb ? setupPriority(lb) : "low"
  };
}

function buildFinalDecisionContext(
  executionPermission,
  decisionHints,
  noTradeSignal,
  signalConflicts
) {
  const mode = executionPermission ? "TRADE_ALLOWED" : "NO_TRADE";
  const merged = [
    ...(decisionHints.blocking_factors_full || []),
    ...(noTradeSignal.reasons || [])
  ];
  if (signalConflicts?.block_trading_suggestion && signalConflicts?.headline) {
    merged.push(signalConflicts.headline);
  }
  const tradeReasons = selectTopBlockingFactors([...new Set(merged)], 10);

  return {
    mode,
    confidence: executionPermission ? decisionHints.confidence_estimate : 0,
    trade_block: {
      active: !executionPermission,
      reasons: tradeReasons
    },
    override_required_for_trade: !executionPermission,
    llm_instruction:
      executionPermission
        ? "Trade ideas must respect trade_block (inactive), hard_constraints, and triggers; anchor prices to payload only."
        : "Do NOT generate LONG/SHORT unless trade_block.reasons are explicitly resolved in live data; default to NO_TRADE."
  };
}

/** Drop analysis fields the LLM does not need — LLM payload only. */
function trimTimeframeForLLM(tf) {
  if (!tf || typeof tf !== "object") return tf;
  const out = { ...tf };
  delete out.indicators;
  delete out.candle_signals;
  const vc = out.volume_context;
  const vol = out.volume;
  if (vol && vc && vc.use_volume_for_decision === false) {
    out.volume = {
      current: null,
      relative: null,
      average_20: vol.average_20 ?? null,
      spike: vol.spike,
      last_bar_volume_missing: vol.last_bar_volume_missing,
      volume_valid: false,
      note_for_llm:
        vol.last_bar_volume_missing || vc.null_volume_bars_present
          ? "volume_unknown_or_null_do_not_read_as_zero_liquidity"
          : "unreliable_volume_series_do_not_infer_crash_from_zero"
    };
  }
  return out;
}

/**
 * Compact feature_engine_v5 for LLM: adaptive_context, reliability, conflicts,
 * trade_candidates, no_trade_context (+ bar_count / engine_config).
 * Omits micro_structure here — use decision_smart_pipeline.smart_money_layer.micro_structure (5m).
 */
function buildFeatureEngineV5SlimForLLM(fev5, timeframesByKey, opts = {}) {
  if (!fev5 || typeof fev5 !== "object") return fev5;
  const executionPermission = !!opts.executionPermission;
  const keys = ["daily", "1h", "5m"];
  const out = {};
  for (const tf of keys) {
    const slot = fev5[tf];
    if (!slot) {
      out[tf] = slot;
      continue;
    }
    const lb = slot.last_bar;
    const useVol = timeframesByKey?.[tf]?.volume_context?.use_volume_for_decision;
    const lowVolRel = lb?.feature_reliability?.volume === "low";
    let volume_note_for_llm = null;
    if (useVol === false) {
      volume_note_for_llm = "aligned_with_timeframe_volume_context_unreliable";
    } else if (lowVolRel) {
      volume_note_for_llm =
        lb?.no_trade_context?.volume_policy === "penalty_not_hard_block"
          ? "volume_treated_as_confidence_penalty_only"
          : "feature_engine_volume_reliability_low";
    }
    const tradeCandidates = !executionPermission
      ? BLOCKED_TF_TRADE_CANDIDATES
      : lb?.trade_candidates ?? null;
    out[tf] = {
      bar_count: slot.bar_count ?? null,
      engine_config: slot.engine_config ?? null,
      adaptive_context: lb?.adaptive_context ?? null,
      feature_reliability: lb?.feature_reliability ?? null,
      trade_candidates: tradeCandidates,
      no_trade_context: lb?.no_trade_context ?? null,
      ...(volume_note_for_llm ? { volume_note_for_llm } : {})
    };
  }
  return out;
}

/** Slim (or debug) payload for LLM — shared by /decide and /decide-pipeline. */
function buildPayloadForLLMFromContext(context, debug = false) {
  const timeframes = {
    daily: trimTimeframeForLLM({ ...context.timeframes.daily }),
    "1h": trimTimeframeForLLM({ ...context.timeframes["1h"] }),
    "5m": trimTimeframeForLLM({ ...context.timeframes["5m"] })
  };
  delete timeframes.daily.ohlcv;
  delete timeframes["1h"].ohlcv;
  delete timeframes["5m"].ohlcv;

  const slimFe = buildFeatureEngineV5SlimForLLM(context.feature_engine_v5, timeframes, {
    executionPermission: context.execution_permission
  });

  if (debug) {
    return {
      payload: {
        ...context,
        timeframes,
        feature_engine_v5: slimFe
      },
      timeframes,
      slimFe
    };
  }

  const payload = {
    symbol: context.symbol,
    timestamp_utc: context.timestamp_utc,
    decision_smart_pipeline: context.decision_smart_pipeline,
    hard_constraints: context.hard_constraints,
    mtf_summary: context.mtf_summary,
    timeframes,
    feature_engine_v5: slimFe,
    recent_bars_5m: context.recent_bars_5m,
    ...(context.execution_permission
      ? {
          global_trade_candidates: context.global_trade_candidates,
          expected_move: context.expected_move,
          entry_model_context: context.entry_model_context,
          execution_layer: context.execution_layer,
          setup_presence: context.setup_presence
        }
      : {})
  };
  return { payload, timeframes, slimFe };
}

async function buildDecisionContext(symbol) {
  const yahoo = await getMultiTimeframeYahoo(symbol);
  const dailyCandles = (yahoo.daily || []).slice(-24); // 24 daily bars
  const hourlyCandles = (yahoo.hourly || []).slice(-90); // 90 hourly bars
  const min5Candles = (yahoo.min5 || []).slice(-120); // 120 5m bars

  const daily = analyzeSymbol(symbol, dailyCandles);
  const hourly = analyzeSymbol(symbol, hourlyCandles);
  const min5 = analyzeSymbol(symbol, min5Candles);

  daily.context.timeframe = "1D";
  hourly.context.timeframe = "1H";
  min5.context.timeframe = "5m";

  // Attach raw OHLCV lists (price + volume) for each timeframe
  daily.ohlcv = dailyCandles;
  hourly.ohlcv = hourlyCandles;
  min5.ohlcv = min5Candles;

  function biasFromTrend(t) {
    if (!t || !t.trend || !t.trend.direction) return "unknown";
    if (t.trend.direction === "bullish") return "bullish";
    if (t.trend.direction === "bearish") return "bearish";
    return "range";
  }

  const dailyBias = biasFromTrend(daily);
  const hourlyBias = biasFromTrend(hourly);
  const intradayBias = biasFromTrend(min5);

  let alignmentScore = 0;
  const biases = [dailyBias, hourlyBias, intradayBias].filter((b) => b !== "unknown");
  if (biases.length >= 2) {
    const bullishCount = biases.filter((b) => b === "bullish").length;
    const bearishCount = biases.filter((b) => b === "bearish").length;
    const rangeCount = biases.filter((b) => b === "range").length;
    const maxCount = Math.max(bullishCount, bearishCount, rangeCount);
    alignmentScore = Number((maxCount / biases.length).toFixed(2));
  }
  const conflict = alignmentScore < 0.7;

  // Very simple session tagging (UTC). Can be refined later.
  const now = new Date();
  const hours = now.getUTCHours();
  let sessionType = "unknown";
  let volatilityExpected = "medium";
  // 13-15 UTC ~ NY open
  if (hours >= 13 && hours <= 15) {
    sessionType = "NY_open";
    volatilityExpected = "high";
  } else if (hours >= 19 && hours <= 20) {
    sessionType = "power_hour";
    volatilityExpected = "high";
  } else if (hours >= 14 && hours <= 20) {
    sessionType = "regular";
    volatilityExpected = "medium";
  } else {
    sessionType = "off_hours";
    volatilityExpected = "low";
  }

  const aboveLevels = [
    ...(daily.liquidity.equal_highs || []).map((x) => x.price),
    ...(hourly.liquidity.equal_highs || []).map((x) => x.price),
    ...(min5.liquidity.equal_highs || []).map((x) => x.price)
  ];
  const belowLevels = [
    ...(daily.liquidity.equal_lows || []).map((x) => x.price),
    ...(hourly.liquidity.equal_lows || []).map((x) => x.price),
    ...(min5.liquidity.equal_lows || []).map((x) => x.price)
  ];

  const aboveMax = aboveLevels.length ? Math.max.apply(null, aboveLevels) : null;
  const belowMin = belowLevels.length ? Math.min.apply(null, belowLevels) : null;

  const targets = {
    above: aboveMax,
    below: belowMin
  };

  const dataQuality = {
    daily: daily.volume_context.data_quality,
    "1h": hourly.volume_context.data_quality,
    "5m": min5.volume_context.data_quality
  };

  const playbook = [
    "Trade only when liquidity is clear",
    "Avoid trading in the middle of a range",
    "High RSI near resistance is a warning sign",
    "Low volume reduces conviction"
  ];

  const hard_constraints = buildHardConstraints(daily, hourly, min5, min5Candles);
  const featureEnginesRaw = buildFeatureEnginePayload(dailyCandles, hourlyCandles, min5Candles, {
    volumeAsPenaltyOnly: hard_constraints.ignore_volume
  });
  const fev5 = featureEnginesRaw.feature_engine_v5;

  const signal_conflicts = buildSignalConflictsBlock(
    alignmentScore,
    conflict,
    featureEnginesRaw
  );

  const mtf_summary = {
    daily_bias: dailyBias,
    hourly_bias: hourlyBias,
    intraday_bias: intradayBias,
    alignment_score: alignmentScore,
    conflict
  };

  const mtf_decision_core = buildMtfDecision(
    dailyBias,
    hourlyBias,
    intradayBias,
    alignmentScore,
    conflict
  );
  const no_trade_signal = buildNoTradeSignal(
    signal_conflicts,
    fev5,
    mtf_summary
  );
  const noTrade = !!no_trade_signal.active;
  const execution_permission = !noTrade;

  const mtf_decision_internal = {
    ...mtf_decision_core,
    tradable: execution_permission
  };

  const decision_hints = buildDecisionHints(
    mtf_decision_internal,
    mtf_summary,
    signal_conflicts,
    fev5,
    execution_permission
  );

  const global_trade_candidates_raw = buildGlobalTradeCandidates(fev5, mtf_decision_core);
  const global_trade_candidates = noTrade
    ? buildBlockedGlobalCandidates()
    : global_trade_candidates_raw;
  const candidate_validity = buildCandidateValidity(noTrade);
  const candidate_ranking = noTrade ? null : buildCandidateRanking(global_trade_candidates_raw);

  const lastBar5m = min5Candles.length ? min5Candles[min5Candles.length - 1] : null;
  const lastClose5m =
    lastBar5m && Number.isFinite(Number(lastBar5m.close)) ? Number(lastBar5m.close) : null;
  const atr5m = fev5["5m"]?.last_bar?.atr;
  const expected_move = execution_permission
    ? buildExpectedMove(mtf_decision_core, lastClose5m, atr5m, true)
    : null;

  const targetsForPayload = execution_permission ? targets : null;

  const recent_bars_5m = buildRecentBars5mPackage(min5Candles, 28);
  const setup_presence = buildSetupPresence(fev5);
  const execution_state_raw = buildExecutionState(min5Candles);
  const execution_state =
    execution_state_raw != null
      ? {
          ...execution_state_raw,
          setup_alignment: buildSetupAlignment(
            execution_state_raw,
            fev5["5m"]?.last_bar,
            setup_presence
          )
        }
      : null;
  const micro_structure_5m = fev5["5m"]?.last_bar?.micro_structure ?? null;
  const entry_model_context = buildEntryModelContext(
    lastClose5m,
    global_trade_candidates_raw,
    execution_permission
  );

  const liquidity_map = buildLiquidityMap({
    daily,
    hourly,
    min5,
    lastClose: lastClose5m,
    liquidityTarget: fev5["5m"]?.last_bar?.liquidity_target ?? null
  });

  const decision_score = buildDecisionScore({
    lastBar5m: fev5["5m"]?.last_bar ?? null,
    setupPresence: setup_presence,
    executionState: execution_state,
    signalConflicts: signal_conflicts,
    mtfSummary: mtf_summary
  });
  const final_decision_context = buildFinalDecisionContext(
    execution_permission,
    decision_hints,
    no_trade_signal,
    signal_conflicts
  );

  const decision_context = {
    tradable: execution_permission,
    direction: execution_permission ? mtf_decision_core.direction : null,
    mtf_confidence: execution_permission ? mtf_decision_core.confidence : 0,
    agreement: execution_permission ? mtf_decision_core.agreement : null,
    conflict_flag: mtf_decision_core.conflict_flag,
    note: execution_permission ? null : "blocked_by_conflicts",
    preferred_side: decision_hints.preferred_side,
    confidence_estimate: decision_hints.confidence_estimate,
    confidence_breakdown: decision_hints.confidence_breakdown,
    blocking_factors: decision_hints.blocking_factors,
    blocking_factors_full_count: decision_hints.blocking_factors_full_count,
    reasoning_synthesis: decision_hints.reasoning,
    disclaimer: decision_hints.disclaimer
  };

  const execution_layer = buildExecutionLayer(
    execution_permission,
    final_decision_context,
    setup_presence,
    decision_context,
    signal_conflicts,
    fev5
  );

  const smartMoney = mapFeatureToLLM(featureEnginesRaw.feature_engine_v5["5m"]?.last_bar);
  const triggers = buildTriggers(execution_state, featureEnginesRaw.feature_engine_v5["5m"]?.last_bar);
  const decision_smart_pipeline = buildPayload({
    symbol,
    smartMoney,
    executionState: execution_state,
    triggers,
    liquidity_map,
    score: decision_score,
    execution_permission,
    final_decision_context
  });

  const featureEngines = redactFeatureEngineV5TradeCandidates(
    featureEnginesRaw,
    execution_permission
  );

  return {
    symbol,
    timestamp_utc: new Date().toISOString(),
    decision_smart_pipeline,
    signal_conflicts,
    mtf_summary,
    decision_context,
    no_trade_signal,
    execution_permission,
    candidate_validity,
    candidate_ranking,
    global_trade_candidates,
    expected_move,
    final_decision_context,
    setup_presence,
    hard_constraints,
    recent_bars_5m,
    micro_structure_5m,
    execution_state,
    execution_layer,
    entry_model_context,
    session: {
      type: sessionType,
      volatility_expected: volatilityExpected
    },
    targets: targetsForPayload,
    data_quality: dataQuality,
    playbook,
    timeframes: {
      daily,
      "1h": hourly,
      "5m": min5
    },
    ...featureEngines
  };
}

// Build compact decision JSON from Yahoo candles (daily, hourly, 5m)
app.post("/analysis", async (req, res) => {
  const symbol = (req.body && req.body.symbol) || "QQQ";
  try {
    // Keep /analysis as the raw decision-ready context
    const context = await buildDecisionContext(symbol);
    return res.json(context);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// POST /decide
// Body: { symbol, provider, previewOnly?, debug?, skipPreFilter?, filterOverrides? }
// Same evaluatePreFilter gates as /decide-pipeline — no LLM until pass (unless skipPreFilter).
app.post("/decide", async (req, res) => {
  const symbol = (req.body && req.body.symbol) || "QQQ";
  const provider = (req.body && req.body.provider) || "chatgpt";
  const debug = !!(req.body && req.body.debug);
  const previewOnly = !!(req.body && req.body.previewOnly);
  const skipPreFilter = !!(req.body && req.body.skipPreFilter);
  const filterOverrides = (req.body && req.body.filterOverrides) || {};

  try {
    const context = await buildDecisionContext(symbol);
    const { payload: payloadForLLM } = buildPayloadForLLMFromContext(context, debug);

    const pre_filter = evaluatePreFilter(payloadForLLM, filterOverrides);

    if (previewOnly) {
      return res.json({
        symbol,
        previewOnly: true,
        pre_filter,
        payloadForLLM
      });
    }

    if (!pre_filter.pass && !skipPreFilter) {
      const blocked = normalizeTradingDecision({
        action: "NO_TRADE",
        why: ["hard_stop_pre_llm (/decide): " + pre_filter.reasons.join("; ")]
      });
      if (debug) {
        return res.json({
          pre_filter,
          hard_stop_before_llm: true,
          skip_pre_filter_applied: false,
          payloadForLLM,
          decision: blocked,
          raw_model_text: null
        });
      }
      return res.json(blocked);
    }

    const raw = provider === "gemini" ? await askGemini(payloadForLLM) : await askChatGPT(payloadForLLM);

    // Try to parse model output into JSON
    function extractJson(text) {
      if (typeof text !== "string") return null;
      let t = text.trim();
      // Remove code fences if present
      t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

      const first = t.indexOf("{");
      const last = t.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        t = t.slice(first, last + 1);
      }

      return JSON.parse(t);
    }

    let parsed = null;
    try {
      parsed = extractJson(raw);
    } catch {
      parsed = null;
    }
    const decision = normalizeTradingDecision(parsed);

    if (debug) {
      return res.json({
        pre_filter,
        skip_pre_filter_applied: skipPreFilter,
        payloadForLLM,
        decision,
        raw_model_text: raw
      });
    }
    return res.json(decision);
  } catch (error) {
    return res.status(500).json(
      normalizeTradingDecision({
        action: "NO_TRADE",
        why: ["LLM decision failed: " + (error.message || String(error))]
      })
    );
  }
});

/**
 * POST /decide-pipeline
 * Body: { symbol, provider?, previewSteps?, runPipeline?, skipPreFilter?, debug?, filterOverrides? }
 * previewSteps default true: returns 6 request JSONs (agents 1–5 + Trade Planner) + logs to console.
 * runPipeline: runs 6 LLM steps (cost). Blocked if pre_filter fails unless skipPreFilter. Response includes trade_plan.
 */
app.post("/decide-pipeline", async (req, res) => {
  const symbol = (req.body && req.body.symbol) || "QQQ";
  const provider = (req.body && req.body.provider) || "chatgpt";
  const previewSteps = req.body?.previewSteps !== false;
  const runPipeline = !!(req.body && req.body.runPipeline);
  const skipPreFilter = !!(req.body && req.body.skipPreFilter);
  const debug = !!(req.body && req.body.debug);
  const filterOverrides = (req.body && req.body.filterOverrides) || {};

  try {
    const context = await buildDecisionContext(symbol);
    const { payload: payloadForLLM } = buildPayloadForLLMFromContext(context, debug);

    const pre_filter = evaluatePreFilter(payloadForLLM, filterOverrides);
    const five_step_requests = buildFiveStepRequestBodies(payloadForLLM, {
      providerModelHint: provider
    });

    if (previewSteps) {
      for (const stepReq of five_step_requests) {
        console.log("\n========== PIPELINE STEP", stepReq.step, stepReq.agent, "==========");
        console.log(JSON.stringify(stepReq, null, 2));
      }
    }

    const out = {
      symbol,
      pre_filter,
      five_step_requests,
      note: "Six steps: validators 1–5 + Agent 6 Trade Planner (activation_levels, long_plan, short_plan). Full JSON in each user message. Terminal logs all six."
    };

    if (!runPipeline) {
      return res.json(out);
    }

    if (!pre_filter.pass && !skipPreFilter) {
      return res.json({
        ...out,
        pipeline_skipped: true,
        hard_stop_before_agent1: true,
        skip_reason: "pre_filter_failed",
        orchestrator_note:
          "No LLM calls: score / priority / alignment / location / trade_block failed hard gates.",
        decision: normalizeTradingDecision({
          action: "NO_TRADE",
          why: ["hard_stop_pre_agent1: " + pre_filter.reasons.join("; ")]
        })
      });
    }

    const {
      results,
      merged,
      trade_plan,
      aborted_after_agent1,
      hard_stopped_before_agents,
      pre_filter: preFilterInsideRun
    } = await runFiveStepPipeline(payloadForLLM, {
      callLLM: ({ system, user }) =>
        askTradingPipelineStep(provider, { systemPrompt: system, userPrompt: user }),
      skipHardStop: skipPreFilter,
      filterOverrides
    });

    const decision = normalizeTradingDecision({
      action: merged.action,
      entry: merged.entry,
      sl: merged.sl,
      tp: merged.tp,
      confidence: merged.confidence,
      reason: merged.reason,
      risk_level: merged.risk_level,
      why: merged.why,
      next_trigger: merged.next_trigger
    });
    if (trade_plan != null) decision.trade_plan = trade_plan;

    return res.json({
      ...out,
      pipeline_skipped: false,
      hard_stopped_before_agents: !!hard_stopped_before_agents,
      aborted_after_agent1: !!aborted_after_agent1,
      /** @deprecated use aborted_after_agent1 */
      aborted_after_setup: !!aborted_after_agent1,
      pre_filter_inside_run: preFilterInsideRun || null,
      orchestrator_step: merged.pipeline_meta?.orchestrator_step ?? null,
      orchestrator_blockers: merged.pipeline_meta?.blockers ?? [],
      step_results: results,
      trade_plan,
      decision,
      pipeline_raw_merge: merged
    });
  } catch (error) {
    console.error("[decide-pipeline]", error);
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// GET /yahoo?ticker=QQQ
app.get("/yahoo", async (req, res) => {
  const ticker = (req.query.ticker || "QQQ").trim();
  try {
    const data = await getMultiTimeframeYahoo(ticker);
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

/**
 * GET /file?name=xxx.png
 * Serves a file from the screenshots folder
 */
app.get("/file", (req, res) => {
  const fileName = req.query.name;
  const baseDir = path.join(__dirname, "screenshots");

  if (!fileName) {
    return res.status(400).json({
      success: false,
      error: "Missing query param: name"
    });
  }

  const filePath = path.join(baseDir, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      error: "File not found"
    });
  }

  return res.sendFile(filePath);
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other process or run with a different port, e.g.:\n` +
        `  set PORT=3001 && node server.js   (PowerShell: $env:PORT=3001; node server.js)`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});