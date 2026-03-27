/**
 * Feature engine V5 — uses the V4 computation core with V5 defaults and options.
 * Server passes volumeAsPenaltyOnly: true when hard_constraints.ignore_volume (Yahoo / bad series).
 * Structural setup inference (range_fvg_discount, etc.) lives in featureEngineV4.js.
 */

const { featureEngineV4 } = require("./featureEngineV4");

function featureEngineV5(bars, options = {}) {
  return featureEngineV4(bars, options);
}

module.exports = { featureEngineV5 };
