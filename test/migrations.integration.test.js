const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { migrate, readMigrations, schemaFingerprint } = require("../src/migrations");
const { manifest, assertSchemaVersion } = require("../src/schemaVersion");
const { connectRunDatabase } = require("../src/runInfrastructure");
const url = process.env.TEST_DATABASE_URL;

async function isolated(action) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `migration_test_${crypto.randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: url }); await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    return await action(client, schema);
  } finally { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); }
}
async function legacy(client) { for (const m of readMigrations().slice(0, 4)) await client.query(m.sql); }
async function recorded(client, through) {
  const prefix = readMigrations().slice(0, through);
  for (const migration of prefix) await client.query(migration.sql);
  await client.query(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const m of prefix) await client.query("INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)", [m.version, m.file, m.sha256]);
}
function connectionUrl(schema, readOnly = false) {
  const target = new URL(url);
  target.searchParams.set("options", `-c search_path=${schema}${readOnly ? " -c default_transaction_read_only=on" : ""}`);
  return target.toString();
}
function command(schema, args = []) {
  const result = spawnSync(process.execPath, ["scripts/migrate-db.js", ...args], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, DATABASE_URL: connectionUrl(schema) } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}
function pythonCheck(schema, expected) {
  const code = `import os,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'python'))
from database import Database
db=Database(os.environ['TEST_SCHEMA_URL'])
db.connect()
try:
    assert db.validate_schema() == ${expected ? "True" : "False"}
finally:
    db.close()
`;
  const result = spawnSync(process.env.PYTHON || "python", ["-c", code], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, TEST_SCHEMA_URL: connectionUrl(schema, true) } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("PostgreSQL fresh initialization is ordered/idempotent and Node/Python checks work read-only", { skip: !url }, async () => isolated(async (client, schema) => {
  await assert.rejects(assertSchemaVersion(client), /schema is not current/);
  pythonCheck(schema, false);
  assert.deepEqual(command(schema).applied, [1, 2, 3, 4, 5]);
  assert.deepEqual((await migrate(client)).applied, []);
  assert.deepEqual((await client.query("SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='report_runs' AND column_name='legacy_report_texts'", [schema])).rows, [{ column_default: "'[]'::jsonb" }]);
  await client.query("BEGIN READ ONLY"); await assertSchemaVersion(client); await client.query("COMMIT");
  pythonCheck(schema, true);
  const runtime = await connectRunDatabase({ databaseUrl: connectionUrl(schema, true) });
  try { assert.ok(runtime, "Normal Node startup must work without DDL permission"); }
  finally { if (runtime) await runtime.disconnect(); }
}));

test("PostgreSQL upgrades a recorded prefix and preserves existing plans", { skip: !url }, async () => isolated(async (client, schema) => {
  await recorded(client, 2);
  await client.query("INSERT INTO trading_reports(date,symbol,entry_price,report_text) VALUES('2026-10-21','NVDA',100,'saved before upgrade')");
  const before = (await client.query("SELECT id,date,symbol,entry_price,report_text FROM trading_reports")).rows;
  await assert.rejects(assertSchemaVersion(client), /schema is not current/); pythonCheck(schema, false);
  assert.deepEqual(command(schema).applied, [3, 4, 5]);
  assert.deepEqual((await client.query("SELECT id,date,symbol,entry_price,report_text FROM trading_reports")).rows, before);
  await assertSchemaVersion(client); pythonCheck(schema, true);
}));

test("PostgreSQL explicitly adopts the prior public layout without changing report/evaluation/options data", { skip: !url }, async () => isolated(async (client, schema) => {
  await legacy(client);
  assert.equal(await schemaFingerprint(client, schema), manifest.legacy.fingerprint);
  const run = (await client.query(`INSERT INTO report_runs(run_key,report_date,snapshot,output,email_status)
    VALUES('legacy-public','2026-10-21',$1,$2,'unknown') RETURNING id`, [{ evidence: "retained" }, { report: "saved HTML/evidence" }])).rows[0].id;
  const report = (await client.query(`INSERT INTO trading_reports(date,symbol,entry_price,run_id,issued_at,eligible_session,order_type,evaluation_policy,report_text)
    VALUES('2026-10-21','NVDA',100,$1,'2026-10-21T16:00:00Z','2026-10-22','buy_stop',$2,'original text') RETURNING id`, [run, { version: "preserve" }])).rows[0].id;
  await client.query(`INSERT INTO recommendation_evaluations(report_id,evaluation_version,state,cutoff,terminal,details)
    VALUES($1,'preserve','pending','2026-10-22T20:16:00Z',false,$2)`, [report, { history: "retain" }]);
  await client.query("INSERT INTO evaluation_metrics(date,evaluation_version,summary) VALUES('2026-10-22','preserve',$1)", [{ count: 1 }]);
  await client.query("INSERT INTO option_chain_snapshots(symbol,snapshot_date,expiration,strike,option_type) VALUES('NVDA','2026-10-21','2026-11-25',100,'call')");
  await client.query("INSERT INTO option_supplements(stock_report_id,symbol,strategy) VALUES($1,'NVDA','long_call')", [report]);
  const data = async () => {
    const result = {};
    for (const table of ["report_runs", "trading_reports", "recommendation_evaluations", "evaluation_metrics", "option_chain_snapshots", "option_supplements"]) {
      result[table] = (await client.query(`SELECT to_jsonb(t) - 'legacy_report_texts' AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  };
  const before = await data();
  await assert.rejects(migrate(client), /explicit adoption/);
  assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
  pythonCheck(schema, false);
  const upgraded = command(schema, ["--adopt-existing"]);
  assert.equal(upgraded.adopted, true); assert.deepEqual(upgraded.applied, [5]);
  assert.deepEqual(await data(), before);
  assert.deepEqual((await client.query("SELECT legacy_report_texts FROM report_runs WHERE id=$1", [run])).rows[0].legacy_report_texts, ["original text"]);
  await assertSchemaVersion(client); pythonCheck(schema, true);
}));

