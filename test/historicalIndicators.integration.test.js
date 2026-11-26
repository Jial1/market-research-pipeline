const { migrate } = require("../src/migrations");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { runReport } = require("../src/reportRun");
const { makeHistoricalFixture, NOW } = require("../fixtures/historical-report");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL preserves measured prompt/evidence; recovery stores only history-eligible plans", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `phase4_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connect = async () => {
    const db = new DatabaseClient(url);
    db.client = new Client({ connectionString: url, options: `-c search_path=${schema},public` });
    await db.client.connect();
    return db;
  };
  const db = await connect();
  try {
    await migrate(db.client);
    const fixture = makeHistoricalFixture({ NVDA: 51, SPCX: 50 });
    const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: true }, delivery: { email: true } };
    let ai = 0, inputs = 0, options = 0, emails = 0, sentRequest;
    const dependencies = { now: () => NOW, connectDatabase: connect,
      collectInputs: async () => { inputs++; return fixture.inputs; },
      generateReport: async (evidence, feedback, request) => { ai++; sentRequest = request; return { content: fixture.reports.enriched }; },
      buildOptions: async plans => {
        assert.deepEqual(plans.map(p => p.symbol), ["NVDA"]);
        if (++options === 1) throw new Error("Simulated downstream failure");
        return [];
      }, sendEmail: async () => { emails++; return { id: "fake-phase4" }; } };
    await assert.rejects(runReport(settings, {}, dependencies), /saved stages/);
    await assert.rejects(runReport({ ...settings, model: "incompatible-recovery-model" }, {}, dependencies), /saved stages/);
    await db.client.query("UPDATE report_runs SET snapshot = jsonb_set(snapshot, '{model_schema_version}', '\"retired-contract\"')");
    await assert.rejects(runReport(settings, {}, dependencies), /saved stages/);
    await db.client.query("UPDATE report_runs SET snapshot = jsonb_set(snapshot, '{model_schema_version}', '\"model-analysis-v1\"')");
    await db.client.query("UPDATE report_runs SET snapshot = jsonb_set(snapshot, '{prompt_version}', '\"retired-prompt\"')");
    await assert.rejects(runReport(settings, {}, dependencies), /saved stages/);
    await db.client.query("UPDATE report_runs SET snapshot = jsonb_set(snapshot, '{prompt_version}', '\"daily-report-model-analysis-v1\"')");
    await db.client.query("UPDATE report_runs SET settings = jsonb_set(settings, '{pipeline_version}', '\"public-report-v2\"')");
    await assert.rejects(runReport(settings, {}, dependencies), /saved stages/);
    await db.client.query("UPDATE report_runs SET settings = jsonb_set(settings, '{pipeline_version}', '\"public-report-v3\"')");
    const result = await runReport(settings, {}, dependencies);
    assert.equal(result.status, "completed");
    assert.equal((await runReport(settings, {}, dependencies)).status, "already_completed");
    assert.deepEqual({ ai, inputs, options, emails }, { ai: 1, inputs: 1, options: 2, emails: 1 });
    const run = (await db.client.query("SELECT snapshot,output FROM report_runs WHERE id=$1", [result.run_id])).rows[0];
    assert.deepEqual(run.snapshot.model_request, sentRequest);
    assert.equal(run.snapshot.model_schema_version, "model-analysis-v1");
    assert.equal(run.snapshot.prompt_version, "daily-report-model-analysis-v1");
    assert.equal(run.snapshot.report_text, fixture.reports.enriched);
    assert.equal(run.snapshot.inputs.quotes[0].historical.values.sma200, null);
    assert.equal(run.snapshot.inputs.evidence.histories.NVDA.candles.length, 51);
    const plans = (await db.client.query("SELECT symbol,order_type,evaluation_policy FROM trading_reports WHERE run_id=$1", [result.run_id])).rows;
    assert.equal(plans.length, 1); assert.equal(plans[0].symbol, "NVDA"); assert.equal(plans[0].order_type, "buy_stop");
    assert.equal(plans[0].evaluation_policy.version, "next-session-v1");
    assert.equal(run.output.dataQuality.symbols[1].actionable, false);
    // Even an empty/refused/malformed paid response is a durable checkpoint.
    // Crash before output is saved, then recover without generating again.
    for (const [index, [response, finishReason]] of [["", null], ["not JSON", null],
      ['{"refusal":"synthetic refusal"}', null], [fixture.reports.enriched, "length"]].entries()) {
      let paidCalls = 0, optionCalls = 0;
      const invalidSettings = { ...settings, execution: { runNamespace: `invalid-response-${index}` }, delivery: { email: false } };
      const invalidDependencies = { ...dependencies,
        generateReport: async () => { paidCalls++; return { content: response, finish_reason: finishReason }; },
        buildOptions: async plans => { assert.deepEqual(plans, []); if (++optionCalls === 1) throw new Error("downstream failure"); return []; },
        sendEmail: () => assert.fail("Invalid-response verification is local-only") };
      await assert.rejects(runReport(invalidSettings, {}, invalidDependencies), /saved stages/);
      const recovered = await runReport(invalidSettings, {}, invalidDependencies);
      assert.equal(recovered.status, "completed");
      assert.equal(paidCalls, 1);
      const invalid = (await db.client.query("SELECT snapshot,output FROM report_runs WHERE id=$1", [recovered.run_id])).rows[0];
      assert.equal(invalid.snapshot.report_text, response);
      assert.equal(invalid.snapshot.model_completion.finish_reason, finishReason);
      if (finishReason) assert.ok(invalid.output.exclusions.some(e => e.reason === "model_generation_incomplete"));
      else assert.notEqual(invalid.output.model_validation.state, "valid");
      assert.deepEqual(invalid.output.recommendations, []);
      assert.deepEqual(invalid.output.preparation.strategies, []);
      assert.equal((await db.client.query("SELECT count(*)::int n FROM trading_reports WHERE run_id=$1", [recovered.run_id])).rows[0].n, 0);
    }
  } finally {
    await db.disconnect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
