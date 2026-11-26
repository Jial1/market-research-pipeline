const VERSION = "model-analysis-v1";
const text = { type: "string" };
const number = { type: "number" };
const nullableNumber = { type: ["number", "null"] };
const choice = (...values) => ({ type: "string", enum: values });
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: "array", items });
const commentary = { structure: text, momentum: text, catalyst: text, risk: text };
const levels = { trade_direction: choice("long", "short"), entry_price: number, target_price: number, stop_loss: number };

// One JSON Schema supplies both provider constraints and application validation.
// Nullable model scores/confidence preserve the existing application defaults.
const schema = object({ schema_version: choice(VERSION), market_summary: text,
  stocks: array(object({ symbol: text, ...commentary })),
  recommendations: array(object({ symbol: text, ...levels, entry_prediction: choice("breakout", "pullback"),
    setup_score: nullableNumber, ai_confidence: nullableNumber, ...commentary,
    liquidity: text, reason: text, market_regime: text, catalyst_type: text })),
  preparation: array({ anyOf: [object({ symbol: text, decision: choice("watch_only"), reason: text }),
    object({ symbol: text, decision: choice("propose"), ...levels, trigger: text, thesis: text,
      invalidation: text, risk: text, evidence_asof: text })] }) });

// Deliberately supports only the schema keywords used above; no coercion/defaults.
function matches(value, rule) {
  if (Object.keys(rule).some(key => !["type", "enum", "anyOf", "properties", "required", "additionalProperties", "items"].includes(key))) {
    throw new Error("Unsupported ModelAnalysisV1 schema keyword");
  }
  if (rule.anyOf) return rule.anyOf.some(branch => matches(value, branch));
  if (Array.isArray(rule.type)) return rule.type.some(type => matches(value, { ...rule, type }));
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === "null") return value === null;
  if (rule.type === "string") return typeof value === "string";
  if (rule.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (rule.type === "array") return Array.isArray(value) && value.every(item => matches(item, rule.items));
  if (rule.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value)
    && rule.required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => Object.hasOwn(rule.properties, key) && matches(value[key], rule.properties[key]));
  throw new Error("Unsupported ModelAnalysisV1 schema keyword");
}

function parseModelAnalysis(raw, symbols) {
  const invalid = state => ({ state, analysis: null, errors: [state] });
  let analysis;
  try { analysis = JSON.parse(raw); } catch { return invalid("invalid_model_json"); }
  if (!matches(analysis, schema)) return invalid("invalid_model_schema");
  const expected = new Set(symbols);
  for (const rows of [analysis.stocks, analysis.recommendations, analysis.preparation]) {
    const seen = new Set();
    for (const row of rows) {
      if (!expected.has(row.symbol) || seen.has(row.symbol)) return invalid("invalid_model_symbols");
      seen.add(row.symbol);
    }
  }
  if (analysis.stocks.length !== expected.size) return invalid("missing_stock_analysis");
  return { state: "valid", analysis, errors: [] };
}

function stockAnalysis(analysis, symbol) {
  const row = analysis?.stocks.find(s => s.symbol === symbol);
  if (!row) return { state: "missing", fields: {} };
  const fields = Object.fromEntries([["Structure", row.structure], ["Momentum", row.momentum], ["Catalysts", row.catalyst], ["Risk", row.risk]]
    .filter(([, value]) => value.trim() && !/(?:R\/R|\b(?:entry|target|stop|buy|sell|invalidation)(?:\b|(?=\d))|\bgo\s+(?:long|short)\b)/i.test(value)));
  return { state: Object.keys(fields).length ? "supplied" : Object.keys(commentary).some(key => row[key].trim()) ? "withheld" : "missing", fields };
}

module.exports = { VERSION, schema, parseModelAnalysis, stockAnalysis };
