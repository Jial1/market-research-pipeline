const { qualifyReportInputs, earningsRequestWindow } = require("../src/qualification");
const { amendReport } = require("../fixtures/model-analysis");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { preparationWindow, withPreparation, buildPreparation } = require("../src/preparation");
const { withHistoricalIndicators } = require("../src/data/historicalInputs");
const { tradingWindow } = require("../src/data/regimeEvents");
const { collectReportInputs } = require("../src/data/reportInputs");
const { qualifyRecommendations } = require("../src/recommendations");
const { runReport } = require("../src/reportRun");
const { makePreparationFixture } = require("../fixtures/preparation-report");
const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false } };
async function render(fixture, finalNow = fixture.now, finishReason = null) {
  let artifact, clock = fixture.now;
  await runReport(settings, { dryRun: true }, { now: () => clock, collectInputs: async () => fixture.inputs,
    generateReport: async (inputs, feedback, request) => {
      assert.equal(request.response_format.json_schema.name, "model_analysis_v1");
      clock = finalNow; return { content: fixture.report, finish_reason: finishReason };
    }, writeArtifact: value => { artifact = value; return "fixture"; } });
  return artifact;
}

test("preparation targets upcoming opening: premarket, after-close, weekends, holidays and missing calendar", () => {
  for (const [time, date] of [["2026-10-21T05:14:00Z", "2026-10-21"], ["2026-10-21T16:00:00Z", "2026-10-22"],
    ["2026-10-21T22:00:00Z", "2026-10-22"], ["2026-10-24T16:00:00Z", "2026-10-26"]]) {
    const now = Date.parse(time), { inputs } = makePreparationFixture(now);
    assert.equal(preparationWindow(inputs.evidence.calendar, now).from, date);
  }
  const { inputs, now } = makePreparationFixture();
  assert.equal(tradingWindow(inputs.evidence.calendar, now).from, "2026-10-22", "tracked policy remains strict-next-date");
  inputs.evidence.calendar.sessions = inputs.evidence.calendar.sessions.filter(s => s.date !== "2026-10-21");
  assert.equal(preparationWindow(inputs.evidence.calendar, now).from, "2026-10-22", "calendar holiday is skipped");
  assert.equal(preparationWindow({ status: "failed" }, now), null);
  assert.equal(preparationWindow({ ...inputs.evidence.calendar, sessions: [] }, now), null);
  const calendar = makePreparationFixture().inputs.evidence.calendar;
  const { sessionTime } = require("../src/data/marketCalendar");
  calendar.end = "2026-11-10";
  for (const date of ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]) calendar.sessions.push({ date,
    open_at: new Date(sessionTime(date, "09:30")).toISOString(), close_at: new Date(sessionTime(date, "16:00")).toISOString() });
  const overnight = Date.parse("2026-11-03T06:14:00Z"); // Nov 2 in LA, Nov 3 in New York, after DST changes.
  assert.equal(preparationWindow(calendar, overnight).from, "2026-11-03");
  assert.equal(tradingWindow(calendar, overnight).from, "2026-11-04");
});

test("overnight report displays one conditional strategy, separates dates and blocks reported earnings conflicts", async () => {
  const { output } = await render(makePreparationFixture());
  assert.deepEqual(output.recommendations, []);
  assert.deepEqual(output.preparation.strategies.map(p => p.symbol), ["NVDA"]);
  assert.equal(output.preparation.context.window.from, "2026-10-21");
  assert.equal(output.eligible_session, "2026-10-22");
  assert.equal(output.evaluationPolicy.version, "next-session-v1");
  assert.match(output.html, /Conditional strategy · Preparation reference \(not an approved plan\)/);
  assert.match(output.html, /Conditional preparation · revalidation required/);
  assert.match(output.html, /Conditional entry: 120 \| Target: 130 \| Stop: 116/);
  assert.match(output.html, /not automatically promoted to an approved plan and is excluded from trade evaluation/);
  assert.match(output.html, /Earnings risk/);
  assert.doesNotMatch(output.html, /PREPARATION_JSON|END_PREPARATION_JSON/);
  assert.equal(output.preparation.exclusions[0].reason, "reported_earnings_conflict");
});

