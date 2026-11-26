const { amendReport } = require("../fixtures/model-analysis");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runReport } = require("../src/reportRun");
const { buildReportDocument } = require("../src/reportDocument");
const { formatDashboard } = require("../src/formatter");
const { normalizeEarnings } = require("../src/data/earnings");
const { makeRegimeFixture, NOW } = require("../fixtures/regime-events");
const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: false } };
async function render(mutate = () => {}) {
  const fixture = makeRegimeFixture(); mutate(fixture);
  let artifact;
  await runReport(settings, { dryRun: true }, { now: () => NOW, collectInputs: async () => fixture.inputs,
    generateReport: async () => ({ content: fixture.reports.enriched }), writeArtifact: value => { artifact = value; return "fixture"; } });
  return artifact;
}

function stockCard(html, symbol) { return html.split(`data-report-symbol="${symbol}"`)[1]?.split("</article>")[0] || ""; }

test("approved layout leads with analysis/watchlist/cards and replaces diagnostics with three footer lines", async () => {
  const { output } = await render(); const html = output.html;
  assert.ok(html.indexOf("Market analysis · AI commentary") < html.indexOf("Watchlist"));
  assert.ok(html.indexOf("Watchlist") < html.indexOf("Stock analysis</h3>"));
  assert.ok(html.indexOf('data-report-symbol="MSFT"') < html.indexOf("<footer"));
  const main = html.split("<footer")[0];
  assert.match(main, /Measured evidence/); assert.match(main, /Earnings risk/); assert.match(main, /2026-10-28 after close \(date unconfirmed\)/);
  assert.doesNotMatch(html, /Technical appendix|Data quality|Measured historical indicators|Computed SPY trend|Next-session hypothetical|next-session-v1|daily-indicators-v1|Source response:/);
  const footer = html.split("<footer")[1].split("</footer>")[0];
  assert.equal((footer.match(/<div>/g) || []).length, 3);
  assert.match(footer, /Quote dates: 2026-10-21/); assert.match(footer, /Daily bars through: 2026-10-20/);
  assert.equal(output.evaluationPolicy.version, "next-session-v1");
  assert.equal(output.dataQuality.symbols[0].historical.completed_sessions, 200);
  assert.deepEqual(output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.equal(output.exclusions[0].reason, "reported_earnings_conflict");
  const research = stockCard(main, "MSFT");
  assert.match(research, /MSFT/); assert.doesNotMatch(research, /Entry:|Target:|Stop:|R\/R/);
  assert.equal(output.marketContext.earnings.MSFT.conflicts[0].timing, "after_close", "saved evidence retains raw timing");
});

test("successful empty responses omit individual earnings notes and use one general footer", async () => {
  const { output } = await render(f => { f.inputs.evidence.earnings.MSFT.events = []; f.inputs.evidence.earnings.MSFT.status = "empty"; });
  assert.doesNotMatch(output.html, /Earnings date<\/b>|Earnings risk<\/b>|Earnings verification is incomplete/);
  assert.equal((output.html.match(/No displayed date does not establish an earnings-free trading window/g) || []).length, 1);
  assert.equal(output.recommendations.length, 2);
});

test("a valid reported date outside the trade window is a note, not a veto", async () => {
  const { output } = await render(f => { f.inputs.evidence.earnings.MSFT = normalizeEarnings("MSFT",
    { earningsCalendar: [{ symbol: "MSFT", date: "2026-10-29", hour: "bmo" }] },
    { from: "2026-10-22", to: "2026-10-30", now: NOW }); });
  assert.match(output.html, /Earnings date/); assert.match(output.html, /2026-10-29 before open \(date unconfirmed\)/);
  assert.doesNotMatch(output.html, /<b>Earnings risk/); assert.equal(output.recommendations.length, 2);
});

test("failed, invalid and stale earnings evidence is visibly uncertain, without inventing a date", async () => {
  for (const state of ["failed", "invalid", "stale"]) {
    const { output } = await render(f => {
      const e = f.inputs.evidence.earnings.NVDA;
      if (state === "stale") e.fetched_at = new Date(NOW-86400001).toISOString();
      else e.status = state;
    });
    assert.match(output.html.split("Technical appendix")[0], /Earnings verification is incomplete or unavailable/);
    assert.equal(output.marketContext.earnings.NVDA.coverage, "unknown");
  }
});

test("research cards preserve evidence but omit numeric orders for invalid or excluded stocks", async () => {
  const blocked = await render(f => {
    f.inputs.quotes[0].quality = { status: "invalid", actionable: false, reasons: ["invalid_quote_values"] };
  });
  const main = blocked.output.html.split("Technical appendix")[0];
  assert.match(main, /NVDA/); assert.match(main, /Measured evidence/);
  assert.deepEqual(blocked.output.recommendations, []);
  assert.doesNotMatch(main, /Entry:|Target:|Stop:|R\/R/);
});

test("layout restores full market commentary and ranks only approved plans without changing saved order", async () => {
  const { output } = await render(f => {
    f.inputs.evidence.earnings.MSFT.events = []; f.inputs.evidence.earnings.MSFT.status = "empty";
    f.reports.enriched = f.reports.enriched.replace(/"setup_score":80/g,
      (() => { let i = 0; return () => `"setup_score":${i++ ? 90 : 80}`; })());
    f.reports.enriched = amendReport(f.reports.enriched, a => { a.market_summary = "Daily Summary:\n- Example market analysis\n- Related news:\n  - MSFT:Example news context"; });
  });
  const main = output.html.split("<footer")[0];
  assert.ok(main.indexOf("Market analysis · AI commentary") < main.indexOf("Watchlist"));
  assert.ok(main.indexOf("Watchlist") < main.indexOf("Stock analysis</h3>"));
  assert.match(main, /Example news context/);
  const table = main.split("<table")[1].split("</table>")[0];
  assert.ok(table.indexOf("MSFT") < table.indexOf("NVDA"));
  assert.match(stockCard(main, "MSFT"), /A \/ 90/);
  assert.ok(stockCard(main, "MSFT").indexOf("Structure:") < stockCard(main, "MSFT").indexOf("Entry:"));
  assert.deepEqual(output.recommendations.map(p => p.symbol), ["NVDA", "MSFT"], "display sorting does not mutate tracked plans");
});

test("closed report shares warnings once, keeps unranked watchlist order and does not add strategies", async () => {
  const { output, snapshot } = await render();
  output.html = formatDashboard(buildReportDocument({ analysis: JSON.parse(output.report),
    quotes: snapshot.inputs.quotes.map(q => ({ ...q, quality: { enforced: true, status: "research_only", actionable: false, reasons: ["market_closed"] } })),
    dataQuality: { ...output.dataQuality, session_state: "closed" }, recommendations: [], marketContext: output.marketContext }));
  const main = output.html.split("Technical appendix")[0];
  const table = main.split("<table")[1].split("</table>")[0];
  assert.ok(table.indexOf("NVDA") < table.indexOf("MSFT"));
  assert.doesNotMatch(table, /Unranked|Priority/);
  assert.match(main, /Market closed/);
  assert.doesNotMatch(main, /Watch condition:|Quote time:|This is historical performance only|Market closed, research only|Entry:|Target:|Stop:|R\/R/);
  assert.match(main, /Earnings risk/);
  assert.doesNotMatch(main, /Approved plan<\/h3>/);
});

test("research cards restore symbol-specific analysis without promoting blocked plans", async () => {
  const { output } = await render(f => {
    f.reports.enriched = amendReport(f.reports.enriched, a => { Object.assign(a.stocks.find(s => s.symbol === "MSFT"), {"structure": "through 2026-10-20, SMA20 is 118.95, aboveSMA50 of 117.45; Moving averages indicate relative strength.", "momentum": "20-session return1.70%, ATR14 is 1.50; Positive returns do not guarantee continuation.", "catalyst": "News coverage is unknown, the latest catalyst cannot be confirmed.", "risk": "The reported earnings date falls within the trading window, Event-driven volatility is uncertain."}); });
  });
  const research = stockCard(output.html, "MSFT");
  assert.match(research, /Stock analysis · AI commentary/);
  assert.match(research, /SMA20 is 118.95/);
  assert.match(research, /ATR14 is 1.50/);
  assert.match(research, /News coverage is unknown/);
  assert.match(research, /Event-driven volatility is uncertain/);
  assert.doesNotMatch(research, /99999|88888|77777/);
  assert.deepEqual(output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.equal(output.exclusions[0].reason, "reported_earnings_conflict");
});

test("analysis is escaped, symbol-bound, optional and cannot expose strategy fields", async () => {
  const { output } = await render(f => {
    f.reports.enriched = amendReport(f.reports.enriched, a => { Object.assign(a.stocks.find(s => s.symbol === "MSFT"), {"structure": "<img src=x onerror=alert(1)>Moving averages diverge", "momentum": "Entry99999, Target88888, Stop77777", "catalyst": "No date was supplied, News coverage is unknown", "risk": "Evidence is limited"}); });
  });
  const research = stockCard(output.html, "MSFT");
  assert.match(research, /&lt;img/);
  assert.doesNotMatch(research, /<img|OTHER_ONLY|99999|88888|77777/);
  assert.match(research, /Momentum: <\/b>Not supplied by the model/);
  const missing = await render();
  assert.match(missing.output.html, /No stock analysis was supplied by the model/);
});

test("English research analysis keeps short-term descriptions while hiding compact numerical trade instructions", async () => {
  const { output } = await render(f => {
    f.reports.enriched = amendReport(f.reports.enriched, a => { Object.assign(a.stocks.find(s => s.symbol === "MSFT"), {"structure": "The short-term moving average remains above the medium-term average.", "momentum": "Entry99999, Target88888, Stop77777", "catalyst": "No verified catalyst was supplied.", "risk": "Earnings timing and coverage remain uncertain."}); });
  });
  const research = stockCard(output.html, "MSFT");
  assert.match(research, /The short-term moving average remains above the medium-term average/);
  assert.match(research, /Momentum: <\/b>Not supplied by the model/);
  assert.doesNotMatch(research, /99999|88888|77777/);
});

test("enriched model request carries indicators, news and analysis instructions for research stocks", async () => {
  const fixture = makeRegimeFixture(); let saved;
  fixture.inputs.quotes[1].quality = { enforced: true, status: "research_only", actionable: false, reasons: ["market_closed"] };
  fixture.inputs.news.MSFT = { items: [{ headline: "MSFT_FIXTURE_NEWS", datetime: "2026-10-20T12:00:00Z" }], quality: { status: "observed" } };
  await runReport(settings, { dryRun: true }, { now: () => NOW, collectInputs: async () => fixture.inputs,
    generateReport: async (inputs, feedback, request) => {
      saved = request.messages[0].content;
      for (const field of ["sma20", "sma50", "sma200", "return5d", "return20d", "return50d", "atr14", "range20Low", "range20High"]) {
        assert.ok(saved.includes(`"${field}"`));
      }
      assert.match(saved, /MSFT_FIXTURE_NEWS/);
      assert.match(saved, /exactly one analysis for every quoted symbol/);
      assert.match(saved, /Do not infer that there are no catalysts/);
      assert.match(saved, /Do not write entry, target, stop/i);
      return { content: fixture.reports.enriched };
    }, writeArtifact: () => "fixture" });
  assert.ok(saved);
});

test("compact email preserves full evidence in the saved run and shows unknown metadata honestly", async () => {
  const { output, snapshot } = await render();
  assert.equal(snapshot.inputs.quotes[0].provider_at, new Date(NOW).toISOString());
  assert.equal(snapshot.inputs.quotes[0].historical.completed_sessions, 200);
  assert.ok(Number.isFinite(snapshot.inputs.quotes[0].historical.values.sma200));
  assert.ok(Number.isFinite(snapshot.inputs.quotes[0].historical.values.return50d));
  assert.equal(output.evaluationPolicy.friction_bps_per_side.base, 5);
  assert.equal(output.marketContext.regime.version, "spy-trend-v1");
  assert.doesNotMatch(output.html, /2026-10-21T16:00:00|market_closed|daily-indicators-v1|next-session-v1/);
  const html = formatDashboard(buildReportDocument({ analysis: { market_summary: "Daily Summary:\n- No evidence available", stocks: [] }, quotes: [{ symbol: "NVDA", quality: { actionable: false } }],
    dataQuality: { session_state: "unknown", symbols: [] }, recommendations: [] }));
  assert.match(html, /Quote unavailable/); assert.match(html, /Quote dates: unknown/);
  assert.match(html, /Daily bars through: unknown/); assert.match(html, /Sources: unspecified/);
  assert.match(html, /Market status unconfirmed/); assert.match(html, /Tracked plan entry: unconfirmed/);
});
