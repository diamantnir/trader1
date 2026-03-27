const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// Save in project folder so files are easy to find
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "screenshots");

async function ensureDir(dirPath) {
  const absoluteDir = path.isAbsolute(dirPath) ? dirPath : path.resolve(process.cwd(), dirPath);
  if (!fs.existsSync(absoluteDir)) {
    fs.mkdirSync(absoluteDir, { recursive: true });
  }
  return absoluteDir;
}

function buildFileName(symbol, timeframe) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return `${symbol.replace(/[:/\\]/g, "_")}_${timeframe}_${yyyy}${mm}${dd}_${hh}${mi}${ss}.png`;
}

async function captureTradingViewChart({
  url = "https://www.tradingview.com/chart/",
  symbol = "NASDAQ:QQQ",
  timeframe = "5",
  outputDir = DEFAULT_OUTPUT_DIR,
  headless = false,
  useExistingChrome = false,
  debuggingPort = 9222
} = {}) {
  const absoluteOutputDir = await ensureDir(outputDir);

  let browser;
  let page;

  if (useExistingChrome) {
    const cdpUrl = `http://127.0.0.1:${debuggingPort}`;
    console.log(`Connecting to your Chrome at ${cdpUrl}…`);
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (err) {
      if (err.message && err.message.includes("ECONNREFUSED")) {
        throw new Error(
          "Chrome is not running with remote debugging. Close Chrome completely, then start it with: " +
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222'
        );
      }
      throw err;
    }
    const context = browser.contexts()[0] || await browser.newContext();
    page = await context.newPage();
    await page.setViewportSize({ width: 1600, height: 900 });
  } else {
    browser = await chromium.launch({
      headless,
      channel: "chrome"
    });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 }
    });
    page = await context.newPage();
  }

  try {
    const chartUrl = new URL(url);
    chartUrl.searchParams.set("symbol", symbol);
    chartUrl.searchParams.set("interval", timeframe);
    const fullUrl = chartUrl.toString();
    console.log(`Opening TradingView: ${fullUrl}`);
    await page.goto(fullUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });

    await page.waitForTimeout(8000);

    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[data-name="close"]',
      'button[title="Close"]'
    ];

    for (const selector of dismissSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        try {
          await page.locator(selector).first().click({ timeout: 1000 });
          await page.waitForTimeout(500);
        } catch (err) {
          // ignore
        }
      }
    }

    const fileName = buildFileName(symbol, timeframe);
    const fullPath = path.join(absoluteOutputDir, fileName);

    await page.screenshot({
      path: fullPath,
      fullPage: false
    });

    if (!fs.existsSync(fullPath)) {
      throw new Error("Screenshot was not saved to disk: " + fullPath);
    }

    console.log("Saved:", fullPath);
    return {
      success: true,
      symbol,
      timeframe,
      path: fullPath,
      fileName
    };
  } catch (error) {
    return {
      success: false,
      symbol,
      timeframe,
      error: error.message || String(error)
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  captureTradingViewChart
};