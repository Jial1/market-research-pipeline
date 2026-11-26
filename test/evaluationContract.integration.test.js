const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { DatabaseClient } = require("../src/database");
const { migrate } = require("../src/migrations");
const { policy } = require("../src/evaluationPolicy");
const contract = require("../config/evaluation-contract.json");
const fixtures = require("./fixtures/evaluation-contract.json");
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL Node/Python agree on fixed cohorts, inclusive cutoffs, namespaces and versions", { skip: !url }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const schema = `contract_test_${crypto.randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: url }); await client.connect();
  const db = new DatabaseClient(url); db.client = client;
  const cutoff = "2026-11-20T20:16:00Z", boundary = "2026-10-21T20:16:00Z";
  let sequence = 0;
  try {
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`); await migrate(client);
    await client.query("SET TIME ZONE 'America/New_York'");
    const terminal = [...contract.scored_states, ...contract.unfilled_terminal_states];
    const add = async (row, { issued = "2026-11-19T16:00:00Z", evaluated = cutoff, namespace = "", outcome = true } = {}) => {
      const symbol = `S${sequence++}`;
      const run = (await client.query("INSERT INTO report_runs(run_key,report_date,settings) VALUES($1,'2026-11-19',$2) RETURNING id", [symbol, { runNamespace: namespace }])).rows[0];
      await db.storePlan({ ...fixtures.orders[0], symbol, date: "2026-11-19", entry_price: 100, target_price: 110, stop_loss: 95,
        run_id: run.id, issued_at: issued, eligible_session: "2026-11-20", evaluation_policy: policy });
      const id = (await client.query("SELECT id FROM trading_reports WHERE run_id=$1", [run.id])).rows[0].id;
      if (outcome) await client.query(`INSERT INTO recommendation_evaluations(report_id,evaluation_version,state,cutoff,terminal,
        was_entry_hit,gross_return_pct,net_return_pct,ambiguous,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id,row.evaluation_version,row.state,evaluated,terminal.includes(row.state),row.was_entry_hit,row.gross_return_pct,row.net_return_pct,row.ambiguous,row.details]);
      return id;
    };
    const included = [];
    for (const row of Object.values(fixtures.rows)) {
      const id = await add(row); if (row.evaluation_version === policy.version) included.push(id);
    }
    const won = fixtures.rows.won;
    included.push(await add(won, { issued: boundary }));
    included.push(await add(won, { issued: cutoff }));
    const old = await add(won, { issued: "2026-10-21T20:15:59.999Z" });
    await add(won, { issued: "2026-11-20T20:16:00.001Z" });
    await add(won, { evaluated: "2026-11-20T20:16:00.001Z" });
    const other = await add(won, { namespace: "review" });
    await add(won, { outcome: false });
    const cohorts = [
      { version: policy.version, days: contract.feedback_issuance_days, namespace: "" },
      { version: policy.version, days: null, namespace: "" },
      { version: policy.version, days: contract.feedback_issuance_days, namespace: "review" },
      { version: "next-session-v1-cost-8", days: contract.feedback_issuance_days, namespace: "" },
      { version: "missing-version", days: contract.feedback_issuance_days, namespace: "" }
    ];
    const program = `import json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'python'))
from database import Database
from metrics_calculator import summarize_corrected
db=Database(os.environ['CONTRACT_DATABASE_URL'])
db.connect()
try:
    results=[]
    for c in json.loads(os.environ['CONTRACT_COHORTS']):
        rows=db.get_correct_outcomes(os.environ['CONTRACT_CUTOFF'],c['version'],issuance_days=c['days'],namespace=c['namespace'])
        results.append({'ids':sorted(str(r['report_id']) for r in rows),'summary':summarize_corrected(rows,c['version'])})
    print('CONTRACT_RESULTS='+json.dumps(results))
finally:
    db.close()
`;
    const target = new URL(url); target.searchParams.set("options", `-c search_path=${schema} -c default_transaction_read_only=on -c timezone=UTC`);
    const python = spawnSync(process.env.PYTHON || "python", ["-c", program], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
      env: { ...process.env, CONTRACT_DATABASE_URL: target.toString(), CONTRACT_COHORTS: JSON.stringify(cohorts), CONTRACT_CUTOFF: cutoff } });
    assert.equal(python.status, 0, python.stdout + python.stderr);
    const results = JSON.parse(python.stdout.split(/\r?\n/).find(line => line.startsWith("CONTRACT_RESULTS=")).slice("CONTRACT_RESULTS=".length));
    assert.deepEqual(results[0].ids, included.sort());
    assert.deepEqual(results[1].ids, [...included, old].sort());
    assert.deepEqual(results[2].ids, [other]);
    for (const [i, cohort] of cohorts.entries()) {
      if (cohort.days === null) continue; // Python's default remains cumulative.
      const node = await db.getCorrectEvaluationContext(cohort.version, undefined, cohort.namespace, cutoff);
      assert.equal(node.days, 30);
      const { days, ...common } = node;
      assert.deepEqual(common, Object.fromEntries(Object.keys(common).map(key => [key, results[i].summary[key]])));
    }
    assert.equal(results[0].summary.total_plans, 14);
    assert.equal(results[0].summary.filled_closed, 7);
    assert.equal(results[0].summary.net_win_rate, 4 / 7);
    assert.equal(results[0].summary.avg_net_return_pct, 23.5 / 7);
    assert.equal(results[1].summary.total_plans, 15);
    assert.equal(results[3].summary.total_plans, 1);
    assert.equal(results[4].summary.net_win_rate, null);
  } finally { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); }
});
