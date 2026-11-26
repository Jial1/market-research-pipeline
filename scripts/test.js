const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = fs.readdirSync(path.join(root, "test")).filter(f => f.endsWith(".test.js") && !f.endsWith(".integration.test.js"));
const result = spawnSync(process.execPath, ["--test", ...files.map(f => `test/${f}`)], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