test("open-market report keeps approved plans and never promotes preparation JSON, even on crossing the open", async () => {
  const { output } = await render(makePreparationFixture(Date.parse("2026-10-21T16:00:00Z")));
  assert.deepEqual(output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.deepEqual(output.preparation.strategies, []);
  assert.doesNotMatch(output.html, /Conditional strategy · Preparation reference/);
  const overnight = makePreparationFixture();
  const crossed = await render(overnight, Date.parse("2026-10-21T14:00:00Z"));
  assert.deepEqual(crossed.output.preparation.strategies, []);
  assert.deepEqual(crossed.output.recommendations, []);
  assert.equal(crossed.output.dataQuality.session_state, "open");
  const quotes = output.recommendations.map(p => ({ symbol: p.symbol, quality: { enforced: true, actionable: true } }));
  const onlyPreparation = JSON.parse(overnight.report).preparation;
  assert.deepEqual(qualifyRecommendations([], quotes), []);
});

test("earnings veto follows the preparation window independently of tracked eligibility", async () => {
  const early = makePreparationFixture();
  early.inputs.evidence.earnings.MSFT.events[0].date = "2026-10-21";
  const first = (await render(early)).output;
  assert.equal(first.marketContext.earnings.MSFT.state, "unknown");
  assert.equal(first.preparation.context.symbols.MSFT.earnings.state, "reported_conflict");
  assert.deepEqual(first.preparation.strategies.map(p => p.symbol), ["NVDA"]);
  assert.match(first.html, /2026-10-21 after close/);
  const later = makePreparationFixture();
  later.inputs.evidence.earnings.MSFT.events[0].date = "2026-10-28";
  const second = (await render(later)).output;
  assert.equal(second.marketContext.earnings.MSFT.state, "reported_conflict");
  assert.equal(second.preparation.context.symbols.MSFT.earnings.state, "unknown");
  assert.deepEqual(second.preparation.strategies.map(p => p.symbol), ["NVDA", "MSFT"]);
});

test("invalid/stale inputs, insufficient history and missing earnings coverage suppress numerical preparation", async () => {
  for (const mutate of [
    f => { f.inputs.quotes[0].quality = { status: "invalid", actionable: false, reasons: ["invalid_quote_values"] }; },
    f => { f.inputs.quotes[0].provider_at = "2026-10-19T20:00:00Z"; },
    f => { f.inputs.evidence.histories.NVDA.candles = f.inputs.evidence.histories.NVDA.candles.slice(-50); },
    f => { f.inputs.evidence.earnings.NVDA.status = "failed"; },
    f => { f.inputs.evidence.earnings.NVDA.from = "2026-10-22"; },
    f => { f.inputs.evidence.earnings.NVDA.fetched_at = "2026-10-19T12:00:00Z"; }
  ]) {
    const fixture = makePreparationFixture(); mutate(fixture);
    const { output } = await render(fixture);
    assert.deepEqual(output.preparation.strategies, []);
    assert.doesNotMatch(output.html, /Conditional entry:120/);
  }
});

test("malformed JSON, geometry, unsupported symbols, stale basis cannot bypass preparation checks", () => {
  const f = makePreparationFixture();
  const inputs = withPreparation(withHistoricalIndicators(f.inputs), f.now);
  const build = rows => buildPreparation(rows, inputs);
  const valid = f.candidates[0];
  for (const row of [{ ...valid, target_price: 119 }, { ...valid, stop_loss: 120 }, { ...valid, entry_price: "120" },
    { ...valid, trade_direction: "other" }, { ...valid, evidence_asof: "2026-10-19" }, { ...valid, trigger: "" }, { ...valid, symbol: "OTHER" }]) {
    assert.deepEqual(build([row]).strategies, []);
  }
  assert.equal(build([{ ...valid, trade_direction: "short", target_price: 110, stop_loss: 124 }]).strategies.length, 1);
  assert.equal(buildPreparation(null, inputs).strategies.length, 0);
});

test("one earnings call per stock covers both preparation and tracked windows", async () => {
  const f = makePreparationFixture(); const requests = [];
  const collected = await collectReportInputs(["NVDA", "MSFT"], { now: () => f.now, earningsWindow: earningsRequestWindow,
    fetchQuotes: async () => f.inputs.quotes, fetchAllNews: async () => f.inputs.news,
    fetchCalendar: async () => f.inputs.evidence.calendar, fetchHistory: async symbol => f.inputs.evidence.histories[symbol],
    fetchEarnings: async (symbol, request) => { requests.push(request); return f.inputs.evidence.earnings[symbol]; } });
  const inputs = qualifyReportInputs(collected, { now: f.now });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.from === "2026-10-21" && r.to === "2026-10-28"));
  assert.equal(inputs.marketContext.window.from, "2026-10-22");
});

const setDecisions = (fixture, rows) => { fixture.report = amendReport(fixture.report, a => { a.preparation = rows; }); };

test("missing, incomplete and malformed model documents are output problems, never trading conclusions", async () => {
  for (const [response, state] of [["", "invalid_model_json"], ['{"schema_version":', "invalid_model_json"],
    ["not JSON", "invalid_model_json"], ["{}", "invalid_model_schema"], ["[]", "invalid_model_schema"]]) {
    const fixture = makePreparationFixture(); fixture.report = response;
    const { output } = await render(fixture);
    assert.equal(output.model_validation.state, state);
    assert.equal(output.preparation.outcomes.NVDA.state, "output_error");
    assert.equal(output.preparation.outcomes.MSFT.state, "blocked");
    assert.deepEqual(output.preparation.strategies, []);
    assert.match(output.html, /Preparation output issue/);
  }
});

