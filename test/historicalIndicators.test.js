const { qualifyReportInputs, earningsRequestWindow } = require("../src/qualification");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculateIndicators } = require("../src/data/indicators");
const { withHistoricalIndicators } = require("../src/data/historicalInputs");
const { collectReportInputs } = require("../src/data/reportInputs");
const { qualifyRecommendations } = require("../src/recommendations");
const { runReport } = require("../src/reportRun");
const { makeHistoricalFixture, NOW } = require("../fixtures/historical-report");
const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, execution: {  }, options: { enabled: false } };
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const line = n => Array.from({ length: n }, (_, i) => {
  const close = i + 1;
  return { date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: close, high: close + 1, low: Math.max(.5, close - 1), close };
});

test("independent arithmetic: SMA, closed-close returns, ATR14 and last-20 extrema", () => {
  const { values: v } = calculateIndicators(line(200));
  closeTo(v.sma20, 190.5); closeTo(v.sma50, 175.5); closeTo(v.sma200, 100.5);
  closeTo(v.return5d, 100 * (200/195 - 1)); closeTo(v.return20d, 100/9); closeTo(v.return50d, 100/3);
  closeTo(v.atr14, 2); assert.equal(v.range20Low, 180); assert.equal(v.range20High, 201);
});

test("exact window boundaries preserve nulls, including optional SMA200", () => {
  for (const n of [0, 5, 6, 14, 15, 19, 20, 21, 49, 50, 51, 199, 200]) {
    const f = calculateIndicators(line(n));
    for (const period of [20, 50, 200]) assert.equal(f.values[`sma${period}`] !== null, n >= period);
    for (const period of [5, 20, 50]) assert.equal(f.values[`return${period}d`] !== null, n > period);
    assert.equal(f.values.atr14 !== null, n >= 15);
    assert.equal(f.values.range20Low !== null, n >= 20);
    assert.equal(f.status === "ok", n >= 51);
  }
});

test("ATR is simple mean of 14 true ranges, includes gaps and excludes older ranges", () => {
  const bars = line(15).map(c => ({ ...c, open: 100, high: 101, low: 99, close: 100 }));
  bars[14] = { ...bars[14], open: 110, high: 112, low: 109, close: 111 };
  closeTo(calculateIndicators(bars).values.atr14, 38/14);
  const oldGap = line(16).map(c => ({ ...c, open: 100, high: 101, low: 99, close: 100 }));
  oldGap[0] = { ...oldGap[0], open: 1, high: 1, low: 1, close: 1 };
  closeTo(calculateIndicators(oldGap).values.atr14, 2);
});

test("malformed bars, duplicates and order changes never become measured values", () => {
  const bars = line(51);
  for (const bad of [[...bars, bars.at(-1)], bars.toReversed(), [{ ...bars[0], close: NaN }, ...bars.slice(1)],
    [{ ...bars[0], date: "2026-02-30" }, ...bars.slice(1)], [{ ...bars[0], high: .1 }, ...bars.slice(1)]]) {
    const result = calculateIndicators(bad);
    assert.equal(result.status, "invalid");
    assert.ok(Object.values(result.values).every(v => v === null));
  }
});

test("50 sessions are research-only; 51 qualifies without SMA200; metadata cannot inflate history", () => {
  const fixture = makeHistoricalFixture({ NVDA: 51, SPCX: 50 });
  fixture.inputs.evidence.histories.SPCX.quality.completed_sessions = 500;
  const inputs = withHistoricalIndicators(fixture.inputs);
  assert.equal(inputs.quotes[0].historical.eligible, true);
  assert.equal(inputs.quotes[0].historical.values.sma200, null);
  assert.equal(inputs.quotes[1].quality.actionable, false);
  assert.equal(inputs.quotes[1].quality.status, "research_only");
  assert.equal(inputs.quotes[1].historical.completed_sessions, 50);
});

