// Display-only ideas. Never passed to recommendation storage or trade evaluation.
const { calendarContext } = require("./data/marketCalendar");
const { assessEarnings } = require("./data/regimeEvents");
const policy = require("../config/evaluation-policy.json");
const VERSION = "preparation-next-opening-v1";
const OUTPUT_CONTRACT = "preparation-decisions-v1";

function preparationWindow(calendar, now) {
  if (!Number.isFinite(now) || calendarContext(calendar, now).state === "unknown") return null;
  const count = policy.entry_sessions + policy.holding_sessions - 1;
  const sessions = calendar.sessions.filter(s => Date.parse(s.open_at) > now).slice(0, count);
  if (sessions.length !== count) return null;
  return { from: sessions[0].date, to: sessions.at(-1).date, sessions: sessions.map(s => s.date), version: VERSION };
}

function withPreparation(inputs, now) {
  const window = preparationWindow(inputs.evidence?.calendar, now);
  const closed = calendarContext(inputs.evidence?.calendar, now).state === "closed";
  const symbols = Object.fromEntries(inputs.quotes.map(q => {
    const snapshot = inputs.evidence?.earnings?.[q.symbol];
    const earnings = assessEarnings(snapshot, window, now, q.symbol);
    let reason = null;
    if (!closed) reason = "preparation_closed_market_only";
    else if (!window) reason = "preparation_calendar_unavailable";
    else if (q.quality?.status !== "research_only" || (q.quality.reasons || []).some(r => r !== "market_closed")
      || !q.historical?.eligible) reason = "preparation_data_unqualified";
    else if (earnings.state === "reported_conflict") reason = "reported_earnings_conflict";
    else if (!["observed", "empty"].includes(snapshot?.status) || !earnings.requested_window_covered
      || (earnings.reasons || []).some(r => r !== "no_reported_conflict_does_not_establish_event_free")) reason = "preparation_earnings_unavailable";
    return [q.symbol, { eligible: !reason, reason, earnings, evidence_asof: q.historical?.asof_session || null }];
  }));
  return { ...inputs, preparationContext: { version: VERSION, output_contract: OUTPUT_CONTRACT,
    enabled: closed, window, symbols, checked_at: new Date(now).toISOString() } };
}

function buildPreparation(rows, inputs, { finishReason = null, validationError = null } = {}) {
  const context = inputs.preparationContext;
  const strategies = [], exclusions = [], outcomes = {};
  const parsed = { state: Array.isArray(rows) ? (rows.length ? "valid_array" : "explicit_empty_array") : "invalid_payload", rows: Array.isArray(rows) ? rows : [] };
  const expected = Object.values(context.symbols).some(s => context.enabled && s.eligible);
  const generationIncomplete = finishReason != null && finishReason !== "stop";
  const outputError = generationIncomplete ? "model_generation_incomplete" : validationError || (Array.isArray(rows) ? null : "invalid_model_schema");
  if (expected && outputError) exclusions.push({ symbol: "all", reason: outputError });
  for (const row of parsed.rows) {
    if (!row || typeof row !== "object" || typeof row.symbol !== "string" || !Object.hasOwn(context.symbols, row.symbol)) {
      exclusions.push({ symbol: "all", reason: "unrecognized_preparation_row" });
    }
  }
  for (const [symbol, eligibility] of Object.entries(context.symbols)) {
    const rows = parsed.rows.filter(row => row && typeof row === "object" && row.symbol === symbol);
    const reject = (state, reason) => { outcomes[symbol] = { state, reason }; exclusions.push({ symbol, reason }); };
    if (!context.enabled) { outcomes[symbol] = { state: "not_applicable", reason: "preparation_closed_market_only" }; continue; }
    if (!eligibility.eligible) {
      outcomes[symbol] = { state: "blocked", reason: eligibility.reason };
      if (rows.length) exclusions.push({ symbol, reason: eligibility.reason });
      continue;
    }
    if (outputError) { outcomes[symbol] = { state: "output_error", reason: outputError }; continue; }
    if (!rows.length) {
      reject("decision_missing", parsed.state === "explicit_empty_array" ? "empty_preparation_decisions" : "missing_preparation_decision"); continue;
    }
    if (rows.length !== 1) { reject("output_error", "duplicate_preparation_decision"); continue; }
    const row = rows[0];
    if (row.decision === "watch_only") {
      if (typeof row.reason !== "string" || !row.reason.trim()
        || ["entry_price", "target_price", "stop_loss", "trade_direction"].some(key => row[key] != null)
        || /(?:Entry|Target|Stop|Invalidation level|entry|target|stop)\s*[::=]?\s*\$?\d/i.test(row.reason)) {
        reject("output_error", "invalid_watch_only_decision"); continue;
      }
      outcomes[symbol] = { state: "watch_only", reason: row.reason.trim() }; continue;
    }
    if (row.decision !== "propose") {
      reject("output_error", "invalid_preparation_decision"); continue;
    }
    const { entry_price: entry, target_price: target, stop_loss: stop } = row;
    const long = row.trade_direction === "long";
    const direction = long || row.trade_direction === "short";
    const geometry = long ? target > entry && entry > stop : target < entry && entry < stop;
    const rr = Math.abs((target - entry) / (entry - stop));
    if (!direction || ![entry, target, stop].every(v => Number.isFinite(v) && v > 0) || !geometry || !Number.isFinite(rr) || rr < 1.2
      || row.evidence_asof !== eligibility.evidence_asof
      || !["trigger", "thesis", "invalidation", "risk"].every(k => typeof row[k] === "string" && row[k].trim())) {
      reject("rejected", "invalid_preparation_strategy"); continue;
    }
    strategies.push({ symbol, trade_direction: row.trade_direction, entry_price: entry, target_price: target, stop_loss: stop,
      risk_reward: rr, trigger: row.trigger.trim(), thesis: row.thesis.trim(), invalidation: row.invalidation.trim(), risk: row.risk.trim(),
      evidence_asof: row.evidence_asof, session: context.window.from, status: "preparation_only" });
    outcomes[symbol] = { state: "preparation", reason: row.thesis.trim() };
  }
  const issueStates = new Set(["output_error", "decision_missing", "rejected"]);
  return { context, output_contract: OUTPUT_CONTRACT, response_state: parsed.state,
    output_status: !expected ? "not_required" : outputError ? "output_error"
      : Object.values(outcomes).some(o => issueStates.has(o.state)) || exclusions.some(e => e.symbol === "all") ? "incomplete_decisions" : "complete",
    strategies, exclusions, outcomes };
}

module.exports = { VERSION, OUTPUT_CONTRACT, preparationWindow, withPreparation, buildPreparation };
