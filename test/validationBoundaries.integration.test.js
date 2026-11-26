const { migrate } = require("../src/migrations");
const { amendReport } = require("../fixtures/model-analysis");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { runReport } = require("../src/reportRun");
const { RunRecords } = require("../src/runRecords");
const { createConfig } = require("../src/config");
const { makeScenario } = require("./fixtures/report-scenarios");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL never stores malformed/duplicate model plans and rejects corrupted replay output", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `boundaries_test_${crypto.randomBytes(6).toString("hex")}`;
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
    const fixture = makeScenario("market-open");
    const plan = { symbol: "NVDA", trade_direction: "long", entry_prediction: "breakout",
      entry_price: 100, target_price: 110, stop_loss: 95, setup_score: 80 };
    const cases = [
      [{ ...plan, entry_price: -100, target_price: -90, stop_loss: -105 }],
      [{ ...plan, trade_direction: "sideways" }],
      [plan, { ...plan, target_price: 120 }]
    ];
    for (const [index, rows] of cases.entries()) {
      const settings = { ...createConfig({}), options: { enabled: false },
        execution: { runNamespace: `boundary-${index}` } };
      const report = amendReport(fixture.report, a => { a.recommendations = rows; });
      let saved;
      const result = await runReport(settings, {}, {
        now: () => fixture.now, connectDatabase: connect, collectInputs: async () => structuredClone(fixture.inputs),
        generateReport: async () => ({ content: report }),
        buildOptions: async plans => { assert.deepEqual(plans, []); return []; },
        sendEmail: () => assert.fail("Email must stay disabled"),
        writeArtifact: value => { saved = value; return "boundary-integration"; }
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(saved.output.recommendations, []);
      assert.match(saved.output.html, /Approved plans: 0/);
      const stored = await db.client.query("SELECT count(*)::int n FROM trading_reports WHERE run_id=$1", [result.run_id]);
      assert.equal(stored.rows[0].n, 0);
      const records = new RunRecords(db);
      await assert.rejects(records.storePlans({ id: result.run_id }, { recommendations: rows }), /Invalid recommendation|Duplicate recommendation/);
    }
    assert.equal((await db.client.query("SELECT count(*)::int n FROM trading_reports")).rows[0].n, 0);
  } finally {
    await db.disconnect(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