test("partial sessions are excluded; broken history, wrong adjustment/feed/symbol and missing cutoff fail closed", () => {
  const fixture = makeHistoricalFixture({ NVDA: 51 });
  const original = fixture.inputs.evidence.histories.NVDA;
  const partial = { ...original.candles.at(-1), date: "2026-10-21", provider_at: "2026-10-21T04:00:00Z", close: 999, high: 1000 };
  const inputs = structuredClone(fixture.inputs);
  inputs.evidence.histories.NVDA.candles.push(partial);
  assert.equal(withHistoricalIndicators(inputs).quotes[0].historical.completed_sessions, 51);
  for (const changes of [{ adjustment: "raw" }, { feed: "iex" }, { symbol: "MSFT" }, { validated_asof: undefined },
    { candles: original.candles.slice(0, -1) }, { candles: original.candles.filter((_, i) => i !== 25) }]) {
    const input = structuredClone(fixture.inputs);
    Object.assign(input.evidence.histories.NVDA, changes);
    assert.equal(withHistoricalIndicators(input).quotes[0].quality.actionable, false);
  }
});

test("enrichment reuses quotes/calendar/history: no additional provider calls", async () => {
  const fixture = makeHistoricalFixture();
  const calls = { quotes: 0, news: 0, calendar: 0, history: 0 };
  const collected = await collectReportInputs(["NVDA", "SPCX"], { now: () => NOW, earningsWindow: earningsRequestWindow, fetchEarnings: async () => null,
    fetchQuotes: async () => { calls.quotes++; return fixture.inputs.quotes; },
    fetchAllNews: async () => { calls.news++; return fixture.inputs.news; },
    fetchCalendar: async () => { calls.calendar++; return fixture.inputs.evidence.calendar; },
    fetchHistory: async symbol => { calls.history++; return fixture.inputs.evidence.histories[symbol]; } });
  assert.deepEqual(calls, { quotes: 1, news: 1, calendar: 1, history: 3 });
  assert.equal(collected.quotes[0].historical, undefined);
  const inputs = qualifyReportInputs(collected, { now: NOW });
  assert.equal(inputs.quotes[0].historical.values.sma20.toFixed(2), "118.95");
});

test("candidate metadata cannot override insufficient historical evidence", () => {
  const fixture = makeHistoricalFixture({ NVDA: 50 });
  const inputs = withHistoricalIndicators(fixture.inputs);
  inputs.quotes[0].quality.actionable = true;
  assert.deepEqual(qualifyRecommendations(JSON.parse(fixture.reports.baseline).recommendations, inputs.quotes, { requireHistorical: true }), []);
});

test("prompt and compact cards preserve measured values and missing-indicator evidence", async () => {
  const fixture = makeHistoricalFixture({ NVDA: 51, SPCX: 50 });
  let artifact;
  await runReport(settings, { dryRun: true }, { now: () => NOW, collectInputs: async () => fixture.inputs,
    generateReport: async (inputs, feedback, request) => {
      assert.match(request.messages[0].content, /historical\.values/);
      assert.ok(request.messages[0].content.includes(JSON.stringify(inputs.quotes[0].historical.values.sma20)));
      return { content: fixture.reports.enriched };
    }, writeArtifact: value => { artifact = value; return "local"; } });
  assert.equal(artifact.output.recommendations.length, 1);
  assert.match(artifact.output.html, /Measured evidence/);
  assert.equal(artifact.snapshot.inputs.quotes[0].historical.values.sma200, null);
  assert.match(artifact.output.html, /Fewer than 51 sessions/);
  assert.ok(artifact.output.dataQuality.symbols[1].reasons.includes("insufficient_history_51"));
  assert.equal(artifact.snapshot.prompt_version, "daily-report-model-analysis-v1");
  assert.equal(artifact.snapshot.model_request.temperature, .3);
});

test("saved inputs cannot justify plans after quote/history becomes stale during AI generation", async () => {
  const fixture = makeHistoricalFixture({ NVDA: 51 });
  let clock = NOW, artifact;
  await runReport(settings, { dryRun: true }, { now: () => clock, collectInputs: async () => fixture.inputs,
    generateReport: async () => { clock += 901000; return { content: fixture.reports.enriched }; },
    writeArtifact: value => { artifact = value; return "local"; } });
  assert.deepEqual(artifact.output.recommendations, []);
  assert.match(artifact.output.html, /Quote is stale/);
  assert.ok(artifact.output.dataQuality.symbols[0].reasons.includes("stale_quote"));
});

