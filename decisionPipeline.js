/**
 * Pre-filter + core agents (1–5) + Agent 6 Trade Planner (always when LLM runs past hard stop).
 *
 * HARD STOP: No LLM until evaluatePreFilter passes.
 * Agent 1: only VALID continues agents 2–5; Agent 6 still runs to produce long_plan / short_plan / activation_levels.
 */

const PIPELINE_FILTER_DEFAULTS = {
  minScoreTotal: 60,
  minSetupPriority: "medium",
  minAlignmentScore: 0.6,
  requireNoMtfConflict: true,
  requireLocationMatch: true
};

function priorityRank(p) {
  const x = String(p || "low").toLowerCase();
  if (x === "high") return 3;
  if (x === "medium") return 2;
  return 1;
}

function evaluatePreFilter(payload, opts = {}) {
  const cfg = { ...PIPELINE_FILTER_DEFAULTS, ...opts };
  const reasons = [];
  const checks = {};

  const pipe = payload?.decision_smart_pipeline || {};
  const scoreTotal = Number(pipe.score?.total);
  checks.score_total = Number.isFinite(scoreTotal) ? scoreTotal : null;
  if (!Number.isFinite(scoreTotal) || scoreTotal < cfg.minScoreTotal) {
    reasons.push(
      `score.total ${Number.isFinite(scoreTotal) ? scoreTotal : "missing"} < ${cfg.minScoreTotal}`
    );
  }

  const priority = pipe.smart_money_layer?.setup?.priority ?? "low";
  checks.setup_priority = priority;
  const minRank = priorityRank(cfg.minSetupPriority);
  if (priorityRank(priority) < minRank) {
    reasons.push(`setup.priority "${priority}" below required "${cfg.minSetupPriority}"+`);
  }

  const align = Number(payload?.mtf_summary?.alignment_score);
  checks.alignment_score = Number.isFinite(align) ? align : null;
  if (!Number.isFinite(align) || align < cfg.minAlignmentScore) {
    reasons.push(
      `mtf_summary.alignment_score ${Number.isFinite(align) ? align : "missing"} < ${cfg.minAlignmentScore}`
    );
  }

  const conflict = !!payload?.mtf_summary?.conflict;
  checks.mtf_conflict = conflict;
  if (cfg.requireNoMtfConflict && conflict) {
    reasons.push("mtf_summary.conflict is true");
  }

  const locMatch = pipe.execution_state?.setup_alignment?.location_match;
  checks.location_match = locMatch;
  if (cfg.requireLocationMatch && locMatch !== true) {
    reasons.push(
      `execution_state.setup_alignment.location_match is not true (got ${JSON.stringify(locMatch)})`
    );
  }

  const tradeBlock = pipe.final_decision_context?.trade_block;
  checks.trade_block_active = tradeBlock?.active;
  if (tradeBlock?.active === true) {
    reasons.push("trade_block.active is true (hard stand-down)");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    checks,
    thresholds_used: cfg
  };
}

function buildMarketUserBlock(payload) {
  return `COMPLETE_MARKET_JSON (identical for every pipeline step — all context is here):\n\n${JSON.stringify(payload, null, 2)}`;
}

/** Agents 1–5 — validators / decision stack */
const CORE_STEP_DEFS = [
  {
    key: "trend_setup",
    agent: "Agent_1_Trend_Setup",
    system: `You are Agent 1 — Trend + Setup. You ONLY output valid JSON, no markdown.
Use the full market JSON: mtf_summary, decision_smart_pipeline.smart_money_layer, feature_engine_v5, trade_block, score, liquidity_map, triggers.

Schema:
{"dominant_trend":"bullish"|"bearish"|"range","setup_verdict":"VALID"|"WEAK"|"INVALID","one_line":"<one English sentence>"}

Rules:
- VALID = only if there is a clear, tradable SMC setup worth risking capital (named setup, coherent structure). Downstream pipeline ONLY runs on VALID.
- WEAK = marginal / unclear — same effect as do-not-trade for the pipeline (orchestrator rejects non-VALID).
- INVALID = no real setup or noise / stand-down context.`
  },
  {
    key: "execution",
    agent: "Agent_2_Execution",
    system: `You are Agent 2 — Execution / timing. JSON only, no markdown.
Use triggers (breakout, fvg_entry, reversal), execution_state, recent_bars_5m, entry_model_context.

Schema:
{"trigger_now":"YES"|"NO","one_line":"<one sentence>"}

YES only if a concrete trigger in the JSON is plausible RIGHT NOW (not hypothetical far away).`
  },
  {
    key: "risk",
    agent: "Agent_3_Risk",
    system: `You are Agent 3 — Risk / RR. JSON only, no markdown.
Use global_trade_candidates, expected_move, adaptive_context / min_rr, hard_constraints.

Schema:
{"rr_verdict":"GOOD"|"BAD","one_line":"<one sentence>"}

BAD if RR clearly poor vs min_rr_required or data too weak (ignore_volume, low score grade).`
  },
  {
    key: "decision",
    agent: "Agent_4_Decision",
    system: `You are Agent 4 — Decision. JSON only, no markdown.
If prior steps in the conversation summary are not available, use ONLY the JSON.

Schema:
{"action":"LONG"|"SHORT"|"NO_TRADE","entry":<number|null>,"sl":<number|null>,"tp":<number|null>,"confidence":<0..1>}

Prices must come from the JSON or null.`
  },
  {
    key: "killer",
    agent: "Agent_5_Killer",
    system: `You are Agent 5 — Devil's advocate. JSON only, no markdown.
List the strongest reasons NOT to trade (conflicts, chop, bad location, killer risks).

Schema:
{"strength":"low"|"medium"|"high"|"strong","reasons_not_to_trade":["..."],"deal_breaker":<true|false>}

Use "strong" or "high" when reasons are severe enough to block a trade. deal_breaker true = hard veto.`
  }
];

