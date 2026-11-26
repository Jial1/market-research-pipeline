const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collectReportInputs } = require("../src/data/reportInputs");
const { qualifyReportInputs, earningsRequestWindow } = require("../src/qualification");
const { runReport } = require("../src/reportRun");
const { makePreparationFixture } = require("../fixtures/preparation-report");

const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false } };
async function issue(fixture, finalTime) {
  let clock = fixture.now, artifact;
  await runReport(settings, { dryRun: true }, { now: () => clock,
    collectInputs: async () => structuredClone(fixture.inputs),
    generateReport: async inputs => {
      assert.equal(inputs.quotes[0].historical.eligible, true);
      clock = finalTime; return { content: fixture.report };
    }, writeArtifact: value => { artifact = value; return "fixture"; } });
  return artifact;
}

test("collection returns normalized evidence once, without application qualification or policy imports", async () => {
  const fixture = makePreparationFixture(); const calls = [];
  const raw = await collectReportInputs(["NVDA", "MSFT"], {
    now: () => fixture.now, earningsWindow: earningsRequestWindow,
    fetchCalendar: async () => { calls.push("calendar"); return fixture.inputs.evidence.calendar; },
    fetchQuotes: async () => { calls.push("quotes"); return fixture.inputs.quotes; },
    fetchAllNews: async () => { calls.push("news"); return fixture.inputs.news; },
    fetchHistory: async symbol => { calls.push(`history:${symbol}`); return fixture.inputs.evidence.histories[symbol]; },
    fetchEarnings: async (symbol, window) => {
      calls.push(`earnings:${symbol}`); assert.equal(window.from, "2026-10-21"); assert.equal(window.to, "2026-10-28");
      return fixture.inputs.evidence.earnings[symbol];
    }
  });
  assert.deepEqual(calls, ["calendar", "quotes", "news", "history:NVDA", "history:MSFT", "history:SPY", "earnings:NVDA", "earnings:MSFT"]);
  assert.equal(raw.quotes[0].historical, undefined);
  assert.equal(raw.marketContext, undefined);
  assert.equal(raw.preparationContext, undefined);
  assert.equal(raw.dataQuality.session_state, undefined);
  const qualified = qualifyReportInputs(raw, { now: fixture.now });
  assert.equal(qualified.quotes[0].historical.eligible, true);
  assert.equal(qualified.preparationContext.symbols.NVDA.eligible, true);
  assert.equal(raw.quotes[0].historical, undefined, "qualification does not mutate collected evidence");
  await assert.rejects(collectReportInputs([], {}), /explicit earnings-window policy/);
});

test("domain earnings bounds cover independent preparation/tracked windows, including missing tracked coverage", () => {
  const fixture = makePreparationFixture();
  assert.deepEqual(earningsRequestWindow(fixture.inputs.evidence.calendar, fixture.now), { from: "2026-10-21", to: "2026-10-28" });
  const limited = structuredClone(fixture.inputs.evidence.calendar);
  limited.sessions = limited.sessions.filter(s => s.date <= "2026-10-27");
  assert.deepEqual(earningsRequestWindow(limited, fixture.now), { from: "2026-10-21", to: "2026-10-27" });
  assert.equal(earningsRequestWindow({ status: "failed" }, fixture.now), null);
});

test("provider delays and old collection timestamps cannot bypass initial freshness qualification", async () => {
  const fixture = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
  let clock = fixture.now, modelCalls = 0;
  await assert.rejects(runReport(settings, { dryRun: true }, {
    now: () => clock,
    collectInputs: async () => {
      const inputs = await collectReportInputs(["NVDA", "MSFT"], {
        now: () => clock, earningsWindow: earningsRequestWindow,
        fetchCalendar: async () => fixture.inputs.evidence.calendar,
        fetchQuotes: async () => fixture.inputs.quotes, fetchAllNews: async () => fixture.inputs.news,
        fetchHistory: async symbol => { clock = fixture.now + 901000; return fixture.inputs.evidence.histories[symbol]; },
        fetchEarnings: async symbol => fixture.inputs.evidence.earnings[symbol]
      });
      inputs.dataQuality.checked_at = new Date(fixture.now).toISOString();
      return inputs;
    }, generateReport: async () => { modelCalls++; return { content: fixture.report }; }
  }), /No usable historical evidence/);
  assert.equal(modelCalls, 0);
});

test("issuance crossing a market close recalculates session and preparation windows", async () => {
  const fixture = makePreparationFixture(Date.parse("2026-10-21T19:59:00Z"));
  const { snapshot, output } = await issue(fixture, Date.parse("2026-10-21T20:00:01Z"));
  assert.equal(snapshot.inputs.dataQuality.session_state, "open");
  assert.equal(snapshot.inputs.preparationContext.enabled, false);
  assert.equal(output.dataQuality.session_state, "closed");
  assert.equal(output.preparation.context.enabled, true);
  assert.equal(output.preparation.context.window.from, "2026-10-22");
  assert.deepEqual(output.recommendations, []);
});

test("crossing the delayed completed-bar cutoff invalidates old history and benchmark calculations", async () => {
  const fixture = makePreparationFixture(Date.parse("2026-10-21T19:59:00Z"));
  const { snapshot, output } = await issue(fixture, Date.parse("2026-10-21T20:17:00Z"));
  assert.equal(snapshot.inputs.marketContext.regime.state, "uptrend");
  assert.equal(output.marketContext.regime.state, "unknown");
  assert.ok(output.dataQuality.symbols[0].reasons.includes("history_stale_at_report"));
  assert.deepEqual(output.recommendations, []);
  assert.deepEqual(output.preparation.strategies, []);
});

test("issuance rechecks earnings age and calendar coverage rather than retaining earlier eligibility", async () => {
  const fixture = makePreparationFixture();
  fixture.inputs.evidence.earnings.NVDA.fetched_at = new Date(fixture.now - 86400000).toISOString();
  const { snapshot, output } = await issue(fixture, fixture.now + 1);
  assert.equal(snapshot.inputs.preparationContext.symbols.NVDA.eligible, true);
  assert.equal(output.preparation.context.symbols.NVDA.reason, "preparation_earnings_unavailable");
  assert.deepEqual(output.preparation.strategies, []);
  const beyond = await issue(makePreparationFixture(), fixture.now + 90 * 86400000);
  assert.equal(beyond.output.dataQuality.session_state, "unknown");
  assert.equal(beyond.output.eligible_session, null);
  assert.deepEqual(beyond.output.recommendations, []);
  assert.deepEqual(beyond.output.preparation.strategies, []);
});

test("unchanged timestamps cannot make cached indicators authoritative after source evidence changes", async () => {
  const fixture = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
  let output;
  await runReport(settings, { dryRun: true }, { now: () => fixture.now,
    collectInputs: async () => fixture.inputs,
    generateReport: async inputs => {
      assert.equal(inputs.quotes[0].historical.eligible, true);
      inputs.quotes[0].historical.values.sma20 = 99999;
      inputs.evidence.histories.NVDA.adjustment = "raw";
      inputs.evidence.histories.SPY.feed = "iex";
      return { content: fixture.report };
    }, writeArtifact: value => { output = value.output; return "fixture"; } });
  assert.equal(output.marketContext.regime.state, "unknown");
  assert.ok(output.dataQuality.symbols[0].reasons.includes("unqualified_history"));
  assert.deepEqual(output.recommendations, []);
  assert.doesNotMatch(output.html, /99999/);
});
