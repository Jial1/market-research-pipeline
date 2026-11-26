const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readMigrations } = require("../src/migrations");
const { manifest, assertHistory, assertSchemaVersion } = require("../src/schemaVersion");
const history = () => manifest.migrations.map(m => ({ version: m.version, name: m.file, checksum: m.sha256 }));

test("missing, newer, renamed and altered migration history cannot satisfy the runtime contract", () => {
  assert.doesNotThrow(() => assertHistory(history()));
  assert.doesNotThrow(() => assertHistory(history().slice(0, 2), true));
  const changed = history(); changed[1].checksum = "changed";
  const renamed = history(); renamed[0].name = "other.sql";
  for (const rows of [[], history().slice(0, -1), [...history(), { version: 6 }], changed, renamed, history().filter(r => r.version !== 2)]) {
    assert.throws(() => assertHistory(rows), /schema is not current/);
  }
});

test("migration checksums tolerate checkout line endings but reject edited or unlisted SQL", () => {
  const base = path.resolve(__dirname, "../local-data"); fs.mkdirSync(base, { recursive: true });
  const folder = fs.mkdtempSync(path.join(base, "migration-check-"));
  try {
    for (const m of readMigrations()) fs.writeFileSync(path.join(folder, m.file), m.sql.replace(/\n/g, "\r\n"));
    assert.equal(readMigrations(folder).length, 5);
    const first = path.join(folder, manifest.migrations[0].file), original = fs.readFileSync(first);
    fs.appendFileSync(first, "\n-- edited migration\n");
    assert.throws(() => readMigrations(folder), /checksum changed/);
    fs.writeFileSync(first, original); fs.writeFileSync(path.join(folder, "006_unlisted.sql"), "SELECT 1;");
    assert.throws(() => readMigrations(folder), /ordered manifest/);
  } finally {
    for (const file of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, file));
    fs.rmdirSync(folder);
  }
});

test("runtime schema verification uses only SELECTs and binds the selected schema explicitly", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values }); assert.match(sql, /^SELECT /);
    if (sql.includes("current_schema")) return { rows: [{ schema_name: "portfolio_test" }] };
    if (sql.includes("to_regclass")) { assert.deepEqual(values, ['"portfolio_test".schema_migrations']); return { rows: [{ ledger: "schema_migrations" }] }; }
    assert.match(sql, /FROM "portfolio_test"\.schema_migrations/); return { rows: history() };
  } };
  await assertSchemaVersion(client); assert.equal(calls.length, 3);
  await assert.rejects(assertSchemaVersion({ query: async () => ({ rows: [{ schema_name: "pg_catalog" }] }) }), /dedicated public-project schema/);
  await assert.rejects(assertSchemaVersion({ query: async sql => ({ rows: [sql.includes("current_schema") ? { schema_name: "portfolio_test" } : { ledger: null }] }) }), /schema is not current/);
});
