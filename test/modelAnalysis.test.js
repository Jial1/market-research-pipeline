const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseModelAnalysis, schema, VERSION } = require("../src/modelAnalysis");
const { buildReportRequest } = require("../src/reportPrompt");
const { makePreparationFixture } = require("../fixtures/preparation-report");

const valid = () => JSON.parse(makePreparationFixture().report);
const parse = value => parseModelAnalysis(JSON.stringify(value), ["NVDA", "MSFT"]);

test("one strict schema is used for the model request and application validation", () => {
  const request = buildReportRequest([], {});
  assert.deepEqual(request.response_format, { type: "json_schema", json_schema: { name: "model_analysis_v1", strict: true, schema } });
  assert.match(request.messages[0].content, /exactly one JSON object/);
  assert.doesNotMatch(request.messages[0].content, /PREPARATION_JSON|RECOMMENDATIONS_JSON/);
  const visit = rule => {
    if (rule.type === "object") {
      assert.equal(rule.additionalProperties, false);
      assert.deepEqual(rule.required, Object.keys(rule.properties));
      Object.values(rule.properties).forEach(visit);
    }
    if (rule.items) visit(rule.items);
    if (rule.anyOf) rule.anyOf.forEach(visit);
  };
  visit(schema);
  assert.equal(parse(valid()).state, "valid");
});

test("model response parsing rejects prose, old markers, fences, truncation and multiple objects", () => {
  for (const raw of ["", "Daily Summary: valid prose", "RECOMMENDATIONS_JSON [] END_RECOMMENDATIONS_JSON",
    "```json\n" + JSON.stringify(valid()) + "\n```", '{"schema_version":', JSON.stringify(valid()) + JSON.stringify(valid())]) {
    const result = parseModelAnalysis(raw, ["NVDA", "MSFT"]);
    assert.equal(result.state, "invalid_model_json");
    assert.equal(result.analysis, null);
  }
});

test("unknown fields, wrong versions, missing fields and coerced numbers cannot enter the application", () => {
  const mutations = [a => { a.schema_version = "model-analysis-v2"; }, a => { a.approved = true; },
    a => { delete a.preparation; }, a => { delete a.stocks[0].risk; }, a => { a.stocks[0].eligible = true; },
    a => { a.recommendations[0].entry_price = "120"; }, a => { a.recommendations[0].trade_direction = "sideways"; },
    a => { a.recommendations[0].setup_score = "80"; }, a => { a.recommendations[0].ai_confidence = true; },
    a => { a.recommendations[0].entry_price = Infinity; }];
  for (const mutate of mutations) {
    const analysis = valid(); mutate(analysis);
    assert.equal(parse(analysis).state, "invalid_model_schema");
    assert.equal(parse(analysis).analysis, null);
  }
});

test("stock coverage, duplicate symbols and unknown symbols are rejected across every channel", () => {
  for (const field of ["stocks", "recommendations", "preparation"]) {
    for (const mutation of [a => a[field].push(a[field][0]), a => { a[field][0].symbol = "OTHER"; },
      a => { a[field][0].symbol = " nvda "; }]) {
      const analysis = valid(); mutation(analysis);
      assert.equal(parse(analysis).state, "invalid_model_symbols");
    }
  }
  const missing = valid(); missing.stocks.pop();
  assert.equal(parse(missing).state, "missing_stock_analysis");
});

test("preparation uses explicit propose/watch-only shapes without implicit proposals or trade-field leakage", () => {
  const analysis = valid();
  analysis.preparation = [{ symbol: "NVDA", decision: "watch_only", reason: "Await confirmation" }];
  assert.equal(parse(analysis).state, "valid");
  analysis.preparation[0].entry_price = 120;
  assert.equal(parse(analysis).state, "invalid_model_schema");
  const implicit = valid(); delete implicit.preparation[0].decision;
  assert.equal(parse(implicit).state, "invalid_model_schema");
});

test("empty candidate arrays and nullable scores are explicit, valid decisions without invented defaults in the contract", () => {
  const analysis = valid();
  analysis.recommendations[0].trade_direction = "short";
  analysis.recommendations[0].setup_score = null;
  analysis.recommendations[0].ai_confidence = null;
  assert.equal(parse(analysis).analysis.recommendations[0].setup_score, null);
  analysis.recommendations = []; analysis.preparation = [];
  assert.equal(parse(analysis).analysis.schema_version, VERSION);
});
