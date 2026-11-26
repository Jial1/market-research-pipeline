// Edge cases stay in tests; the public demo produces only the market-open report.
const { makeDemoFixture, syntheticOptionChain } = require("../../fixtures/demo");
const { renderDemo } = require("../../scripts/demo");
const { runReport } = require("../../src/reportRun");
const scenarios = ["market-open", "overnight", "earnings-conflict", "unavailable-data", "options-unavailable"];

function makeScenario(name) {
  if (!scenarios.includes(name)) throw new Error(`Unknown scenario: ${name}`);
  const fixture = makeDemoFixture(Date.parse(name === "market-open" || name === "options-unavailable"
    ? "2026-10-21T16:00:00Z" : "2026-10-21T12:00:00Z"));
  if (name === "earnings-conflict") {
    fixture.inputs.evidence.earnings.NVDA = { ...structuredClone(fixture.inputs.evidence.earnings.MSFT), symbol: "NVDA",
      events: fixture.inputs.evidence.earnings.MSFT.events.map(e => ({ ...e, symbol: "NVDA" })) };
  }
  if (name === "unavailable-data") {
    fixture.inputs.quotes[0].price = null;
    fixture.inputs.quotes[0].quality = { enforced: true, status: "invalid", actionable: false, reasons: ["quote_unavailable"] };
    fixture.inputs.evidence.histories.NVDA.candles = fixture.inputs.evidence.histories.NVDA.candles.slice(-50);
  }
  return fixture;
}

function renderScenario(name, runner = runReport) {
  return renderDemo(makeScenario(name), runner, name === "options-unavailable" ? async () => [] : syntheticOptionChain);
}

module.exports = { scenarios, makeScenario, renderScenario, syntheticOptionChain };
