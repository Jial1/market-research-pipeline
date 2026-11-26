const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { manifest, schemaIdentifier, currentSchema, assertHistory } = require("./schemaVersion");
const directory = path.resolve(__dirname, "../sql/migrations");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

function readMigrations(folder = directory) {
  const entries = manifest.migrations;
  if (JSON.stringify(fs.readdirSync(folder).filter(n => n.endsWith(".sql")).sort()) !== JSON.stringify(entries.map(m => m.file))) {
    throw new Error("Migration files must match the ordered manifest");
  }
  return entries.map((entry, i) => {
    if (entry.version !== i + 1 || !/^\d{3}_[a-z0-9_]+\.sql$/.test(entry.file)) throw new Error("Invalid migration order");
    const sql = fs.readFileSync(path.join(folder, entry.file), "utf8").replace(/\r\n/g, "\n");
    if (hash(sql) !== entry.sha256) throw new Error(`Migration checksum changed: ${entry.file}`);
    return { ...entry, sql };
  });
}

// A frozen catalog signature identifies the pre-versioned PUBLIC edition.
// No row contents, owners, schema names or relation OIDs enter this signature.
async function schemaFingerprint(client, schema) {
  const rows = [];
  for (const query of [
    `SELECT * FROM (SELECT c.relname::text AS name,c.relkind::text AS kind,c.relpersistence::text AS persistence,c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>'schema_migrations'
      UNION ALL SELECT p.proname,'function','',false FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
      UNION ALL SELECT t.tgname,'trigger','',false FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal
      UNION ALL SELECT p.polname,'policy','',false FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
      UNION ALL SELECT t.typname,'type','',false FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=$1 AND t.typrelid=0 AND t.typelem=0 AND t.typtype IN ('e','d','r','m','b')
      UNION ALL SELECT r.rulename,'rule','',false FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND r.rulename<>'_RETURN'
      ) objects ORDER BY name COLLATE "C",kind COLLATE "C"`,
    `SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
        replace(pg_get_expr(d.adbin,d.adrelid),quote_ident($1)||'.','') AS default_value,a.attidentity AS identity,a.attgenerated AS generated
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname<>'schema_migrations' AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname COLLATE "C",a.attnum`,
    `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS validated,
        replace(pg_get_constraintdef(k.oid,false),quote_ident($1)||'.','') AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname<>'schema_migrations' ORDER BY c.relname COLLATE "C",k.conname COLLATE "C"`,
    `SELECT c.relname AS table_name,i.relname AS name,x.indisvalid AS valid,x.indisready AS ready,
        replace(pg_get_indexdef(i.oid),quote_ident($1)||'.','') AS definition
      FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname<>'schema_migrations'
      ORDER BY c.relname COLLATE "C",i.relname COLLATE "C"`
  ]) rows.push((await client.query(query, [schema])).rows);
  return hash(JSON.stringify(rows));
}

async function migrate(client, { adoptExisting = false } = {}) {
  const migrations = readMigrations(); // Verify immutable files before touching the database.
  await client.query("BEGIN");
  try {
    const name = await currentSchema(client), schema = schemaIdentifier(name);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`portfolio-migrations:${name}`]);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    const ledger = (await client.query("SELECT to_regclass($1) AS ledger", [`${schema}.schema_migrations`])).rows[0].ledger;
    let adopted = false, rows = [];
    if (!ledger) {
      const fingerprint = await schemaFingerprint(client, name);
      // Empty schemas have four empty catalog query results.
      const empty = fingerprint === hash(JSON.stringify([[], [], [], []]));
      if (!empty && (!adoptExisting || fingerprint !== manifest.legacy.fingerprint)) {
        throw new Error("Unversioned schema is not empty; explicit adoption requires the exact existing public schema");
      }
      await client.query(`CREATE TABLE ${schema}.schema_migrations (
        version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      if (!empty) {
        for (const migration of migrations.filter(m => m.version <= manifest.legacy.through_version)) {
          await client.query(`INSERT INTO ${schema}.schema_migrations(version,name,checksum) VALUES($1,$2,$3)`, [migration.version, migration.file, migration.sha256]);
        }
        adopted = true;
      }
    }
    rows = (await client.query(`SELECT version,name,checksum FROM ${schema}.schema_migrations ORDER BY version`)).rows;
    assertHistory(rows, true);
    if (ledger && !rows.length) throw new Error("Empty migration history requires manual review");
    if (rows.length === manifest.legacy.through_version && await schemaFingerprint(client, name) !== manifest.legacy.fingerprint) {
      throw new Error("Existing public schema has drifted; no migrations applied");
    }
    const applied = [];
    for (const migration of migrations.slice(rows.length)) {
      await client.query(migration.sql);
      if (migration.version === manifest.legacy.through_version && await schemaFingerprint(client, name) !== manifest.legacy.fingerprint) {
        throw new Error("Public schema does not match its frozen baseline");
      }
      await client.query(`INSERT INTO ${schema}.schema_migrations(version,name,checksum) VALUES($1,$2,$3)`, [migration.version, migration.file, migration.sha256]);
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return { schema: name, version: migrations.at(-1).version, applied, adopted };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
}

module.exports = { readMigrations, schemaFingerprint, migrate };