/** Agent 6 — planner: concrete levels even when status is NO_TRADE */
const TRADE_PLANNER_DEF = {
  key: "trade_planner",
  agent: "Agent_6_Trade_Planner",
  system: `You are Agent 6 — Trade Planner. You ONLY output valid JSON, no markdown.

You are NOT a yes/no validator only: you MUST produce actionable PRICE PLANS using ONLY numbers that exist in COMPLETE_MARKET_JSON (triggers.breakout / fvg_entry / reversal, liquidity_map, execution_state, global_trade_candidates, feature_engine_v5 last_bar FVG, targets, recent_bars_5m).

Schema (all required keys must appear):
{
  "status": "NO_TRADE" | "TRADE",
  "activation_levels": { "long": <number|null>, "short": <number|null> },
  "long_plan": {
    "entry_if": "<string: exact condition e.g. break and hold above X>",
    "reason": "<string: tie to liquidity / FVG / structure from JSON>",
    "entry_zone": [<number>, <number>] | null,
    "sl": <number|null>,
    "tp": <number|null>
  },
  "short_plan": {
    "entry_if": "<string>",
    "reason": "<string>",
    "entry_zone": [<number>, <number>] | null,
    "sl": <number|null>,
    "tp": <number|null>
  },
  "planner_one_line": "<string>"
}

Rules:
- If status is NO_TRADE: still fill long_plan and short_plan with the EXACT price conditions under which a trade WOULD become valid (entry_if, entry_zone, sl, tp from data).
- If status is TRADE: set entry_zone/sl/tp for the favoured side to the live plan; the other side can be hypothetical or null zones if unclear.
- activation_levels.long = primary level that must break/reclaim for long interest (e.g. triggers.breakout.long.break or range_high from execution_state).
- activation_levels.short = primary level for short interest (e.g. triggers.breakout.short.break or range_low).
- NEVER invent prices: every numeric field must be traceable to fields in the JSON (round to 4 decimals when needed).
- You will receive ORCHESTRATOR_PIPELINE_HINT: align status with it when sensible, but numbers still MUST come from MARKET JSON.`
};

/** Full ordered list (for exports / request builder) */
const STEP_DEFS = [...CORE_STEP_DEFS, TRADE_PLANNER_DEF];

function stepUserTask(stepKey) {
  const tasks = {
    trend_setup:
      "Task: State dominant MTF trend, then classify setup as VALID, WEAK, or INVALID. One line summary.",
    execution:
      "Task: Is there a real entry trigger NOW (YES/NO)? Reference specific prices/levels from the JSON.",
    risk: "Task: Is risk/reward GOOD or BAD for a discretionary scalp/swing from this payload?",
    decision:
      "Task: If you would take a trade, output LONG or SHORT with entry/sl/tp from the data; else NO_TRADE.",
    killer: "Task: Argue against the trade. Set deal_breaker true if the trade should be blocked.",
    trade_planner:
      "Task: Build full long_plan and short_plan with numeric levels from JSON. Set status NO_TRADE or TRADE to match ORCHESTRATOR_PIPELINE_HINT. Always output activation_levels.long and activation_levels.short when inferable from triggers/liquidity/range."
  };
  return tasks[stepKey] || tasks.trend_setup;
}

/**
 * Six self-contained request objects (same full market JSON in each user message).
 */
