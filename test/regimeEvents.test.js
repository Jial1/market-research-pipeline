const { qualifyReportInputs, earningsRequestWindow } = require("../src/qualification");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEarnings, fetchEarnings } = require("../src/data/earnings");
const { tradingWindow, computeRegime, assessEarnings, withRegimeEvents, filterContextPlans } = require("../src/data/regimeEvents");
const { collectReportInputs } = require("../src/data/reportInputs");
const { runReport } = require("../src/reportRun");
const { makeRegimeFixture, NOW } = require("../fixtures/regime-events");
const settings = { model: "fixture", execution: {  },
  dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false } };
const event = (date = "2026-10-28", extra = {}) => ({ symbol: "MSFT", date, hour: "amc", ...extra });
const normalized = rows => normalizeEarnings("MSFT", { earningsCalendar: rows }, { from: "2026-10-21", to: "2026-10-30", now: NOW });

test("earnings empty/invalid/partial and provisional timing stay distinct", () => {
  assert.equal(normalized([]).status, "empty");
  assert.equal(normalized([event()]).events[0].certainty, "reported_unconfirmed");
  assert.equal(normalized([event()]).provider_updated_at, null);
  assert.equal(normalized([event(undefined, { confirmed: true })]).events[0].certainty, "reported_unconfirmed");
  for (const row of [event("2026-02-30"), event(undefined, { symbol: "NVDA" }), event(undefined, { epsActual: 4 })]) {
    assert.equal(normalized([row]).status, "invalid");
    assert.equal(normalized([event(), row]).status, "partial");
  }
  assert.equal(normalized([event(undefined, { hour: "unrecognized" })]).events[0].timing, "unknown");
  assert.equal(normalizeEarnings("MSFT", {}, { from: "2026-10-22", to: "2026-10-28", now: NOW }).status, "invalid");
});

test("earnings fetch uses bounded request, and failures cannot expose keys", async () => {
  const env = { FINNHUB_API_KEY: "private-fixture-value" };
  const result = await fetchEarnings("MSFT", { from: "2026-10-22", to: "2026-10-28", now: NOW, env,
    get: async (url, options) => { assert.equal(options.timeout, 10000); assert.equal(options.params.symbol, "MSFT"); return { data: { earningsCalendar: [event()] } }; } });
  assert.equal(result.status, "observed");
  const failure = await fetchEarnings("MSFT", { from: "2026-10-22", to: "2026-10-28", now: NOW, env, get: async () => { throw new Error(env.FINNHUB_API_KEY); } });
  assert.equal(failure.status, "failed");
  assert.ok(!JSON.stringify(failure).includes(env.FINNHUB_API_KEY));
  const missing = await fetchEarnings("MSFT", { from: "2026-10-22", to: "2026-10-28", now: NOW, env: {}, get: () => assert.fail("request") });
  assert.equal(missing.reasons[0], "missing_earnings_credentials");
});

test("SPY trend uses completed close/SMA50/SMA200, including mixed/equality/unknown cases", () => {
  const fixture = makeRegimeFixture(), calendar = fixture.inputs.evidence.calendar;
  const original = fixture.inputs.evidence.histories.SPY;
  assert.equal(computeRegime(original, calendar, NOW).state, "uptrend");
  const changed = close => ({ ...original, candles: original.candles.map((c, i) => ({ ...c, open: close(i), high: close(i)+1, low: close(i)-1, close: close(i) })) });
  assert.equal(computeRegime(changed(i => 300-i), calendar, NOW).state, "downtrend");
  assert.equal(computeRegime(changed(() => 100), calendar, NOW).state, "mixed");
  assert.equal(computeRegime({ ...original, candles: original.candles.slice(-199) }, calendar, NOW).state, "unknown");
  assert.equal(computeRegime({ ...original, adjustment: "raw" }, calendar, NOW).state, "unknown");
  const partial = structuredClone(original);
  partial.candles.push({ ...partial.candles.at(-1), date: "2026-10-21", provider_at: "2026-10-21T04:00:00Z", open: 1, high: 1, low: 1, close: 1 });
  assert.equal(computeRegime(partial, calendar, NOW).state, "uptrend");
});

test("full window is five eligible sessions, including weekends between entry/exit dates", () => {
  const window = tradingWindow(makeRegimeFixture().inputs.evidence.calendar, NOW);
  assert.deepEqual(window.sessions, ["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"]);
  assert.equal(window.evaluation_version, "next-session-v1");
  for (const [date, conflict] of [["2026-10-21", false], ["2026-10-22", true], ["2026-10-24", true], ["2026-10-28", true], ["2026-10-29", false]]) {
    assert.equal(assessEarnings(normalized([event(date)]), window, NOW).state === "reported_conflict", conflict);
  }
});

