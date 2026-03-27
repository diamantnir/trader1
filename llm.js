const axios = require("axios");

/**
 * System prompt: instructs the model how to read the payload and what JSON to emit.
 */
const TRADING_SYSTEM_PROMPT = `You are an elite discretionary trader assistant. You ONLY output valid JSON — no markdown, no prose outside the JSON.

READ ORDER (important)
0) decision_smart_pipeline — PRIMARY: final_decision_context.trade_block, score (total/max/grade/engagement), liquidity_map (target_reason + distance), smart_money_layer, execution_state, triggers.
1) trade_block — ONLY “do not trade” list inside the pipeline (active + reasons). Do not hunt for other duplicate block lists.
2) score — total (0–max), grade (A–F), engagement; blend of setup/structure/location vs conflict pressure (not raw additive parts in payload).
3) liquidity_map — target_reason (equal_highs_cluster | equal_lows_cluster) + distance to nearest magnet; also target_above/below and distance_to_target_*.
4) triggers — only breakout, fvg_entry, reversal (+ context). breakout.long/short = break + retest at break; fvg_entry = FVG zones; reversal = sweeps.
5) execution_state.setup_alignment — whether price_location matches discount/premium setup context.
6) hard_constraints — ignore_volume ⇒ no volume-based conviction.
7) setup_presence (root when allowed) — priority + quality + type.
8) smart_money_layer.setup.priority — how much attention the setup deserves (low/medium/high).
9) recent_bars_5m, entry_model_context, global_trade_candidates / feature_engine_v5 trade_candidates as before.

OTHER FIELDS
- mtf_summary: biases + alignment_score.
- expected_move: only when tradable (see extra root fields when allowed).
- timeframes.*.volume_context.
- debug payloads may include execution_permission, signal_conflicts, decision_context — slim payloads omit them; use trade_block only.

YOUR TASK
1) Read the FULL JSON (not one field in isolation).
2) If final_decision_context.mode is NO_TRADE or trade_block.active is true (or root execution_permission === false in debug payloads), output NO_TRADE unless you document an extraordinary exception in why (almost never).
3) If a trade is justified under the gates above, output LONG or SHORT with concrete prices from context (entry_model_context, candidates, execution_state, last bar close in recent_bars_5m.data, levels).
4) Otherwise NO_TRADE with why and next_trigger for BOTH sides.

OUTPUT — EXACTLY ONE of the two shapes below (root object, NOT wrapped in "decision").

=== WHEN YOU CHOOSE A TRADE ===
{
  "action": "LONG",
  "entry": <number | null>,
  "sl": <number | null>,
  "tp": <number | null>,
  "confidence": <number 0..1, e.g. 0.78>,
  "reason": ["short bullet", "..."],
  "risk_level": "low" | "medium" | "high"
}
Use "SHORT" instead of "LONG" when bearish. All numeric fields must be numbers or null (never strings).

=== WHEN YOU CHOOSE NO TRADE ===
{
  "action": "NO_TRADE",
  "entry": null,
  "sl": null,
  "tp": null,
  "confidence": 0,
  "reason": [],
  "risk_level": "high",
  "why": ["why now is not the time", "..."],
  "next_trigger": [
    {
      "for_side": "LONG",
      "wait_for": [
        "Observable conditions to allow long, e.g. decision_context.tradable === true and execution_permission === true",
        "5m close above <price> / reclaim VWAP with volume_percentile above engine threshold",
        "clear bullish structure: triggers.breakout.long + triggers.fvg_entry.long; liquidity_map.target_reason / distance"
      ]
    },
    {
      "for_side": "SHORT",
      "wait_for": [
        "trade_block.active false; score.total / score.grade support engagement",
        "5m close below <price> / rejection at premium + bearish displacement",
        "triggers.breakout.short + fvg_entry.short vs liquidity_map target_below"
      ]
    }
  ]
}

RULES
- action MUST be exactly "LONG", "SHORT", or "NO_TRADE" (uppercase).
- For NO_TRADE: always include non-empty why (array) and next_trigger with BOTH for_side LONG and SHORT, each with at least 2 concrete wait_for strings tied to fields in the payload (prices, tradable, volume, conflicts, sessions).
- If trade_block.active is true or final_decision_context.mode is NO_TRADE (or execution_permission false when that field exists), default to NO_TRADE.
- If hard_constraints.ignore_volume is true, never cite volume as a reason to take risk; structure/price only, lower confidence.
- Do not invent prices: anchor entry/sl/tp to numbers present in the JSON (candidates, levels, recent_bars_5m.data, execution_state, entry_model_context) or null if impossible.
- confidence for trades: 0..1; keep below 0.55 if data_quality is weak or ignore_volume is true.
- Return ONLY the JSON object. No code fences.`;

