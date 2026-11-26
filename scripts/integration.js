const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL instance");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.TEST_DATABASE_URL).hostname)) {
  throw new Error("Integration tests accept only local PostgreSQL");
}
const files = fs.readdirSync(path.join(root, "test")).filter(f => f.endsWith(".integration.test.js"));
// Advisory locks are database-wide even when tests isolate their tables by schema.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map(f => `test/${f}`)], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