test("all reported timing/certainty variants block conservatively without upgrading confidence", () => {
  const window = tradingWindow(makeRegimeFixture().inputs.evidence.calendar, NOW);
  for (const timing of ["bmo", "amc", "dmh", "unknown"]) for (const certainty of ["confirmed", "estimated", "reported_unconfirmed"]) {
    const snapshot = normalized([event(undefined, { hour: timing })]);
    snapshot.events[0].certainty = certainty;
    const risk = assessEarnings(snapshot, window, NOW);
    assert.equal(risk.state, "reported_conflict"); assert.equal(risk.conflicts[0].certainty, certainty);
  }
});

test("unknown/failed/empty coverage never claims event-free or silently blocks all plans", () => {
  const context = withRegimeEvents(makeRegimeFixture().inputs).marketContext;
  assert.equal(context.earnings.NVDA.state, "unknown");
  assert.equal(context.earnings.NVDA.source_status, "empty");
  const plan = { symbol: "NVDA", trade_direction: "long" };
  assert.equal(filterContextPlans([plan], context).recommendations.length, 1);
  assert.equal(assessEarnings({ ...normalized([]), status: "failed" }, context.window, NOW).state, "unknown");
  assert.equal(filterContextPlans([plan], { ...context, window: null }).exclusions[0].reason, "earnings_window_unknown");
});

test("identity, source and future evidence cannot create historical exclusions", () => {
  const context = withRegimeEvents(makeRegimeFixture().inputs).marketContext;
  const snapshot = normalized([event()]);
  assert.equal(assessEarnings(snapshot, context.window, NOW, "NVDA").state, "unknown");
  assert.equal(assessEarnings({ ...snapshot, fetched_at: new Date(NOW+1).toISOString() }, context.window, NOW).state, "unknown");
  snapshot.events[0].provider_updated_at = new Date(NOW+1).toISOString();
  assert.equal(assessEarnings(snapshot, context.window, NOW).state, "unknown");
  const old = normalized([event()]); old.fetched_at = new Date(NOW-86400001).toISOString(); old.events[0].observed_at = old.fetched_at;
  const risk = assessEarnings(old, context.window, NOW);
  assert.equal(risk.state, "reported_conflict"); assert.ok(risk.reasons.includes("earnings_snapshot_stale"));
});

test("regime is annotation and does not veto counter-trend directions", () => {
  const context = withRegimeEvents(makeRegimeFixture().inputs).marketContext;
  const short = { symbol: "NVDA", trade_direction: "short", market_regime: "invented" };
  assert.equal(filterContextPlans([short], context).recommendations[0].market_regime, "uptrend");
});

test("SPY history is fetched once and benchmark data never adds an unrequested quote/news/event", async () => {
  const fixture = makeRegimeFixture();
  let quoteSymbols, newsSymbols; const histories = [], earnings = [];
  const deps = { now: () => NOW, earningsWindow: earningsRequestWindow,
    fetchQuotes: async symbols => { quoteSymbols = symbols; return fixture.inputs.quotes; },
    fetchAllNews: async symbols => { newsSymbols = symbols; return fixture.inputs.news; },
    fetchCalendar: async () => fixture.inputs.evidence.calendar,
    fetchHistory: async symbol => { histories.push(symbol); return fixture.inputs.evidence.histories[symbol]; },
    fetchEarnings: async symbol => { earnings.push(symbol); return fixture.inputs.evidence.earnings[symbol]; } };
  const collected = await collectReportInputs(["NVDA", "MSFT"], deps);
  assert.equal(collected.marketContext, undefined);
  const inputs = qualifyReportInputs(collected, { now: NOW });
  assert.deepEqual(histories, ["NVDA", "MSFT", "SPY"]); assert.deepEqual(earnings, ["NVDA", "MSFT"]);
  assert.deepEqual(quoteSymbols, ["NVDA", "MSFT"]); assert.deepEqual(newsSymbols, quoteSymbols);
  assert.equal(inputs.marketContext.regime.state, "uptrend");
  histories.length = 0;
  await collectReportInputs(["NVDA", "SPY"], { ...deps, fetchEarnings: async () => normalized([]) });
  assert.deepEqual(histories, ["NVDA", "SPY"]);
});