function buildPipelineStepRequestBodies(payload, { providerModelHint } = {}) {
  const marketBlock = buildMarketUserBlock(payload);
  return STEP_DEFS.map((def, i) => {
    const extra =
      def.key === "trade_planner"
        ? `\n\n---\n\nORCHESTRATOR_PIPELINE_HINT (placeholder in preview — server injects real hint after agents 1–5 when runPipeline runs):\n{"pipeline_outcome":"NO_TRADE","note":"see live /decide-pipeline response"}`
        : "";
    const user = `${marketBlock}${extra}\n\n---\n\nSTEP ${i + 1} — ${def.agent}\n${stepUserTask(def.key)}`;
    return {
      step: i + 1,
      agent: def.agent,
      key: def.key,
      provider_hint: providerModelHint || "chatgpt | gemini",
      openai_chat_completions: {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: def.system },
          { role: "user", content: user }
        ],
        temperature: def.key === "trade_planner" ? 0.3 : 0.25,
        max_tokens: def.key === "trade_planner" ? 1400 : 800
      },
      gemini_generateContent: {
        note: "Send as single user text: SYSTEM + --- + USER.",
        system: def.system,
        user
      },
      market_json_byte_length: Buffer.byteLength(JSON.stringify(payload), "utf8")
    };
  });
}

