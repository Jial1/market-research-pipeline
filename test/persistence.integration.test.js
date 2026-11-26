const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { RunRecords } = require("../src/runRecords");
const { migrate } = require("../src/migrations");
const { renderScenario } = require("./fixtures/report-scenarios");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL plan batches roll back, retry without changing issued rows and store evidence only on the run", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `persistence_test_${crypto.randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: url }); await client.connect();
  const db = new DatabaseClient(url); db.client = client;
  try {
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    await migrate(client);
    const output = structuredClone((await renderScenario("market-open")).output);
    output.recommendations.push({ ...output.recommendations[0], symbol: "MSFT" });
    const run = (await client.query(`INSERT INTO report_runs(run_key,report_date,output) VALUES('atomic','2026-10-21',$1) RETURNING *`, [output])).rows[0];
    const records = new RunRecords(db), originalStore = db.storePlan.bind(db);
    for (const field of ["run_id", "issued_at", "eligible_session", "order_type", "evaluation_policy"]) {
      const missing = { ...output.recommendations[0], date: run.report_date, run_id: run.id,
        issued_at: output.issued_at, eligible_session: output.eligible_session, [field]: null };
      await assert.rejects(db.storePlan(missing), /require run, issuance and evaluation metadata/);
    }
    let inserts = 0;
    db.storePlan = async plan => { if (++inserts === 2) throw new Error("Interrupted plan batch"); return originalStore(plan); };
    await assert.rejects(records.storePlans(run, output), /Interrupted plan batch/);
    assert.equal((await client.query("SELECT count(*)::int n FROM trading_reports")).rows[0].n, 0);
    assert.equal((await client.query("SELECT recommendations_stored FROM report_runs")).rows[0].recommendations_stored, false);
    assert.deepEqual((await client.query("SELECT output FROM report_runs")).rows[0].output, output);
    db.storePlan = originalStore;
    // An already issued row must survive conflict/recovery with its original values.
    await db.storePlan({ ...output.recommendations[0], date: run.report_date, run_id: run.id,
      issued_at: output.issued_at, eligible_session: output.eligible_session });
    const issued = (await client.query("SELECT to_jsonb(r) data FROM trading_reports r WHERE symbol='NVDA'")).rows[0].data;
    const changed = structuredClone(output); changed.recommendations[0].target_price += 1;
    await records.storePlans(run, changed);
    assert.deepEqual((await client.query("SELECT to_jsonb(r) data FROM trading_reports r WHERE symbol='NVDA'")).rows[0].data, issued);
    await records.storePlans(run, output);
    assert.equal((await client.query("SELECT recommendations_stored FROM report_runs")).rows[0].recommendations_stored, true);
    assert.deepEqual((await client.query("SELECT symbol,report_text FROM trading_reports ORDER BY symbol")).rows,
      [{ symbol: "MSFT", report_text: null }, { symbol: "NVDA", report_text: null }]);
    assert.equal((await client.query("SELECT count(*)::int n FROM option_chain_snapshots")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int n FROM option_supplements")).rows[0].n, 0);
    const saved = (await client.query("SELECT output,legacy_report_texts FROM report_runs")).rows[0];
    assert.deepEqual(saved.output, output); assert.deepEqual(saved.legacy_report_texts, []);
    assert.ok(saved.output.optionChainSnapshots.length); assert.ok(saved.output.optionsSupplements.length);
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end();
  }
});