/**
 * Normalize LLM JSON to a single canonical shape for the API.
 * Accepts new flat format or legacy { decision: { ... } }.
 */
function normalizeTradingDecision(obj) {
  const defaultNoTrade = (whyText, nextTrigger = null) => ({
    action: "NO_TRADE",
    entry: null,
    sl: null,
    tp: null,
    confidence: 0,
    reason: [],
    risk_level: "high",
    why: Array.isArray(whyText) ? whyText : [String(whyText || "no_trade")],
    next_trigger:
      nextTrigger ||
      [
        {
          for_side: "LONG",
          wait_for: [
            "decision_smart_pipeline.final_decision_context.trade_block.active === false and mode === TRADE_ALLOWED",
            "execution_permission === true when field present on root payload",
            "if hard_constraints.ignore_volume === true: structure/triggers only, lower confidence (no volume-based conviction)"
          ]
        },
        {
          for_side: "SHORT",
          wait_for: [
            "decision_smart_pipeline.final_decision_context.trade_block.active === false",
            "score.grade / score.total align with mtf_summary if relevant",
            "bearish displacement or triggers.fvg_entry.short / breakout.short vs liquidity_map"
          ]
        }
      ]
  });

  const defaultBadParse = () =>
    defaultNoTrade(["Model returned invalid or non-JSON content."]);

  if (!obj || typeof obj !== "object") return defaultBadParse();

  const toNum = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const toStrArray = (x) => {
    if (Array.isArray(x)) return x.map((s) => String(s));
    if (typeof x === "string" && x.trim()) return [x.trim()];
    return [];
  };

  const normConf = (c) => {
    let n = Number(c);
    if (!Number.isFinite(n)) return 0;
    if (n > 1) n = n / 100;
    return Math.min(1, Math.max(0, Number(n.toFixed(4))));
  };

  const normAction = (a) => {
    const s = String(a || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    if (s === "LONG" || s === "BUY") return "LONG";
    if (s === "SHORT" || s === "SELL") return "SHORT";
    if (s === "NO_TRADE" || s === "NOTRADE" || s === "FLAT" || s === "NONE") return "NO_TRADE";
    if (s === "LONG_BUY") return "LONG";
    return null;
  };

  // Legacy: { decision: { action: "long", reasoning: [], ... } }
  if (obj.decision && typeof obj.decision === "object") {
    const d = obj.decision;
    const legacyAct = String(d.action || "")
      .trim()
      .toLowerCase();
    const mapped =
      legacyAct === "long" ? "LONG" : legacyAct === "short" ? "SHORT" : "NO_TRADE";
    if (mapped === "NO_TRADE") {
      const reasoning = toStrArray(d.reasoning);
      return defaultNoTrade(reasoning.length ? reasoning : ["no_trade"]);
    }
    return {
      action: mapped,
      entry: toNum(d.entry),
      sl: toNum(d.sl ?? d.stop_loss),
      tp: toNum(d.tp ?? d.take_profit),
      confidence: normConf(d.confidence),
      reason: toStrArray(d.reasoning),
      risk_level: ["low", "medium", "high"].includes(d.risk_level) ? d.risk_level : "medium",
      why: null,
      next_trigger: null
    };
  }

  // New flat format
  const action = normAction(obj.action);
  if (!action) return defaultBadParse();

  if (action === "NO_TRADE") {
    let why = toStrArray(obj.why);
    if (!why.length) why = toStrArray(obj.reason);
    if (!why.length) why = ["no_trade"];
    let nt = obj.next_trigger;
    if (!Array.isArray(nt) || nt.length === 0) {
      nt = defaultNoTrade(why).next_trigger;
    } else {
      nt = nt.map((row) => {
        const label = String(row.for_side || row.side || "").toUpperCase();
        const for_side =
          label.includes("SHORT") && !label.includes("LONG") ? "SHORT" : "LONG";
        return {
          for_side,
          wait_for: toStrArray(row.wait_for || row.conditions || row.triggers)
        };
      });
    }
    return {
      action: "NO_TRADE",
      entry: null,
      sl: null,
      tp: null,
      confidence: 0,
      reason: [],
      risk_level: ["low", "medium", "high"].includes(obj.risk_level) ? obj.risk_level : "high",
      why,
      next_trigger: nt
    };
  }

  // LONG | SHORT
  let reason = toStrArray(obj.reason);
  if (!reason.length) reason = toStrArray(obj.reasoning);

  return {
    action,
    entry: toNum(obj.entry),
    sl: toNum(obj.sl ?? obj.stop_loss),
    tp: toNum(obj.tp ?? obj.take_profit),
    confidence: normConf(obj.confidence),
    reason: reason.length ? reason : ["No reason provided."],
    risk_level: ["low", "medium", "high"].includes(obj.risk_level) ? obj.risk_level : "medium",
    why: null,
    next_trigger: null
  };
}

/**
 * Build the user prompt from the trading context payload.
 * @param {object} payload - Full trading context (symbol, timestamp_utc, timeframes, features, rules)
 * @returns {string}
 */
function buildPrompt(payload) {
  const jsonStr = JSON.stringify(payload, null, 2);
  return `Here is the structured market data (JSON):\n\n${jsonStr}\n\nStart from decision_smart_pipeline.trade_block, score, and liquidity_map; then hard_constraints. Respond with ONE JSON object only, following the OUTPUT schema in the system message (root-level action LONG | SHORT | NO_TRADE).`;
}

/**
 * Call Google Gemini with the trading context payload.
 * @param {object} payload - Trading context JSON (symbol, timestamp_utc, timeframes, features, rules)
 * @param {object} options - Optional: { apiKey?, model? }
 * @returns {Promise<string>} LLM reply text
 */
async function askGemini(payload, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY.");
  }
  const model = options.model || "gemini-1.5-flash";
  const prompt = buildPrompt(payload);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${TRADING_SYSTEM_PROMPT}\n\n---\n\n${prompt}` }]
      }
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1536
    }
  };
  const response = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000
  });
  const candidate = response.data?.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini returned no candidate: " + JSON.stringify(response.data));
  }
  const part = candidate.content?.parts?.[0];
  if (!part?.text) {
    throw new Error("Gemini returned no text: " + JSON.stringify(candidate));
  }
  return part.text.trim();
}

/**
 * Call OpenAI ChatGPT with the trading context payload.
 * @param {object} payload - Trading context JSON (symbol, timestamp_utc, timeframes, features, rules)
 * @param {object} options - Optional: { apiKey?, model? }
 * @returns {string} LLM reply text
 */
async function askChatGPT(payload, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY.");
  }
  const model = options.model || "gpt-4o-mini";
  const prompt = buildPrompt(payload);
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    messages: [
      { role: "system", content: TRADING_SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ],
    max_tokens: 1536,
    temperature: 0.35
  };
  const response = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    timeout: 60000
  });
  const choice = response.data?.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error("ChatGPT returned no content: " + JSON.stringify(response.data));
  }
  return choice.message.content.trim();
}

/**
 * Pipeline step: custom system + user (full market JSON is inside user).
 * @param {"chatgpt"|"gemini"} provider
 * @param {{ systemPrompt: string, userPrompt: string }} prompts
 * @param {object} [options]
 * @returns {Promise<string>}
 */
async function askTradingPipelineStep(provider, prompts, options = {}) {
  const { systemPrompt, userPrompt } = prompts;
  if (provider === "gemini") {
    return askGeminiPipelineStep(prompts, options);
  }
  return askChatGPTPipelineStep(prompts, options);
}

async function askChatGPTPipelineStep({ systemPrompt, userPrompt }, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY.");
  }
  const model = options.model || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: options.max_tokens ?? 900,
    temperature: options.temperature ?? 0.25
  };
  const response = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    timeout: options.timeout ?? 90000
  });
  const choice = response.data?.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error("ChatGPT pipeline step returned no content: " + JSON.stringify(response.data));
  }
  return choice.message.content.trim();
}

async function askGeminiPipelineStep({ systemPrompt, userPrompt }, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY.");
  }
  const model = options.model || "gemini-1.5-flash";
  const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: combined }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.25,
      maxOutputTokens: options.maxOutputTokens ?? 1024
    }
  };
  const response = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: options.timeout ?? 90000
  });
  const candidate = response.data?.candidates?.[0];
  const part = candidate?.content?.parts?.[0];
  if (!part?.text) {
    throw new Error("Gemini pipeline step returned no text: " + JSON.stringify(response.data));
  }
  return part.text.trim();
}

module.exports = {
  askGemini,
  askChatGPT,
  askTradingPipelineStep,
  buildPrompt,
  normalizeTradingDecision,
  TRADING_SYSTEM_PROMPT
};
