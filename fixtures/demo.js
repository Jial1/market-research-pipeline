const { makePreparationFixture } = require("./preparation-report");

function makeDemoFixture(now = Date.parse("2026-10-21T16:00:00Z")) {
  const fixture = makePreparationFixture(now);
  const analysis = JSON.parse(fixture.report);
  analysis.recommendations = analysis.recommendations.map(plan => ({ ...plan,
    structure: "The short-term moving average is above the medium-term average; confirm the trend with fresh quotes.",
    momentum: "Completed daily bars indicate relative strength; historical trends do not guarantee continuation.",
    catalyst: "No verified news catalyst was supplied in this synthetic example.",
    reason: "Consider entry only after a break above the reference price; abandon the idea if invalidated.",
    risk: "Quotes may gap; earnings coverage still needs review." }));
  fixture.report = JSON.stringify(analysis);
  return fixture;
}

function syntheticOptionChain(symbol, price, { optionSide = "call" } = {}) {
  return [{ symbol, option_symbol: `${symbol}-SYNTHETIC-${optionSide.toUpperCase()}`, option_type: optionSide,
    expiration: "2026-11-25", days_to_expiration: 35, strike: price, underlying_price: price,
    bid: 4.2, ask: 4.5, last: 4.3, mid: 4.35, volume: 500, open_interest: 2000,
    implied_volatility: .45, delta: optionSide === "put" ? -.52 : .52, gamma: .04, theta: -.11, vega: .18 }];
}

module.exports = { makeDemoFixture, syntheticOptionChain };
