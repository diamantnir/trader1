/**
 * MTF liquidity map: equal highs/lows + nearest targets vs last price.
 * target_reason + distance explain the nearest liquidity magnet vs reference_price.
 */

function n4(x) {
  const v = Number(x);
  return Number.isFinite(v) ? Number(v.toFixed(4)) : null;
}

function collectPrices(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((x) => (x && Number.isFinite(Number(x.price)) ? Number(x.price) : null))
    .filter((p) => p != null);
}

function uniqSorted(nums, max = 18) {
  const u = [...new Set(nums.filter(Number.isFinite))].sort((a, b) => a - b);
  return u.slice(0, max).map(n4);
}

/**
 * @param {object} opts
 * @param {object} opts.daily - analyzeSymbol output
 * @param {object} opts.hourly
 * @param {object} opts.min5
 * @param {number} opts.lastClose
 * @param {object|null} opts.liquidityTarget - feature last_bar.liquidity_target
 */
function buildLiquidityMap({ daily, hourly, min5, lastClose, liquidityTarget = null }) {
  const h1 = collectPrices(daily?.liquidity?.equal_highs);
  const h2 = collectPrices(hourly?.liquidity?.equal_highs);
  const h3 = collectPrices(min5?.liquidity?.equal_highs);
  const l1 = collectPrices(daily?.liquidity?.equal_lows);
  const l2 = collectPrices(hourly?.liquidity?.equal_lows);
  const l3 = collectPrices(min5?.liquidity?.equal_lows);

  const equal_highs = uniqSorted([...h1, ...h2, ...h3], 20);
  const equal_lows = uniqSorted([...l1, ...l2, ...l3], 20);

  const px = Number(lastClose);
  const above = Number.isFinite(px) ? equal_highs.filter((h) => h > px) : [];
  const below = Number.isFinite(px) ? equal_lows.filter((l) => l < px) : [];

  const target_above = above.length ? Math.min(...above) : null;
  const target_below = below.length ? Math.max(...below) : null;

  const distance_to_target_above =
    Number.isFinite(px) && target_above != null ? n4(target_above - px) : null;
  const distance_to_target_below =
    Number.isFinite(px) && target_below != null ? n4(px - target_below) : null;

  let nearest_liquidity = "unknown";
  if (Number.isFinite(px) && target_above != null && target_below != null) {
    const da = target_above - px;
    const db = px - target_below;
    nearest_liquidity = da <= db ? "above" : "below";
  } else if (target_above != null) nearest_liquidity = "above";
  else if (target_below != null) nearest_liquidity = "below";

  let target_reason = null;
  let distance = null;
  if (nearest_liquidity === "above" && distance_to_target_above != null) {
    target_reason = "equal_highs_cluster";
    distance = distance_to_target_above;
  } else if (nearest_liquidity === "below" && distance_to_target_below != null) {
    target_reason = "equal_lows_cluster";
    distance = distance_to_target_below;
  }

  const engine =
    liquidityTarget && Number.isFinite(Number(liquidityTarget.target_price))
      ? {
          target_price: n4(liquidityTarget.target_price),
          direction: liquidityTarget.direction ?? null,
          pattern: liquidityTarget.pattern ?? null,
          reason: "feature_engine_liquidity_target"
        }
      : null;

  return {
    equal_highs,
    equal_lows,
    target_above: target_above != null ? n4(target_above) : null,
    target_below: target_below != null ? n4(target_below) : null,
    distance_to_target_above,
    distance_to_target_below,
    nearest_liquidity,
    target_reason,
    distance,
    reference_price: Number.isFinite(px) ? n4(px) : null,
    engine_liquidity: engine
  };
}

module.exports = { buildLiquidityMap };
