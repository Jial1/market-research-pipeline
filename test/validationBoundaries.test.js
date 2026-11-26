const { amendReport } = require("../fixtures/model-analysis");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { qualifyRecommendations } = require("../src/recommendations");
const { selectBestOption } = require("../src/optionsSupplement");
const { calculateMid, bidAskSpreadPct } = require("../src/optionsMath");
const { RunRecords } = require("../src/runRecords");
const { runReport } = require("../src/reportRun");
const { createConfig } = require("../src/config");
const { makeScenario } = require("./fixtures/report-scenarios");

const plan = { symbol: "NVDA", trade_direction: "long", entry_prediction: "breakout",
  entry_price: 100, target_price: 110, stop_loss: 95, setup_score: 80 };
const quotes = ["NVDA", "MSFT"].map(symbol => ({ symbol, price: 100,
  quality: { enforced: true, actionable: true }, historical: { enforced: true, eligible: true } }));
const parse = rows => qualifyRecommendations(rows, quotes, { requireHistorical: true });

test("stock plan prices must be finite positive JSON numbers", () => {
  for (const field of ["entry_price", "target_price", "stop_loss"]) {
    for (const value of [-1, 0, "100", "USD 100, not verified", "", true, null, undefined, NaN, Infinity]) {
      assert.deepEqual(parse([{ ...plan, [field]: value }]), [], `${field}: ${String(value)}`);
    }
  }
  assert.deepEqual(parse([{ ...plan, entry_price: -100, target_price: -90, stop_loss: -105 }]), []);
  assert.equal(parse([plan]).length, 1);
  assert.equal(parse([{ ...plan, trade_direction: "short", target_price: 90, stop_loss: 105 }]).length, 1);
});

test("unknown or missing JSON directions are rejected instead of becoming long", () => {
  for (const trade_direction of [undefined, null, "", "sideways", "bullish", "bearish", "buy", "sell", true, 1, {}, { toString: null }]) {
    assert.deepEqual(parse([{ ...plan, trade_direction }]), [], JSON.stringify(trade_direction));
  }
  assert.equal(parse([{ ...plan, trade_direction: " LONG " }])[0].trade_direction, "long");
});

test("all rows for a duplicate symbol are rejected, including mixed-case and invalid duplicates", () => {
  const other = { ...plan, symbol: "MSFT" };
  for (const duplicate of [{ ...plan, entry_price: 101, target_price: 120 },
    { ...plan, symbol: " nvda " }, { ...plan, entry_price: -100 }]) {
    const result = parse([plan, duplicate, other]);
    assert.deepEqual(result.map(p => p.symbol), ["MSFT"]);
  }
  assert.deepEqual(parse([plan, plan]), []);
});

const options = createConfig({}).options;
const setup = { ...plan, current_price: 125, target_price: 132, stop_loss: 121 };
const contract = { symbol: "NVDA", option_type: "call", expiration: "2026-11-25", days_to_expiration: 35,
  strike: 125, bid: 4.2, ask: 4.5, last: 4.3, volume: 500, open_interest: 2000,
  implied_volatility: .45, delta: .52, gamma: .04, theta: -.11, vega: .18, underlying_price: 125 };

test("crossed, nonpositive and nonfinite option quotes never reach candidate scoring", () => {
  for (const invalid of [{ bid: 5, ask: 4 }, { bid: -1 }, { ask: -1 }, { bid: 0 }, { ask: 0 },
    { bid: null }, { ask: undefined }, { bid: NaN }, { ask: Infinity }]) {
    const result = selectBestOption(setup, [{ ...contract, ...invalid }], options);
    assert.equal(result.strategy, "skip_options", JSON.stringify(invalid));
    assert.equal(result.review_label, "skip");
    assert.equal(result.option_score, undefined, "Invalid quotes must be filtered before scoring");
  }
  assert.equal(calculateMid(5, 4, 4.5), null);
  assert.equal(bidAskSpreadPct(5, 4, 4.5), null);
  assert.equal(selectBestOption(setup, [contract], options).review_label, "candidate");
  const locked = selectBestOption(setup, [{ ...contract, bid: 4.3, ask: 4.3 }], options);
  assert.equal(locked.bid_ask_spread_pct, 0);
  assert.equal(locked.review_label, "candidate");
});

test("an invalid option does not hide a valid contract from the same chain", () => {
  const result = selectBestOption(setup, [{ ...contract, bid: 5, ask: 4, option_symbol: "BAD" },
    { ...contract, option_symbol: "GOOD" }], options);
  assert.equal(result.option_symbol, "GOOD");
  assert.equal(result.review_label, "candidate");
});

test("storage rejects invalid or duplicate plans before issuing any SQL", async () => {
  const records = new RunRecords({ client: { query: () => assert.fail("Rejected output must not reach SQL") } });
  for (const recommendations of [[plan, { ...plan, symbol: " nvda " }], [{ ...plan, entry_price: -100 }],
    [{ ...plan, trade_direction: "sideways" }], [{ ...plan, entry_price: "100" }]]) {
    await assert.rejects(records.storePlans({ id: "unused" }, { recommendations }), /Duplicate recommendation|Invalid recommendation/);
  }
});

test("report orchestration never renders malformed or duplicate stock plans as approved cards", async () => {
  const fixture = makeScenario("market-open");
  for (const rows of [[{ ...plan, entry_price: -100, target_price: -90, stop_loss: -105 }],
    [{ ...plan, trade_direction: "sideways" }], [plan, { ...plan, target_price: 120 }]]) {
    const response = amendReport(fixture.report, a => { a.recommendations = rows; });
    let artifact;
    await runReport({ ...createConfig({}), options: { enabled: false } }, { dryRun: true }, {
      now: () => fixture.now, collectInputs: async () => structuredClone(fixture.inputs), generateReport: async () => ({ content: response }),
      writeArtifact: value => { artifact = value; return "validation-test"; },
      sendEmail: () => assert.fail("dry runs must not send email"), connectDatabase: () => assert.fail("dry runs must not use a database")
    });
    assert.deepEqual(artifact.output.recommendations, []);
    assert.match(artifact.output.html, /Approved plans: 0/);
    assert.doesNotMatch(artifact.output.html, /Approved plan · Long|Options Supplement: CALL/);
  }
});
