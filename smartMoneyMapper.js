/**
 * Maps feature engine last_bar → compact smart-money view for the LLM (V5 pipeline).
 * No confluence/conflict_alert here — use decision_smart_pipeline.score + trade_block only.
 */

function setupPriority(feature) {
  const type = feature.setup?.type || "none";
  const q = feature.setup_analysis?.setup_quality;
  const c = Number(feature.setup?.confidence);
  if (type === "none") return "low";
  if (q === "strong" && Number.isFinite(c) && c >= 0.55) return "high";
  if (q === "strong" || (Number.isFinite(c) && c >= 0.45)) return "medium";
  if (q === "moderate") return "medium";
  return "low";
}

function mapFeatureToLLM(feature) {
  if (!feature) return null;

  return {
    setup: {
      type: feature.setup?.type || "none",
      quality: feature.setup_analysis?.setup_quality,
      priority: setupPriority(feature),
      reasons: feature.setup?.reasons || []
    },

    structure: {
      state: feature.structure_state,
      bos: feature.bos,
      choch: feature.choch,
      sweep_low: feature.sweep_low,
      sweep_high: feature.sweep_high
    },

    micro_structure: feature.micro_structure ?? null,
    market_regime: feature.market_regime ?? null,

    smart_money: {
      pd_zone: feature.pd_array?.zone,
      fvg: feature.fvg,
      order_block: feature.order_block
    },

    intent: feature.intent,

    execution: {
      candidates: feature.trade_candidates,
      safe_candidates: feature.safe_trade_candidates ?? null
    },

    adaptive_context: feature.adaptive_context ?? null
  };
}

module.exports = { mapFeatureToLLM, setupPriority };
