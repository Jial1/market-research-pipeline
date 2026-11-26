const { modelAnalysis } = require("./model-analysis");
// Synthetic evidence for deterministic replay; this is not an exchange holiday calendar.
const { sessionTime } = require("../src/data/marketCalendar");
const NOW = Date.parse("2026-10-21T16:00:00Z");

function makeHistoricalFixture(counts = { NVDA: 200, SPCX: 50 }) {
  const dates = [];
  for (let ms = Date.parse("2025-10-01T12:00:00Z"); ms <= Date.parse("2026-10-28T12:00:00Z"); ms += 86400000) {
    const d = new Date(ms);
    if (![0, 6].includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10));
  }
  const calendar = { source: "synthetic_fixture", status: "ok", start: dates[0], end: dates.at(-1),
    sessions: dates.map(date => ({ date, open_at: new Date(sessionTime(date, "09:30")).toISOString(), close_at: new Date(sessionTime(date, "16:00")).toISOString() })) };
  const histories = {}, quotes = [], news = {}, plans = [];
  for (const [symbol, count] of Object.entries(counts)) {
    const candles = dates.filter(d => d < "2026-10-21").slice(-count).map((date, i) => {
      const close = 100 + i / 10;
      return { date, provider_at: new Date(sessionTime(date, "00:00")).toISOString(), open: close - .2, high: close + .8, low: close - .7, close, volume: 10000 };
    });
    const price = candles.at(-1).close + .3;
    quotes.push({ symbol, price, open: price - .2, high: price + 1, low: price - 1, previousClose: candles.at(-1).close,
      change: .3, changePercent: .3 / candles.at(-1).close * 100, source: "finnhub",
      provider_at: new Date(NOW).toISOString(), fetched_at: new Date(NOW).toISOString(),
      quality: { enforced: true, status: "ok", actionable: true, reasons: [] } });
    histories[symbol] = { symbol, source: "alpaca", feed: "sip", adjustment: "split", candles,
      validated_asof: new Date(NOW - 16 * 60000).toISOString(), quality: { status: "ok", reasons: [], completed_sessions: count } };
    news[symbol] = { items: [], quality: { status: "empty" } };
    plans.push({ symbol, trade_direction: "long", entry_prediction: "breakout", entry_price: price,
      target_price: price + 10, stop_loss: price - 4, setup_score: 80, structure: "fixture", momentum: "fixture", liquidity: "unknown", reason: "fixture", risk: "fixture" });
  }
  const inputs = { quotes, news, evidence: { calendar, histories }, dataQuality: {
    checked_at: new Date(NOW).toISOString(), session_state: "open", eligible_session: "2026-10-22",
    symbols: quotes.map(q => ({ symbol: q.symbol, source: q.source, ...q.quality })) } };
  return { now: NOW, synthetic: true, inputs,
    reports: { baseline: JSON.stringify(modelAnalysis(Object.keys(counts), plans, [], "Daily Summary:\n- Synthetic baseline, test only.")),
      enriched: JSON.stringify(modelAnalysis(Object.keys(counts), plans, [], "Daily Summary:\n- Synthetic indicator report, test only; daily indicators are in the separate evidence table; fewer than51bars means research only.")) } };
}

module.exports = { makeHistoricalFixture, NOW };
