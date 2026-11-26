const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarizeEvaluation } = require("../src/evaluationMetrics");
const { applyEvaluationPolicy, policy } = require("../src/evaluationPolicy");
const contract = require("../config/evaluation-contract.json");
const fixtures = require("./fixtures/evaluation-contract.json");

test("Node metrics match shared hand-calculated cases without changing their input", () => {
  assert.equal(contract.version, fixtures.contract_version);
  assert.equal(policy.version, fixtures.policy_version);
  const before = structuredClone(fixtures);
  for (const fixture of fixtures.cases) {
    assert.deepEqual(summarizeEvaluation(fixture.row_names.map(name => fixtures.rows[name]), policy.version), fixture.expected_common, fixture.name);
  }
  assert.deepEqual(fixtures, before);
});

test("Node issuance mapping matches the shared language-boundary cases", () => {
  for (const row of fixtures.orders) {
    const result = applyEvaluationPolicy([{ symbol: "NVDA", trade_direction: row.trade_direction, entry_prediction: row.entry_prediction }]);
    if (row.order_type === null) assert.equal(result.exclusions[0].reason, "unsupported_entry_type");
    else {
      assert.equal(result.recommendations[0].order_type, row.order_type);
      assert.deepEqual(result.recommendations[0].evaluation_policy, policy);
    }
  }
});
