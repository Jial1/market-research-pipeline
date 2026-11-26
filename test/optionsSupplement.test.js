const assert = require("assert");
const { selectBestOption } = require("../src/optionsSupplement");
const { getDteTargets, normalizeMarketDataOptionChain } = require("../src/optionsData");

const config = {
  minDte: 14,
  maxDte: 60,
  preferredMinDte: 21,
  preferredMaxDte: 45,
  maxBidAskSpreadPct: 15,
  minOpenInterest: 100,
  minVolume: 10,
  maxPremiumRisk: 800
};

function contract(overrides) {
  return {
    symbol: "NVDA",
    expiration: "2026-08-21",
    days_to_expiration: 35,
    strike: 125,
    bid: 4.2,
    ask: 4.5,
    last: 4.3,
    mid: 4.35,
    volume: 500,
    open_interest: 2000,
    implied_volatility: 0.45,
    gamma: 0.04,
    theta: -0.11,
    vega: 0.18,
    underlying_price: 125,
    ...overrides
  };
}

function run() {
  assert.deepEqual(getDteTargets(config), [33, 28, 42, 21, 45]);

  const marketDataContracts = normalizeMarketDataOptionChain("NVDA", {
    s: "ok",
    optionSymbol: ["NVDA260821C00125000", "NVDA260821P00125000"],
    expiration: [1787342400, 1787342400],
    side: ["call", "put"],
    strike: [125, 125],
    bid: [4.2, 4.1],
    ask: [4.5, 4.4],
    mid: [4.35, 4.25],
    volume: [500, 500],
    openInterest: [2000, 2000],
    underlyingPrice: [125, 125],
    iv: [0.45, 0.46],
    delta: [0.52, -0.48],
    gamma: [0.04, 0.04],
    theta: [-0.11, -0.1],
    vega: [0.18, 0.18],
    dte: [35, 35]
  }, 125);

  assert.equal(marketDataContracts.length, 2);
  assert.equal(marketDataContracts[0].option_symbol, "NVDA260821C00125000");
  assert.equal(marketDataContracts[0].option_type, "call");
  assert.equal(marketDataContracts[0].implied_volatility, 0.45);

  const bullishSetup = {
    symbol: "NVDA",
    trade_direction: "long",
    current_price: 125,
    target_price: 132,
    stop_loss: 121
  };

  const call = selectBestOption(bullishSetup, [
    contract({ option_type: "call", delta: 0.52 }),
    contract({ option_type: "put", delta: -0.48 })
  ], config);

  assert.equal(call.strategy, "long_call");
  assert.equal(call.review_label, "candidate");
  assert.equal(call.expiration_breakeven, 129.35);
  assert(call.scenario_return_at_stock_target_5d > 0);
  assert(call.scenario_return_at_stock_stop_3d < 0);

  const bearishSetup = {
    symbol: "NVDA",
    trade_direction: "short",
    current_price: 125,
    target_price: 118,
    stop_loss: 129
  };

  const put = selectBestOption(bearishSetup, [
    contract({ option_type: "call", delta: 0.52 }),
    contract({ option_type: "put", delta: -0.48 })
  ], config);

  assert.equal(put.strategy, "long_put");
  assert(put.scenario_return_at_stock_target_5d > 0);
  assert(put.scenario_return_at_stock_stop_3d < 0);

  const skipped = selectBestOption(bullishSetup, [
    contract({ option_type: "call", bid: 1, ask: 2, mid: 1.5, open_interest: 5 })
  ], config);

  assert.equal(skipped.strategy, "skip_options");
  assert.equal(skipped.review_label, "skip");
  assert(skipped.skip_reason);

}

run();
console.log("Options filtering, direction, pricing and normalization passed");