test("report prompt, final cards and counterfactuals retain computed context and exclusions", async () => {
  const fixture = makeRegimeFixture(); let artifact;
  await runReport(settings, { dryRun: true }, { now: () => NOW, collectInputs: async () => fixture.inputs,
    generateReport: async (inputs, feedback, request) => {
      assert.match(request.messages[0].content, /reported_conflict/);
      assert.match(request.messages[0].content, /reported_unconfirmed/);
      // A hypothetical provider revision after the snapshot must not rewrite old evidence.
      fixture.inputs.evidence.earnings.MSFT.events[0].date = "2026-10-29";
      return { content: fixture.reports.enriched };
    }, writeArtifact: value => { artifact = value; return "local"; } });
  assert.deepEqual(artifact.output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.equal(artifact.output.recommendations[0].market_regime, "uptrend");
  assert.equal(artifact.output.exclusions[0].reason, "reported_earnings_conflict");
  assert.equal(artifact.snapshot.inputs.evidence.earnings.MSFT.events[0].date, "2026-10-28");
  assert.match(artifact.output.html, /SPY market context/); assert.match(artifact.output.html, /after close \(date unconfirmed\)/);
  assert.match(artifact.output.html, /context only, no automatic direction restriction/);
  assert.equal(artifact.snapshot.prompt_version, "daily-report-model-analysis-v1");
});

test("missing full future calendar blocks candidates and reports the reason", async () => {
  const fixture = makeRegimeFixture(); let output;
  fixture.inputs.evidence.calendar.sessions = fixture.inputs.evidence.calendar.sessions.filter(s => s.date <= "2026-10-23");
  await runReport(settings, { dryRun: true }, { now: () => NOW, collectInputs: async () => fixture.inputs,
    generateReport: async () => ({ content: fixture.reports.enriched }), writeArtifact: value => { output = value.output; return "local"; } });
  assert.deepEqual(output.recommendations, []);
  assert.ok(output.exclusions.every(e => e.reason === "earnings_window_unknown"));
});

test("closed-session report preserves research-only quality after collection, enrichment and final validation", async () => {
  const fixture = makeRegimeFixture();
  const closedNow = Date.parse("2026-10-18T16:00:00Z");
  for (const history of Object.values(fixture.inputs.evidence.histories)) {
    history.candles = history.candles.filter(c => c.date <= "2026-10-16");
    history.validated_asof = new Date(closedNow - 16 * 60000).toISOString();
    history.quality.completed_sessions = history.candles.length;
  }
  for (const quote of fixture.inputs.quotes) {
    const last = fixture.inputs.evidence.histories[quote.symbol].candles.at(-1);
    Object.assign(quote, { price: last.close, open: last.open, high: last.high, low: last.low,
      provider_at: "2026-10-16T20:00:00Z", fetched_at: new Date(closedNow).toISOString(),
      quality: { status: "observed", actionable: false, reasons: [] } });
  }
  const inputs = await collectReportInputs(["NVDA", "MSFT"], { now: () => closedNow,
    earningsWindow: earningsRequestWindow,
    fetchCalendar: async () => fixture.inputs.evidence.calendar,
    fetchQuotes: async () => fixture.inputs.quotes,
    fetchAllNews: async () => fixture.inputs.news,
    fetchHistory: async symbol => fixture.inputs.evidence.histories[symbol],
    fetchEarnings: async (symbol, options) => normalizeEarnings(symbol, { earningsCalendar: [] }, options) });
  let artifact;
  await runReport(settings, { dryRun: true }, { now: () => closedNow, collectInputs: async () => inputs,
    generateReport: async () => ({ content: fixture.reports.enriched }),
    writeArtifact: value => { artifact = value; return "fixture"; },
    connectDatabase: () => assert.fail("database"), sendEmail: () => assert.fail("email") });
  for (const row of artifact.output.dataQuality.symbols) {
    assert.equal(row.status, "research_only"); assert.equal(row.actionable, false);
    assert.deepEqual(row.reasons, ["market_closed"]); assert.equal(row.historical.eligible, true);
  }
  assert.equal(artifact.output.dataQuality.session_state, "closed");
  assert.deepEqual(artifact.output.recommendations, [], "AI proposals cannot bypass the closed-market restriction");
  assert.match(artifact.output.html, /Market closed/);
  const main = artifact.output.html.split("Technical appendix")[0];
  assert.match(main, /Stock analysis/); assert.match(main, /Measured evidence/);
  assert.doesNotMatch(main, /Entry:|Target:|Stop:|R\/R/);
});