/** @deprecated use buildPipelineStepRequestBodies */
function buildFiveStepRequestBodies(payload, opts) {
  return buildPipelineStepRequestBodies(payload, opts);
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

function orchestratePipelineDecision(parsed) {
  const ts = parsed.trend_setup || {};
  const ex = parsed.execution || {};
  const rk = parsed.risk || {};
  const dc = parsed.decision || {};
  const k = parsed.killer || {};

  const noTrade = (orchestrator_step, detail) => ({
    action: "NO_TRADE",
    entry: null,
    sl: null,
    tp: null,
    confidence: 0,
    reason: [],
    risk_level: "high",
    why: [`orchestrator:${orchestrator_step} — ${detail}`],
    next_trigger: null,
    pipeline_meta: {
      orchestrator_step,
      blockers: [orchestrator_step],
      raw_steps: parsed
    }
  });

  const verdict = String(ts.setup_verdict || "").toUpperCase();
  if (verdict !== "VALID") {
    return noTrade(
      "agent1_setup",
      `setup_verdict must be VALID (got ${verdict || "missing"})`
    );
  }

  if (String(ex.trigger_now || "").toUpperCase() !== "YES") {
    return noTrade("agent2_execution", "trigger_now must be YES");
  }

  if (String(rk.rr_verdict || "").toUpperCase() !== "GOOD") {
    return noTrade("agent3_risk", "rr_verdict must be GOOD");
  }

  const killerStrength = String(k.strength || "low").toLowerCase();
  if (killerStrength === "high" || killerStrength === "strong") {
    return noTrade("agent5_killer", `killer strength is STRONG (${killerStrength})`);
  }
  if (k.deal_breaker === true) {
    return noTrade("agent5_killer", "deal_breaker is true");
  }

  const action = String(dc.action || "NO_TRADE").toUpperCase();
  if (action === "LONG" || action === "SHORT") {
    return {
      action,
      entry: typeof dc.entry === "number" ? dc.entry : null,
      sl: typeof dc.sl === "number" ? dc.sl : null,
      tp: typeof dc.tp === "number" ? dc.tp : null,
      confidence: typeof dc.confidence === "number" ? Math.min(1, Math.max(0, dc.confidence)) : 0.5,
      reason: ["orchestrator: all gates passed; using Agent_4 decision"],
      risk_level: "medium",
      why: null,
      next_trigger: null,
      pipeline_meta: {
        orchestrator_step: "agent4_decision",
        blockers: [],
        raw_steps: parsed
      }
    };
  }

  return noTrade("agent4_decision", "action was not LONG or SHORT");
}

function mergePipelineToDecision(parsed) {
  return orchestratePipelineDecision(parsed);
}

function hardStopDecisionFromPreFilter(preFilter) {
  return {
    action: "NO_TRADE",
    entry: null,
    sl: null,
    tp: null,
    confidence: 0,
    reason: [],
    risk_level: "high",
    why: [`hard_stop_before_agent1: ${preFilter.reasons.join("; ")}`],
    next_trigger: null,
    pipeline_meta: {
      orchestrator_step: "hard_stop_pre_llm",
      blockers: ["hard_stop_pre_llm"],
      pre_filter: preFilter,
      raw_steps: null
    }
  };
}

function buildPlannerUserMessage(payload, orchestratorHint) {
  const hintBlock = `\n\n---\n\nORCHESTRATOR_PIPELINE_HINT (align status with this when sensible; every price MUST still come from COMPLETE_MARKET_JSON):\n${JSON.stringify(orchestratorHint, null, 2)}`;
  const stepNum = CORE_STEP_DEFS.length + 1;
  return `${buildMarketUserBlock(payload)}${hintBlock}\n\n---\n\nSTEP ${stepNum} — ${TRADE_PLANNER_DEF.agent}\n${stepUserTask(TRADE_PLANNER_DEF.key)}`;
}

async function runTradePlannerStep(callLLM, payload, orchestratorHint) {
  const user = buildPlannerUserMessage(payload, orchestratorHint);
  const text = await callLLM({ system: TRADE_PLANNER_DEF.system, user });
  return { raw: text, json: extractJsonObject(text) };
}

/**
 * @returns {Promise<{ results, merged, trade_plan, aborted_after_agent1?, hard_stopped_before_agents?, pre_filter? }>}
 */
async function runFiveStepPipeline(payload, { callLLM, skipHardStop = false, filterOverrides = {} } = {}) {
  if (!skipHardStop) {
    const pre_filter = evaluatePreFilter(payload, filterOverrides);
    if (!pre_filter.pass) {
      const merged = hardStopDecisionFromPreFilter(pre_filter);
      return {
        results: {},
        merged,
        trade_plan: null,
        hard_stopped_before_agents: true,
        pre_filter,
        aborted_after_agent1: false
      };
    }
  }

  const results = {};
  let abortedAfterAgent1 = false;

  for (let i = 0; i < CORE_STEP_DEFS.length; i++) {
    const def = CORE_STEP_DEFS[i];
    const user = `${buildMarketUserBlock(payload)}\n\n---\n\nSTEP ${i + 1} — ${def.agent}\n${stepUserTask(def.key)}`;
    const text = await callLLM({ system: def.system, user });
    const json = extractJsonObject(text);
    results[def.key] = { raw: text, json };

    if (def.key === "trend_setup") {
      const v = String(json?.setup_verdict || "").toUpperCase();
      if (v !== "VALID") {
        abortedAfterAgent1 = true;
        break;
      }
    }
  }

  let merged;
  let orchestratorHint;

  if (abortedAfterAgent1) {
    const got = String(results.trend_setup?.json?.setup_verdict || "missing").toUpperCase();
    merged = {
      action: "NO_TRADE",
      entry: null,
      sl: null,
      tp: null,
      confidence: 0,
      reason: [],
      risk_level: "high",
      why: [
        `pipeline_aborted_after_agent1: setup_verdict must be VALID (got ${got}; agents 2–5 skipped; Agent 6 planner still runs)`
      ],
      next_trigger: null,
      pipeline_meta: {
        orchestrator_step: "agent1_setup",
        blockers: ["early_abort_setup_not_VALID"],
        raw_steps: {
          trend_setup: results.trend_setup?.json,
          execution: null,
          risk: null,
          decision: null,
          killer: null
        },
        step_raw: results
      }
    };
    orchestratorHint = {
      pipeline_outcome: "NO_TRADE",
      reason: "agent1_setup_verdict_not_VALID",
      setup_verdict: got,
      note: "Still produce long_plan and short_plan with exact activation levels for if-then entries."
    };
  } else {
    merged = orchestratePipelineDecision({
      trend_setup: results.trend_setup?.json,
      execution: results.execution?.json,
      risk: results.risk?.json,
      decision: results.decision?.json,
      killer: results.killer?.json
    });
    orchestratorHint = {
      pipeline_outcome: merged.action,
      orchestrator_why: merged.why,
      orchestrator_entry: merged.entry,
      orchestrator_sl: merged.sl,
      orchestrator_tp: merged.tp,
      agent4: results.decision?.json,
      note: "If pipeline_outcome is LONG or SHORT, status TRADE in planner should match; still define both sides' if-then levels where useful."
    };
  }

  results.trade_planner = await runTradePlannerStep(callLLM, payload, orchestratorHint);

  merged.pipeline_meta = merged.pipeline_meta || {};
  merged.pipeline_meta.step_raw = results;
  merged.pipeline_meta.trade_plan = results.trade_planner?.json ?? null;

  const trade_plan = results.trade_planner?.json ?? null;

  return {
    results,
    merged,
    trade_plan,
    aborted_after_agent1,
    hard_stopped_before_agents: false
  };
}

module.exports = {
  PIPELINE_FILTER_DEFAULTS,
  evaluatePreFilter,
  buildPipelineStepRequestBodies,
  buildFiveStepRequestBodies,
  buildMarketUserBlock,
  CORE_STEP_DEFS,
  TRADE_PLANNER_DEF,
  STEP_DEFS,
  orchestratePipelineDecision,
  mergePipelineToDecision,
  hardStopDecisionFromPreFilter,
  extractJsonObject,
  runFiveStepPipeline
};
