const { migrate } = require("../src/migrations");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { runReport } = require("../src/reportRun");
const { makePreparationFixture } = require("../fixtures/preparation-report");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL saves preparation evidence without creating trading rows, and replay reuses it", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `preparation_test_${crypto.randomBytes(6).toString("hex")}`;
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
    const fixture = makePreparationFixture(); let calls = 0, emails = 0;
    const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false },
      execution: { runNamespace: "preparation-test-1" }, delivery: { email: true } };
    const dependencies = { now: () => fixture.now, connectDatabase: connect, collectInputs: async () => fixture.inputs,
      generateReport: async () => { calls++; return { content: fixture.report, finish_reason: "stop" }; }, buildOptions: async plans => { assert.deepEqual(plans, []); return []; },
      sendEmail: async () => { emails++; return { id: "fake-preparation-receipt" }; } };
    const result = await runReport(settings, {}, dependencies);
    assert.equal(result.status, "completed");
    assert.equal((await runReport(settings, {}, dependencies)).status, "already_completed");
    assert.equal(calls, 1); assert.equal(emails, 1);
    const saved = (await db.client.query("SELECT snapshot,output FROM report_runs WHERE id=$1", [result.run_id])).rows[0];
    assert.equal(saved.snapshot.inputs.preparationContext.window.from, "2026-10-21");
    assert.equal(saved.output.preparation.strategies.length, 1);
    assert.equal(saved.output.preparation.strategies[0].status, "preparation_only");
    assert.equal(saved.output.preparation.outcomes.NVDA.state, "preparation");
    assert.equal(saved.output.preparation.outcomes.MSFT.state, "blocked");
    assert.equal(saved.snapshot.model_completion.finish_reason, "stop");
    assert.equal(saved.output.model_completion.finish_reason, "stop");
    assert.deepEqual(saved.output.recommendations, []);
    assert.equal(saved.output.eligible_session, "2026-10-22");
    assert.equal((await db.client.query("SELECT count(*)::int AS n FROM trading_reports")).rows[0].n, 0);
    assert.equal((await db.getCorrectEvaluationContext("next-session-v1", 3650)).total_plans, 0);
    assert.equal((await db.client.query("SELECT count(*)::int AS n FROM recommendation_evaluations")).rows[0].n, 0);
    const openFixture = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
    const incomplete = await runReport({ ...settings, execution: { ...settings.execution, runNamespace: "preparation-test-2" } }, {}, {
      ...dependencies, now: () => openFixture.now, collectInputs: async () => openFixture.inputs,
      generateReport: async () => { calls++; return { content: openFixture.report, finish_reason: "length" }; }
    });
    assert.equal(incomplete.status, "completed");
    assert.equal(calls, 2); assert.equal(emails, 2);
    const partial = (await db.client.query("SELECT snapshot,output FROM report_runs WHERE id=$1", [incomplete.run_id])).rows[0];
    assert.equal(partial.snapshot.model_completion.finish_reason, "length");
    assert.deepEqual(partial.output.recommendations, []);
    assert.match(partial.output.html, /Model generation did not finish normally/);
    assert.equal((await db.client.query("SELECT count(*)::int AS n FROM trading_reports")).rows[0].n, 0);
  } finally {
    await db.disconnect(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
