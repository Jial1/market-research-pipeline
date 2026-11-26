const { Client } = require("pg");
const { loadEnvironment } = require("../src/config");
const { migrate } = require("../src/migrations");
const { sanitize } = require("../src/runInfrastructure");

async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== "--adopt-existing")) throw new Error("Usage: npm run db:migrate [-- --adopt-existing]");
  loadEnvironment();
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the dedicated public-project database");
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  try { await client.connect(); return await migrate(client, { adoptExisting: args.includes("--adopt-existing") }); }
  finally { await client.end(); }
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(sanitize(error.message)); process.exitCode = 1;
});
module.exports = { main };
