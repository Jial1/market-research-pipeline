const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const planFields = ["symbol", "trade_direction", "entry_prediction", "entry_price", "target_price", "stop_loss",
  "risk_reward", "setup_score", "setup_quality", "ai_confidence", "order_type", "evaluation_policy"];
const preparationFields = ["symbol", "trade_direction", "entry_price", "target_price", "stop_loss", "risk_reward",
  "evidence_asof", "session"];
const pick = (value, fields) => Object.fromEntries(fields.filter(k => k in value).map(k => [k, value[k]]));

// Language-independent reference from the original privately verified synthetic outputs.
function reportFacts(artifact) {
  const output = artifact.output;
  return {
    input_evidence_sha256: hash(artifact.snapshot.inputs),
    recommendations: output.recommendations.map(p => pick(p, planFields)),
    preparation: output.preparation.strategies.map(p => pick(p, preparationFields)),
    preparation_states: Object.fromEntries(Object.entries(output.preparation.outcomes || {}).map(([symbol, o]) => [symbol,
      { state: o.state, ...(!["watch_only", "preparation"].includes(o.state) ? { reason: o.reason } : {}) }])),
    exclusions: output.exclusions,
    options_sha256: hash(output.optionsSupplements),
    market_context_sha256: hash(output.marketContext),
    evaluation_policy: output.evaluationPolicy,
    issued_at: output.issued_at,
    eligible_session: output.eligible_session,
    data_quality: output.dataQuality
  };
}
module.exports = { reportFacts };
