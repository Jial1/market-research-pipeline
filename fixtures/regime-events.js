const { makeHistoricalFixture, NOW } = require("./historical-report");
const { normalizeEarnings } = require("../src/data/earnings");

function makeRegimeFixture() {
  const fixture = makeHistoricalFixture({ NVDA: 200, MSFT: 200 });
  fixture.inputs.evidence.histories.SPY = { ...structuredClone(fixture.inputs.evidence.histories.NVDA), symbol: "SPY" };
  fixture.inputs.evidence.earnings = Object.fromEntries(["NVDA", "MSFT"].map(symbol => [symbol,
    normalizeEarnings(symbol, { earningsCalendar: symbol === "MSFT" ? [{ symbol, date: "2026-10-28", hour: "amc" }] : [] },
      { from: "2026-10-22", to: "2026-10-28", now: NOW })]));
  return fixture;
}
module.exports = { makeRegimeFixture, NOW };
