const { migrate } = require("../src/migrations");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { runReport } = require("../src/reportRun");
const { createConfig } = require("../src/config");
const { makePreparationFixture } = require("../fixtures/preparation-report");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL checkpoints precede options, concurrent runs skip, and async artifact recovery freezes issued output", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `orchestration_test_${crypto.randomBytes(6).toString("hex")}`;
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
    const f = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
    const settings = { ...createConfig({}, { watchlist: ["NVDA", "MSFT"] }), model: "fixture",
      execution: { runNamespace: "orchestration" }, delivery: { email: true } };
    const key = "orchestration:daily-report:2026-10-21";
    const readRun = async () => (await db.client.query("SELECT * FROM report_runs WHERE run_key=$1", [key])).rows[0];
    let clock = f.now, inputs = 0, models = 0, options = 0, artifacts = 0, emails = 0, frozen;
    const dependencies = {
      now: () => clock, connectDatabase: connect, 
      collectInputs: async () => { inputs++; return structuredClone(f.inputs); },
      generateReport: async () => {
        models++;
        const initial = await readRun();
        assert.ok(initial.snapshot.model_request); assert.equal(initial.output, null);
        assert.equal(initial.snapshot.report_text, undefined);
        const overlapping = await runReport(settings, {}, dependencies);
        assert.equal(overlapping.status, "already_running");
        return { content: f.report };
      },
      buildOptions: async plans => {
        options++; assert.deepEqual(plans.map(p => p.symbol), ["NVDA"]);
        assert.equal((await readRun()).snapshot.report_text, f.report, "Paid response is durable before options");
        return [];
      },
      writeArtifact: async value => {
        artifacts++;
        const stored = await readRun();
        assert.equal(stored.recommendations_stored, true);
        assert.equal((await db.client.query("SELECT count(*)::int n FROM trading_reports")).rows[0].n, 1);
        assert.deepEqual(value.output, stored.output);
        if (artifacts === 1) { frozen = stored.output; throw new Error("synthetic async disk failure"); }
        assert.deepEqual(value.output, frozen);
        return "memory-artifact";
      },
      sendEmail: async payload => {
        emails++;
        const sending = await readRun();
        assert.equal(sending.email_status, "unknown", "Uncertainty is durable before the send");
        assert.equal(payload.idempotencyKey, `report-run/${sending.id}`);
        assert.equal(payload.content, frozen.html);
        return { id: "synthetic-receipt" };
      }
    };
    await assert.rejects(runReport(settings, {}, dependencies), /saved stages preserved/);
    const failed = await readRun();
    assert.equal(failed.status, "failed"); assert.equal(failed.email_status, "not_sent");
    assert.equal(emails, 0);
    clock += 901000; // Recomputing would now revoke quote eligibility.
    const resumed = await runReport(settings, {}, dependencies);
    assert.equal(resumed.status, "completed"); assert.equal(resumed.artifact, "memory-artifact");
    assert.equal((await runReport(settings, {}, dependencies)).status, "already_completed");
    assert.deepEqual({ inputs, models, options, artifacts, emails }, { inputs: 1, models: 1, options: 1, artifacts: 3, emails: 1 });
    assert.deepEqual((await readRun()).output, frozen);
    assert.equal((await readRun()).email_status, "sent");
  } finally {
    await db.disconnect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
