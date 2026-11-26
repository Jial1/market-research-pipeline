const manifest = require("../config/database-schema.json");
const mismatch = () => new Error("Portfolio schema is not current; run npm run db:migrate (see the existing-schema adoption guide)");

function schemaIdentifier(schema) {
  if (typeof schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)
    || schema.toLowerCase().startsWith("pg_") || schema.toLowerCase() === "information_schema") throw new Error("Select a dedicated public-project schema");
  return `"${schema}"`;
}

async function currentSchema(client) {
  const schema = (await client.query("SELECT current_schema() AS schema_name")).rows[0]?.schema_name;
  schemaIdentifier(schema);
  return schema;
}

function assertHistory(rows, allowPending = false) {
  if ((!allowPending && rows.length !== manifest.migrations.length) || rows.length > manifest.migrations.length
    || rows.some((row, i) => row.version !== manifest.migrations[i].version
      || row.name !== manifest.migrations[i].file || row.checksum !== manifest.migrations[i].sha256)) throw mismatch();
}

async function assertSchemaVersion(client) {
  const schema = schemaIdentifier(await currentSchema(client));
  const ledger = (await client.query("SELECT to_regclass($1) AS ledger", [`${schema}.schema_migrations`])).rows[0].ledger;
  if (!ledger) throw mismatch();
  assertHistory((await client.query(`SELECT version,name,checksum FROM ${schema}.schema_migrations ORDER BY version`)).rows);
}

module.exports = { manifest, schemaIdentifier, currentSchema, assertHistory, assertSchemaVersion };
