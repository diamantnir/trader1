/**
 * Slim LLM pipeline: smart_money_layer, execution_state, triggers, final_decision_context.
 * Single trade gate surface: final_decision_context.trade_block { active, reasons }.
 */

const BLOCKED = {
  long: { valid: false, blocked_reason: "execution_permission_false" },
  short: { valid: false, blocked_reason: "execution_permission_false" }
};

function buildPayload({
  symbol,
  smartMoney,
  executionState,
  triggers,
  liquidity_map,
  score,
  execution_permission,
  final_decision_context
}) {
  let sm = smartMoney;
  if (sm && execution_permission === false && sm.execution) {
    sm = {
      ...sm,
      execution: {
        ...sm.execution,
        candidates: BLOCKED,
        safe_candidates: null
      }
    };
  }

  return {
    symbol,
    timestamp: new Date().toISOString(),

    smart_money_layer: sm,
    execution_state: executionState,
    liquidity_map: liquidity_map ?? null,
    score: score ?? null,
    triggers,
    ...(final_decision_context ? { final_decision_context } : {}),

    instructions:
      "Single gate: final_decision_context.trade_block. Score: score.total, score.max, score.grade, score.engagement. Liquidity: liquidity_map.target_reason + distance (nearest cluster). Triggers: only breakout, fvg_entry, reversal. execution_state.setup_alignment. When trade_block.active === false, the pipeline is not in hard stand-down (still respect mode + hard_constraints)."
  };
}

module.exports = { buildPayload };
