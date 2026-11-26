const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const ignored = new Set(["node_modules", ".venv", "local-data", "__pycache__", ".git"]);
function files(folder = root) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => ignored.has(entry.name) ? []
    : entry.isDirectory() ? files(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
}
function check() {
  const names = files();
  for (const file of names) {
    const relative = path.relative(root, file);
    assert.ok(!/^\.env(?!\.example$)/.test(path.basename(file)), `Do not publish environment files: ${relative}`);
    assert.ok(!/\.(?:log|sql\.dump|pem|p12|key)$/i.test(file), `Unexpected private artifact: ${relative}`);
    if (/\.png$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (relative.startsWith(`examples${path.sep}`) && /\.(?:html|json)$/.test(file)) {
      assert.ok(!/\p{Script=Han}/u.test(text), `Non-English demo content in ${relative}`);
    }
    assert.ok(!/[A-Z]:[\\/]Users[\\/]/i.test(text), `Personal absolute path in ${relative}`);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Private key in ${relative}`);
    assert.ok(!/\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}/.test(text), `Possible API key in ${relative}`);
    if (relative.startsWith(`src${path.sep}`)) {
      assert.ok(!/storeReport\(|storeOptionChainSnapshots|storeOptionSupplement|INSERT INTO option_(?:chain_snapshots|supplements)/.test(text), `Retired duplicate persistence in ${relative}`);
      if (["database.js", "runRecords.js"].includes(path.basename(file))) {
        assert.ok(!/report_text/.test(text), `Per-stock report text write in ${relative}`);
      }
      if (!["migrations.js", "schemaVersion.js"].includes(path.basename(file))) {
        assert.ok(!/applyRunMigration|runSafeMigrations|CREATE TABLE|ALTER TABLE/.test(text), `Runtime schema mutation in ${relative}`);
      }
      assert.ok(!/discord|optionsResearch|reconcileDelivery/i.test(text), `Excluded component in ${relative}`);
      assert.ok(!/fetchFinnhubOptionChain|normalizeFinnhubOptionChain|stock\/option-chain/.test(text), `Retired options-provider code in ${relative}`);
      assert.ok(!/PREPARATION_JSON|RECOMMENDATIONS_JSON|reportText|reportParser/.test(text), `Retired model-output path in ${relative}`);
      for (const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        assert.ok([target, `${target}.js`, `${target}.json`, path.join(target, "index.js")].some(p => fs.existsSync(p)),
          `Missing local dependency ${match[1]} in ${relative}`);
      }
    }
  }
  const pkg = require("../package.json");
  assert.ok(!pkg.dependencies["discord.js"]);
  const lock = require("../package-lock.json");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.ok(!Object.keys(lock.packages).some(name => name.includes("discord")));
  const schema = require("../src/migrations").readMigrations().map(m => m.sql).join("\n");
  assert.ok(!/CREATE TABLE IF NOT EXISTS (?:recommendation_outcomes|daily_metrics)/.test(schema));
  assert.ok(!fs.existsSync(path.join(root, "sql/schema.sql")), "Keep schema DDL only in ordered migrations");
  assert.ok(!fs.existsSync(path.join(root, "scripts/init-db.js")), "Keep one explicit migration command");
  for (const required of ["README.md", ".env.example", "docs/setup.md", "docs/evaluation.md", "docs/release.md",
    "config/database-schema.json", "scripts/migrate-db.js", "docs/database-migrations.md",
    "config/evaluation-contract.json", "docs/evaluation-contract.md", "test/fixtures/evaluation-contract.json",
    "examples/report-preview.png", "fixtures/demo.js", "test/fixtures/report-facts-baseline.json",
    "docs/model-analysis.md", "docs/report-document.md"]) {
    assert.ok(fs.existsSync(path.join(root, required)), `Missing release artifact ${required}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, "examples")), ["report-preview.png"], "Publish only the README preview; generate reports under local-data");
  console.log(`Release checks passed for ${names.length} publishable files (local dependencies, scope, lockfile and common secret/path patterns).`);
  return names;
}
if (require.main === module) check();
module.exports = { check, files };
