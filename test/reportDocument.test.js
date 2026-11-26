const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildReportDocument, REPORT_DOCUMENT_VERSION } = require("../src/reportDocument");
const { formatDashboard } = require("../src/formatter");
const { runReport } = require("../src/reportRun");
const { renderScenario, scenarios } = require("./fixtures/report-scenarios");
const { makePreparationFixture } = require("../fixtures/preparation-report");

test("saved documents independently render all five reviewed scenarios after a JSON round trip", async () => {
  for (const name of scenarios) {
    const { output } = await renderScenario(name);
    const document = JSON.parse(JSON.stringify(output.reportDocument));
    assert.equal(document.schema_version, REPORT_DOCUMENT_VERSION);
    assert.equal(formatDashboard(document), output.html, name);
    assert.deepEqual(document.tracked_plans, output.recommendations);
    assert.deepEqual(document.evaluation_policy, output.evaluationPolicy);
    assert.equal(document.issued_at, output.issued_at);
    assert.equal(document.footer.eligible_session, output.eligible_session);
    assert.equal(document.header.date, "2026-10-21");
    assert.equal(document.footer.history_dates[0], "2026-10-20");
    assert.equal(document.market.context.regime.version, output.marketContext.regime.version);
    for (const stock of document.stocks) {
      assert.equal(stock.measured_evidence.asof_session, "2026-10-20");
      assert.deepEqual(stock.options_supplement, output.optionsSupplements.find(s => s.symbol === stock.symbol) || null);
      assert.equal(stock.plan !== null, stock.decision.status === "approved");
    }
    assert.equal("report" in document, false, "rendering does not require the raw model response");
  }
});

test("preparation and event decisions remain distinct from approved tracked plans", async () => {
  const { output } = await renderScenario("overnight");
  const document = output.reportDocument;
  const nvda = document.stocks.find(s => s.symbol === "NVDA");
  const msft = document.stocks.find(s => s.symbol === "MSFT");
  assert.equal(nvda.decision.status, "preparation");
  assert.equal(nvda.plan, null);
  assert.equal(nvda.preparation.strategy.entry_price, 120);
  assert.equal(nvda.preparation.strategy.session, "2026-10-21");
  assert.equal(msft.decision.status, "event_risk");
  assert.ok(msft.decision.reasons.includes("reported_earnings_conflict"));
  assert.equal(msft.preparation.strategy, null);
  assert.equal(msft.earnings.state, "reported_conflict");
  assert.deepEqual(document.tracked_plans, []);
  assert.equal(document.footer.eligible_session, "2026-10-22");
});

test("rejected model proposals cannot become document plans or options", async () => {
  const { output } = await renderScenario("unavailable-data");
  const stock = output.reportDocument.stocks.find(s => s.symbol === "NVDA");
  assert.ok(JSON.parse(output.report).recommendations.length, "a raw candidate is still present");
  assert.equal(stock.decision.status, "research_only");
  assert.equal(stock.plan, null);
  assert.equal(stock.options_supplement, null);
  assert.ok(stock.decision.reasons.includes("insufficient_history_51"));
  assert.equal(stock.measured_evidence.eligible, false);
  assert.ok(stock.analysis.fields.Structure, "research commentary survives rejection");
});

test("documents capture issuance-time staleness and incomplete-generation suppression", async () => {
  for (const mode of ["stale", "incomplete"]) {
    const fixture = makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));
    let clock = fixture.now, artifact;
    await runReport({ model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false } }, { dryRun: true }, {
      now: () => clock, collectInputs: async () => fixture.inputs,
      generateReport: async () => {
        if (mode === "stale") clock += 901000;
        return { content: fixture.report, finish_reason: mode === "incomplete" ? "length" : null };
      }, writeArtifact: value => { artifact = value; return "fixture"; }
    });
    const document = artifact.output.reportDocument;
    assert.deepEqual(document.tracked_plans, []);
    assert.ok(document.stocks.every(s => s.plan === null && s.decision.status !== "approved"));
    assert.equal(document.issued_at, new Date(clock).toISOString());
    if (mode === "stale") assert.ok(document.stocks[0].decision.reasons.includes("stale_quote"));
    else assert.ok(document.exclusions.some(e => e.reason === "model_generation_incomplete"));
  }
});

test("display ranking never changes the stored plan order and the document detaches its inputs", async () => {
  const { output } = await renderScenario("market-open");
  const original = output.reportDocument.stocks.find(s => s.plan);
  const first = { ...original.plan, symbol: "AAAA", setup_score: 60 };
  const second = { ...original.plan, symbol: "BBBB", setup_score: 90 };
  const input = { analysis: JSON.parse(output.report), quotes: [first, second].map(p => ({ ...original.quote, symbol: p.symbol,
    historical: original.measured_evidence })), recommendations: [first, second], dataQuality: output.dataQuality,
    evaluationPolicy: output.evaluationPolicy };
  const document = buildReportDocument(input);
  assert.deepEqual(document.stocks.map(s => s.symbol), ["BBBB", "AAAA"]);
  assert.deepEqual(document.tracked_plans.map(p => p.symbol), ["AAAA", "BBBB"]);
  assert.deepEqual(input.recommendations.map(p => p.symbol), ["AAAA", "BBBB"]);
  const frozen = JSON.stringify(document);
  first.entry_price = 99999;
  input.quotes[0].historical.values.sma20 = -1;
  input.evaluationPolicy.version = "changed";
  assert.equal(JSON.stringify(document), frozen);
});

test("renderer rejects unknown document versions, duplicate stocks and inconsistent decisions", async () => {
  const { output } = await renderScenario("market-open");
  for (const raw of [undefined, null, {}, { report: "raw response", quotes: [] }]) assert.throws(() => formatDashboard(raw), /Expected ReportDocumentV1/);
  assert.throws(() => formatDashboard({ ...output.reportDocument, schema_version: "report-document-v2" }), /Expected ReportDocumentV1/);
  const duplicate = structuredClone(output.reportDocument);
  duplicate.stocks.push(duplicate.stocks[0]);
  assert.throws(() => formatDashboard(duplicate), /Invalid ReportDocumentV1 stock/);
  const inconsistent = structuredClone(output.reportDocument);
  inconsistent.stocks[0].plan = null;
  assert.throws(() => formatDashboard(inconsistent), /Invalid ReportDocumentV1 stock/);
});
