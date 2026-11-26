const { makeRegimeFixture } = require("./regime-events");
const { calendarContext, sessionTime } = require("../src/data/marketCalendar");
const { normalizeEarnings } = require("../src/data/earnings");

function makePreparationFixture(now = Date.parse("2026-10-21T12:00:00Z")) {
  const fixture = makeRegimeFixture();
  const inputs = fixture.inputs, calendar = inputs.evidence.calendar;
  calendar.end = "2026-11-04";
  for (const date of ["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04"]) calendar.sessions.push({ date,
    open_at: new Date(sessionTime(date, "09:30")).toISOString(), close_at: new Date(sessionTime(date, "16:00")).toISOString() });
  const context = calendarContext(calendar, now);
  for (const history of Object.values(inputs.evidence.histories)) {
    for (const session of calendar.sessions.filter(s => s.date > history.candles.at(-1).date && Date.parse(s.close_at) <= now)) {
      const close = history.candles.at(-1).close + .1;
      history.candles.push({ date: session.date, provider_at: new Date(sessionTime(session.date, "00:00")).toISOString(),
        open: close-.2, high: close+.8, low: close-.7, close, volume: 10000 });
    }
    history.validated_asof = new Date(now-16*60000).toISOString();
  }
  for (const q of inputs.quotes) {
    q.provider_at = context.state === "open" ? new Date(now).toISOString() : context.previous_session.close_at;
    q.fetched_at = new Date(now).toISOString();
    q.quality = { enforced: true, status: context.state === "open" ? "ok" : "research_only",
      actionable: context.state === "open", reasons: context.state === "open" ? [] : ["market_closed"] };
    inputs.evidence.earnings[q.symbol] = normalizeEarnings(q.symbol,
      { earningsCalendar: q.symbol === "MSFT" ? [{ symbol: q.symbol, date: "2026-10-22", hour: "amc" }] : [] },
      { from: context.state === "open" ? "2026-10-22" : context.current_session && now < Date.parse(context.current_session.open_at) ? context.date : context.next_session.date,
        to: calendar.end, now });
  }
  inputs.dataQuality.checked_at = new Date(now).toISOString();
  inputs.dataQuality.session_state = context.state;
  inputs.dataQuality.eligible_session = context.next_session.date;
  const asof = inputs.evidence.histories.NVDA.candles.at(-1).date;
  const candidates = ["NVDA", "MSFT"].map(symbol => ({ symbol, decision: "propose", trade_direction: "long", entry_price: 120, target_price: 130, stop_loss: 116,
    trigger: "Confirm and sustain the breakout using fresh quotes after the open, then revalidate eligibility", thesis: "SMA20 is above SMA50; assess the trend using completed daily bars", invalidation: "Abandon if price gaps beyond the reference or reverses", risk: "Preparation only; an empty earnings response does not rule out events. Review events manually", evidence_asof: asof }));
  const analysis = JSON.parse(fixture.reports.enriched);
  analysis.market_summary = "Daily Summary:\n- Synthetic preparation report, for validation only.";
  analysis.stocks = [
    { symbol: "NVDA", structure: "Moving averages from completed daily bars indicate relative strength; verify against fresh market data.",
      momentum: "Positive historical returns do not guarantee continuation; ATR reflects historical volatility.",
      catalyst: "No relevant news was retrieved; this does not mean there are no catalysts.", risk: "Fresh quotes and events still require verification." },
    { symbol: "MSFT", structure: "Moving averages indicate relative strength.", momentum: "Historical gains do not guarantee continuation.",
      catalyst: "News coverage is limited.", risk: "Review the reported earnings date." }
  ];
  analysis.preparation = candidates;
  const report = JSON.stringify(analysis);
  return { inputs, report, candidates, now };
}
module.exports = { makePreparationFixture };
