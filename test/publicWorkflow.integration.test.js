const { migrate } = require("../src/migrations");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseClient } = require("../src/database");
const { runReport } = require("../src/reportRun");
const { makePreparationFixture } = require("../fixtures/preparation-report");
const { syntheticOptionChain } = require("../fixtures/demo");
const { buildOptionsSupplements } = require("../src/optionsSupplement");
const { createConfig } = require("../src/config");
const { policy } = require("../src/evaluationPolicy");
const url = process.env.TEST_DATABASE_URL;

test("public report stores once, renders without email, evaluates in Python and supplies Node feedback", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `portfolio_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connect = async () => {
    const db = new DatabaseClient(url);
    db.client = new Client({ connectionString: url, options: `-c search_path=${schema},public` });
    await db.client.connect(); return db;
  };
  const db = await connect();
  try {
    await migrate(db.client);
    // The explicit command is idempotent; runtime jobs only check history.
    await migrate(db.client);
    assert.equal(await db.validateSchema(), true);
    const fixture = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
    const settings = { ...createConfig(), model: "synthetic", watchlist: ["NVDA", "MSFT"] };
    let modelCalls = 0, artifact;
    const dependencies = {
      now: () => fixture.now, connectDatabase: connect, collectInputs: async () => structuredClone(fixture.inputs),
      generateReport: async () => { modelCalls++; return { content: fixture.report }; },
      buildOptions: (plans, quotes, snapshots) => buildOptionsSupplements(plans, quotes, settings.options, snapshots, { fetchChain: syntheticOptionChain }),
      sendEmail: async () => { throw new Error("Email must stay disabled"); },
      writeArtifact: value => { artifact = value; return "synthetic-test-artifact"; }
    };
    const first = await runReport(settings, {}, dependencies);
    assert.equal(first.status, "completed"); assert.equal(first.email_status, "disabled");
    assert.equal(artifact.output.recommendations.length, 1);
    assert.equal(artifact.output.optionsSupplements.length, 1);
    assert.equal(artifact.output.optionChainSnapshots.length, 1);
    assert.equal((await db.client.query("SELECT count(*)::int n FROM option_chain_snapshots")).rows[0].n, 0);
    assert.equal((await db.client.query("SELECT count(*)::int n FROM option_supplements")).rows[0].n, 0);
    assert.equal((await db.client.query("SELECT report_text FROM trading_reports")).rows[0].report_text, null);
    const savedOutput = (await db.client.query("SELECT output FROM report_runs")).rows[0].output;
    assert.deepEqual((await db.client.query("SELECT symbol FROM trading_reports")).rows, [{ symbol: "NVDA" }]);
    assert.ok(savedOutput.exclusions.some(e => e.symbol === "MSFT" && e.reason === "reported_earnings_conflict"));
    const evidence = (await db.client.query("SELECT snapshot FROM report_runs")).rows[0].snapshot.inputs.evidence;
    assert.deepEqual(evidence.earnings, fixture.inputs.evidence.earnings);
    assert.deepEqual(savedOutput.optionChainSnapshots, artifact.output.optionChainSnapshots);
    assert.deepEqual(savedOutput.optionsSupplements, artifact.output.optionsSupplements);
    assert.equal(savedOutput.report, artifact.output.report);
    assert.equal(savedOutput.reportDocument.schema_version, "report-document-v1");
    assert.deepEqual(savedOutput.reportDocument.tracked_plans, savedOutput.recommendations);
    assert.equal(require("../src/formatter").formatDashboard(savedOutput.reportDocument), savedOutput.html);
    assert.equal((await runReport(settings, {}, dependencies)).status, "already_completed");
    assert.deepEqual(artifact.output.reportDocument, savedOutput.reportDocument);
    // Completed historical outputs without a document replay their frozen HTML.
    const legacyText = "Daily Summary: saved historical response\nRECOMMENDATIONS_JSON [] END_RECOMMENDATIONS_JSON";
    await db.client.query("UPDATE report_runs SET output = jsonb_set(output - 'reportDocument' - 'model_validation', '{report}', to_jsonb($1::text)), settings = jsonb_set(settings, '{pipeline_version}', '\"public-report-v1\"')", [legacyText]);
    assert.equal((await runReport(settings, {}, dependencies)).status, "already_completed");
    assert.equal(artifact.output.html, savedOutput.html);
    assert.equal(artifact.output.reportDocument, undefined);
    assert.equal(artifact.output.report, legacyText);
    assert.equal(modelCalls, 1);
    assert.equal((await db.client.query("SELECT count(*)::int n FROM trading_reports")).rows[0].n, 1);
    assert.equal((await db.client.query("SELECT email_status FROM report_runs")).rows[0].email_status, "disabled");
    assert.equal((await db.client.query("SELECT to_regclass('recommendation_outcomes') legacy")).rows[0].legacy, null);
    const python = process.env.PYTHON || "python";
    const evaluated = spawnSync(python, ["test/cross_language.py"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
      env: { ...process.env, TEST_SCHEMA: schema } });
    assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);
    const feedback = await db.getCorrectEvaluationContext(policy.version, 3650);
    assert.equal(feedback.total_plans, 1); assert.equal(feedback.filled_closed, 1);
    assert.ok(feedback.avg_net_return_pct > 0);
    // An uncertain send is never silently retried.
    const emailSettings = { ...settings, delivery: { email: true }, execution: { ...settings.execution, runNamespace: "email-test" } };
    let sends = 0;
    const unknown = { ...dependencies, sendEmail: async () => { sends++; throw new Error("simulated timeout"); } };
    await assert.rejects(runReport(emailSettings, {}, unknown), /saved stages preserved/);
    assert.equal((await runReport(emailSettings, {}, unknown)).status, "delivery_unknown");
    assert.equal(sends, 1);
  } finally {
    await db.disconnect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
