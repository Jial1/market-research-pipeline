const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchOptionChain } = require("../src/optionsData");
const { buildOptionsSupplements } = require("../src/optionsSupplement");
const { createConfig } = require("../src/config");

const config = { ...createConfig({}, { watchlist: ["NVDA"] }).options,
  marketDataToken: "synthetic-options-token", marketDataDteTargets: [21, 35] };
const payload = {
  s: "ok", optionSymbol: ["SYNTHETIC-CALL", "SYNTHETIC-PUT"], side: ["call", "put"],
  expiration: ["2026-11-25", "2026-11-25"], strike: [125, 125], bid: [4.2, 4.1], ask: [4.5, 4.4],
  mid: [4.35, 4.25], volume: [500, 500], openInterest: [2000, 2000], underlyingPrice: [125, 125],
  iv: [.45, .46], delta: [.52, -.48], gamma: [.04, .04], theta: [-.11, -.10], vega: [.18, .18], dte: [35, 35]
};

test("retired provider selectors and credential aliases fail clearly at configuration", () => {
  for (const selector of ["finnhub", "marketdata", "marketdata.app", "unknown"]) {
    assert.throws(() => createConfig({ OPTIONS_DATA_PROVIDER: selector }, { watchlist: ["NVDA"] }), /OPTIONS_DATA_PROVIDER was removed/);
  }
  assert.throws(() => createConfig({ MARKETDATA_API_KEY: "old-alias" }, { watchlist: ["NVDA"] }), /use MARKETDATA_TOKEN/);
  assert.equal(Object.hasOwn(config, "provider"), false);
});

test("options requests cannot select a legacy provider or silently ignore its selector", async () => {
  for (const provider of ["finnhub", "marketdata", "unknown"]) {
    await assert.rejects(fetchOptionChain("NVDA", 125, { ...config, provider }, {
      get: () => assert.fail("A retired selector must be rejected before HTTP")
    }), /provider selection was removed/);
  }
});

test("missing explicit token cannot fall back to ambient MarketData or Finnhub credentials", async () => {
  const previous = Object.fromEntries(["MARKETDATA_TOKEN", "MARKETDATA_API_KEY", "FINNHUB_API_KEY"].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(previous)) process.env[key] = "unused-ambient-credential";
    await assert.rejects(fetchOptionChain("NVDA", 125, {}, {
      get: () => assert.fail("Missing explicit token must not make HTTP requests")
    }), /^Error: Missing MARKETDATA_TOKEN$/);
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("MarketData requests preserve auth/query parameters, call/put fields and contract deduplication", async () => {
  const calls = [];
  const contracts = await fetchOptionChain("NVDA", 125, { ...config, optionSide: "call", marketDataMode: "cached" }, {
    get: async (url, options) => {
      assert.equal(url, "https://api.marketdata.app/v1/options/chain/NVDA/");
      assert.equal(options.headers.Authorization, `Bearer ${config.marketDataToken}`);
      assert.equal(options.timeout, 15000);
      assert.equal(options.params.side, "call"); assert.equal(options.params.mode, "cached");
      assert.equal(options.params.strikeLimit, 12); calls.push(options.params.dte);
      return { status: 200, data: payload };
    }
  });
  assert.deepEqual(calls, [21, 35]);
  assert.equal(contracts.length, 2, "Overlapping maturity requests must not duplicate contracts");
  assert.deepEqual(contracts.map(c => c.option_type), ["call", "put"]);
  assert.equal(contracts[0].bid, 4.2); assert.equal(contracts[0].mid, 4.35);
  assert.equal(contracts[1].delta, -.48); assert.equal(contracts[1].underlying_price, 125);
});

test("empty and HTTP 204 chains remain empty without switching providers", async () => {
  for (const response of [{ status: 204 }, { status: 200, data: { s: "no_data" } }]) {
    let calls = 0;
    const contracts = await fetchOptionChain("NVDA", 125, config, {
      get: async url => { calls++; assert.match(url, /^https:\/\/api\.marketdata\.app\//); return response; }
    });
    assert.deepEqual(contracts, []); assert.equal(calls, 2);
  }
});

test("a successful maturity survives partial failures and total failure is explicit", async () => {
  const partial = await fetchOptionChain("NVDA", 125, config, {
    get: async (url, options) => {
      if (options.params.dte === 21) throw new Error("synthetic service failure");
      return { status: 200, data: payload };
    }
  });
  assert.equal(partial.length, 2);
  await assert.rejects(fetchOptionChain("NVDA", 125, config, {
    get: async () => { throw new Error("synthetic service failure"); }
  }), /MarketData.app request failed/);
});

test("unavailable MarketData remains an options skip while stock research can continue", async () => {
  const supplements = await buildOptionsSupplements([
    { symbol: "NVDA", trade_direction: "long", target_price: 132, stop_loss: 121 }
  ], [{ symbol: "NVDA", price: 125 }], { ...config, marketDataToken: undefined }, [], {
    fetchChain: (symbol, price, settings) => fetchOptionChain(symbol, price, settings, {
      get: () => assert.fail("Missing options token must not call any provider")
    })
  });
  assert.equal(supplements[0].strategy, "skip_options");
  assert.match(supplements[0].skip_reason, /Missing MARKETDATA_TOKEN/);
});
