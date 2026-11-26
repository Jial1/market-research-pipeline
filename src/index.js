const { runReport } = require("./reportRun");

async function main(overrides = {}) {
  const settings = overrides.settings;
  if (!settings) throw new Error("Pass settings created at the application entry point");
  return runReport(settings, overrides.runOptions, overrides.runDependencies);
}

async function cli(args = process.argv.slice(2)) {
  if (!args.length) return require("../scripts/demo").demo();
  if (!args.includes("--live") || args.some(a => !["--live", "--email"].includes(a))) {
    throw new Error("Usage: npm start (offline demo), or npm run report:live [-- --email]");
  }
  const { loadEnvironment, createConfig } = require("./config");
  loadEnvironment();
  const settings = createConfig();
  settings.delivery.email = args.includes("--email");
  const runDependencies = require("./composition").createLiveDependencies(settings);
  const result = await main({ settings, runDependencies });
  console.log(JSON.stringify(result, null, 2));
  if (["research_only", "delivery_unknown"].includes(result.status)) process.exitCode = 1;
  return result;
}
if (require.main === module) cli().catch(error => {
  console.error(require("./runInfrastructure").sanitize(error.message)); process.exitCode = 1;
});
module.exports = { main, cli };