test("explicit watch-only reasons display as model decisions, while an empty array has no per-stock decision", async () => {
  const fixture = makePreparationFixture();
  setDecisions(fixture, [{ symbol: "NVDA", decision: "watch_only", reason: "No clear breakout confirmation, Watch for now" }]);
  const { output } = await render(fixture);
  assert.equal(output.preparation.output_status, "complete");
  assert.deepEqual(output.preparation.strategies, []);
  assert.deepEqual(output.recommendations, []);
  assert.equal(output.preparation.outcomes.NVDA.state, "watch_only");
  assert.match(output.html, /Model selected watch only: No clear breakout confirmation, Watch for now/);
  assert.match(output.html, /Watch only\(model decision\)/);
  assert.doesNotMatch(output.html, /Conditional entry:|Entry:|Target:|Stop:/);
  setDecisions(fixture, [{ symbol: "NVDA", decision: "watch_only", reason: "<img src=x onerror=alert(1)>Await confirmation" }]);
  const escaped = (await render(fixture)).output;
  assert.match(escaped.html, /&lt;img/); assert.doesNotMatch(escaped.html, /<img/);
  setDecisions(fixture, []);
  const empty = (await render(fixture)).output;
  assert.equal(empty.preparation.response_state, "explicit_empty_array");
  assert.equal(empty.preparation.outcomes.NVDA.reason, "empty_preparation_decisions");
  assert.match(empty.html, /The model returned an empty result, no preparation decision was provided for this symbol/);
});

test("each eligible stock needs one valid decision; partial output, duplicates and invalid watch-only fields remain visible", async () => {
  const fixture = makePreparationFixture();
  fixture.inputs.evidence.earnings.MSFT.events = []; fixture.inputs.evidence.earnings.MSFT.status = "empty";
  setDecisions(fixture, [{ symbol: "NVDA", decision: "watch_only", reason: "Await structure confirmation" }]);
  const partial = (await render(fixture)).output;
  assert.equal(partial.preparation.outcomes.NVDA.state, "watch_only");
  assert.equal(partial.preparation.outcomes.MSFT.reason, "missing_preparation_decision");
  assert.equal(partial.preparation.output_status, "incomplete_decisions");
  const inputs = withPreparation(withHistoricalIndicators(fixture.inputs), fixture.now);
  const watch = { symbol: "NVDA", decision: "watch_only", reason: "Await structure confirmation" };
  for (const bad of [{ ...watch, reason: "" }, { ...watch, entry_price: 120 }, { ...watch, reason: "Entry99999, Target88888" }]) {
    const result = buildPreparation([bad], inputs);
    assert.equal(result.outcomes.NVDA.reason, "invalid_watch_only_decision");
    assert.deepEqual(result.strategies, []);
  }
  const duplicate = buildPreparation([fixture.candidates[0], watch], inputs);
  assert.equal(duplicate.outcomes.NVDA.reason, "duplicate_preparation_decision");
  assert.deepEqual(duplicate.strategies, []);
  const legacy = { ...fixture.candidates[0] }; delete legacy.decision;
  const rows = [legacy];
  assert.equal(buildPreparation(rows, inputs).outcomes.NVDA.reason, "invalid_preparation_decision");
  assert.equal(buildPreparation(rows, inputs).strategies.length, 0);
});

test("the prompt requires one schema response and explicit preparation decisions without a paid retry", async () => {
  const fixture = makePreparationFixture(); let calls = 0;
  fixture.report = amendReport(fixture.report, a => { delete a.preparation; });
  let artifact;
  await runReport(settings, { dryRun: true }, { now: () => fixture.now, collectInputs: async () => fixture.inputs,
    generateReport: async (inputs, feedback, request) => {
      calls++;
      const prompt = request.messages[0].content;
      assert.match(prompt, /every eligible=true symbol must return exactly one decision/i);
      assert.match(prompt, /actionable=false does not prohibit qualified conditional preparation/);
      assert.match(prompt, /decision="watch_only"/);
      assert.match(prompt, /exactly one JSON object/);
      assert.equal(request.response_format.json_schema.strict, true);
      assert.doesNotMatch(prompt, /Select at most 5itemsA\+ opportunities|450\.00|Use today watchlist replace with real watchlist plans/);
      return { content: fixture.report };
    }, writeArtifact: value => { artifact = value; return "fixture"; }, sendEmail: () => assert.fail("email") });
  assert.equal(calls, 1, "an omitted block must not trigger an automatic paid retry");
  assert.equal(artifact.output.preparation.outcomes.NVDA.reason, "invalid_model_schema");
});

test("known non-normal model termination suppresses numeric strategies and approved plans without changing trade policy", async () => {
  for (const reason of ["length", "content_filter", "tool_calls"]) {
    const closed = (await render(makePreparationFixture(), undefined, reason)).output;
    assert.equal(closed.model_completion.finish_reason, reason);
    assert.equal(closed.preparation.outcomes.NVDA.reason, "model_generation_incomplete");
    assert.deepEqual(closed.preparation.strategies, []);
    assert.doesNotMatch(closed.html, /Conditional entry:120/);
    const open = (await render(makePreparationFixture(Date.parse("2026-10-21T16:00:00Z")), undefined, reason)).output;
    assert.deepEqual(open.recommendations, []);
    assert.ok(open.exclusions.some(e => e.reason === "model_generation_incomplete"));
    assert.equal(open.evaluationPolicy.version, "next-session-v1");
    assert.match(open.html, /Model generation did not finish normally/);
  }
});