test("PostgreSQL refuses unrelated/incomplete legacy schemas, drift and incompatible histories", { skip: !url }, async () => {
  for (const change of ["CREATE TABLE unrelated_private_data(id int)", "ALTER TABLE trading_reports DROP COLUMN risk",
    "ALTER TABLE trading_reports DROP CONSTRAINT trading_reports_trade_direction_check", "DROP INDEX trading_reports_run_symbol",
    "CREATE VIEW extra_view AS SELECT 1", "CREATE TYPE extra_kind AS ENUM ('a','b')"]) {
    await isolated(async client => {
      await legacy(client); await client.query(change);
      await assert.rejects(migrate(client, { adoptExisting: true }), /exact existing public schema/);
      assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
    });
  }
  await isolated(async client => {
    await recorded(client, 4); await client.query("ALTER TABLE trading_reports ADD COLUMN unexpected text");
    await assert.rejects(migrate(client), /has drifted/);
  });
  for (const change of ["DELETE FROM schema_migrations WHERE version=2", "UPDATE schema_migrations SET checksum='changed' WHERE version=1",
    "UPDATE schema_migrations SET name='other.sql' WHERE version=1", "INSERT INTO schema_migrations(version,name,checksum) VALUES(6,'future.sql','future')",
    "DELETE FROM schema_migrations"]) {
    await isolated(async (client, schema) => {
      await migrate(client); await client.query(change);
      await assert.rejects(assertSchemaVersion(client), /schema is not current/);
      pythonCheck(schema, false);
      await assert.rejects(migrate(client), /schema is not current|manual review/);
    });
  }
});

test("PostgreSQL backfills distinct legacy texts without altering frozen outputs or orphan records", { skip: !url }, async () => isolated(async (client, schema) => {
  await recorded(client, 4);
  const outputs = [null, { report: "canonical", html: "frozen HTML", optionChainSnapshots: [{ symbol: "NVDA", contracts: [] }] }, { report: "already saved" }];
  const ids = [];
  for (const [i, output] of outputs.entries()) {
    ids.push((await client.query(`INSERT INTO report_runs(run_key,report_date,status,email_status,snapshot,output)
      VALUES($1,'2026-10-21','completed','unknown',$2,$3) RETURNING id`, [`archive-${i}`, { report_text: "paid response stays frozen" }, output])).rows[0].id);
  }
  for (const [i, texts] of [["duplicate", "duplicate", "different", "", null], ["canonical", "older variant"], ["already saved"]].entries()) {
    for (const [j, text] of texts.entries()) await client.query("INSERT INTO trading_reports(date,symbol,entry_price,run_id,report_text) VALUES('2026-10-21',$1,100,$2,$3)", [`T${j}`, ids[i], text]);
  }
  await client.query("INSERT INTO trading_reports(date,symbol,entry_price,report_text) VALUES('2026-10-21','ORPHAN',100,'unlinked archive')");
  const runs = (await client.query("SELECT to_jsonb(r) data FROM report_runs r ORDER BY run_key")).rows;
  const plans = (await client.query("SELECT to_jsonb(r) data FROM trading_reports r ORDER BY id")).rows;
  assert.deepEqual(command(schema).applied, [5]);
  assert.deepEqual((await client.query("SELECT to_jsonb(r)-'legacy_report_texts' data FROM report_runs r ORDER BY run_key")).rows, runs);
  assert.deepEqual((await client.query("SELECT to_jsonb(r) data FROM trading_reports r ORDER BY id")).rows, plans);
  const archived = (await client.query("SELECT legacy_report_texts FROM report_runs ORDER BY run_key")).rows.map(r => r.legacy_report_texts);
  assert.deepEqual(archived, [["", "different", "duplicate"], ["older variant"], []]);
  for (const [i, output] of outputs.entries()) {
    const original = output?.report;
    for (const text of (await client.query("SELECT report_text FROM trading_reports WHERE run_id=$1 AND report_text IS NOT NULL", [ids[i]])).rows.map(r => r.report_text)) {
      assert.ok(text === original || archived[i].includes(text), "Every linked historical text must remain available at run level");
    }
  }
  assert.deepEqual(command(schema).applied, []);
  assert.deepEqual((await client.query("SELECT legacy_report_texts FROM report_runs ORDER BY run_key")).rows.map(r => r.legacy_report_texts), archived);
  await assertSchemaVersion(client); pythonCheck(schema, true);
}));

test("PostgreSQL migration failure rolls back DDL/history and permits a clean retry", { skip: !url }, async () => isolated(async client => {
  const query = client.query.bind(client), third = readMigrations()[2].sql;
  client.query = (sql, ...args) => sql === third ? Promise.reject(new Error("synthetic migration interruption")) : query(sql, ...args);
  await assert.rejects(migrate(client), /synthetic migration interruption/);
  client.query = query;
  assert.deepEqual((await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()")).rows, []);
  assert.deepEqual((await migrate(client)).applied, [1, 2, 3, 4, 5]);
}));

test("PostgreSQL transaction lock serializes concurrent initialization", { skip: !url }, async () => isolated(async (client, schema) => {
  const other = new Client({ connectionString: url }); await other.connect();
  try {
    await other.query(`SET search_path TO ${schema}`);
    const results = await Promise.all([migrate(client), migrate(other)]);
    assert.deepEqual(results.map(r => r.applied.length).sort(), [0, 5]);
    await assertSchemaVersion(client);
  } finally { await other.end(); }
}));
