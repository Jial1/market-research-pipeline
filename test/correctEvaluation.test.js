const { test } = require("node:test");
const assert = require("node:assert/strict");
const { policy } = require("../src/evaluationPolicy");
const { runReport } = require("../src/reportRun");
const { formatRecommendationFeedback } = require("../src/performanceContext");
const { makeScenario } = require("./fixtures/report-scenarios");
const fixture = makeScenario("market-open");

test("saved settings compare consistently after JSONB omits optional undefined fields", () => {
  const { safeSettings } = require("../src/runInfrastructure");
  const settings = safeSettings({ options: { enabled: false, mode: undefined } });
  assert.deepEqual(settings, JSON.parse(JSON.stringify(settings)));
});

test("corrected dry output freezes order policy, issuance and calendar-based eligibility", async () => {
  const inputs = structuredClone(fixture.inputs);

  let artifact;
  await runReport({ options: { enabled: false }, dataValidation: { maxAgeSeconds: 900 } }, { dryRun: true }, {
    now: () => Date.parse("2026-10-21T16:00:00Z"), collectInputs: async () => inputs,
    generateReport: async () => ({ content: fixture.report }), writeArtifact: value => { artifact = value; return "local"; }
  });
  assert.equal(artifact.output.recommendations[0].order_type, "buy_stop");
  assert.deepEqual(artifact.output.recommendations[0].evaluation_policy, policy);
  assert.equal(artifact.output.eligible_session, "2026-10-22");
  assert.equal(artifact.output.issued_at, "2026-10-21T16:00:00.000Z");
  assert.equal(artifact.output.evaluationPolicy.friction_bps_per_side.base, 5);
  assert.doesNotMatch(artifact.output.html, /bps per side/);
});

test("missing issuance calendar stops the supported pipeline before paid generation", async () => {
  const inputs = structuredClone(fixture.inputs); delete inputs.evidence.calendar;
  await assert.rejects(runReport({}, { dryRun: true }, {
    now: () => fixture.now, collectInputs: async () => inputs,
    generateReport: () => assert.fail("No generation without qualified calendar/history")
  }), /No usable historical evidence/);
});

test("unsupported AI entry type is excluded from final cards as well as storage candidates", async () => {
  const fixture = makeScenario("market-open");
  let artifact;
  await runReport({}, { dryRun: true }, {
    now: () => Date.parse("2026-10-21T16:00:00Z"), collectInputs: async () => fixture.inputs,
    generateReport: async () => ({ content: fixture.report.replace('"breakout"', '"unknown"') }),
    writeArtifact: value => { artifact = value; return "local"; }
  });
  assert.deepEqual(artifact.output.recommendations, []);
  assert.match(artifact.output.html, /Invalid model response fields/);
  assert.equal(artifact.output.exclusions[0].reason, "invalid_model_schema");
  assert.doesNotMatch(artifact.output.html, /R\/R /);
});

test("corrected feedback discloses denominators, costs and legacy isolation; missing metrics are N/A", () => {
  const text = formatRecommendationFeedback({ evaluation_version: policy.version, days: 30, total_plans: 3,
    filled_closed: 0, pending: 1, unavailable: 1, unfilled_terminal: 1, ambiguous_count: 0,
    net_win_rate: null, avg_net_return_pct: null });
  assert.match(text, /filled and closed: 0/);
  assert.match(text, /average net return: N\/A/);
  assert.match(text, /Legacy scores excluded/);
  assert.doesNotMatch(text, /0\.0%/);
});
