// One fixed synthetic report through the ordinary pipeline; no accounts required.
const fs = require("node:fs");
const path = require("node:path");
const { runReport } = require("../src/reportRun");
const { buildOptionsSupplements } = require("../src/optionsSupplement");
const { makeDemoFixture, syntheticOptionChain } = require("../fixtures/demo");
const { createConfig, root } = require("../src/config");

async function renderDemo(fixture = makeDemoFixture(), runner = runReport, fetchChain = syntheticOptionChain) {
  const settings = { ...createConfig({}, { watchlist: ["NVDA", "MSFT"] }), model: "saved-synthetic-response" };
  let artifact;
  const forbidden = async () => { throw new Error("Offline demo attempted an external side effect"); };
  await runner(settings, { dryRun: true }, {
    now: () => fixture.now, collectInputs: async () => structuredClone(fixture.inputs),
    generateReport: async () => ({ content: fixture.report }), connectDatabase: forbidden, sendEmail: forbidden,
    buildOptions: (plans, quotes, snapshots) => buildOptionsSupplements(plans, quotes, settings.options, snapshots, { fetchChain }),
    writeArtifact: value => { artifact = value; return "offline-demo"; }
  });
  return artifact;
}

async function demo() {
  const artifact = await renderDemo();
  const report = path.join(root, "local-data/demo/report.html");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, artifact.output.html);
  console.log("Synthetic inputs dated October 21, 2026; hypothetical research only.");
  console.log(`Offline report: ${report}`);
  return { status: "offline_demo", report };
}
if (require.main === module) demo().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { demo, renderDemo };
