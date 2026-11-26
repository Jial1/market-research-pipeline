const { calendarContext } = require("./data/marketCalendar");
const { withHistoricalIndicators } = require("./data/historicalInputs");
const { withRegimeEvents, tradingWindow } = require("./data/regimeEvents");
const { withPreparation, preparationWindow } = require("./preparation");

// Domain policy supplies the collector's request bounds, independently of fetches.
function earningsRequestWindow(calendar, now) {
  const windows = [tradingWindow(calendar, now), preparationWindow(calendar, now)].filter(Boolean);
  if (!windows.length) return null;
  return { from: windows.map(w => w.from).sort()[0], to: windows.map(w => w.to).sort().at(-1) };
}

// Called once before generation and again at issuance with the actual clock.
// Recompute from saved normalized evidence each time; never reuse eligibility or
// indicator caches across stages/session boundaries. No provider calls occur here.
function qualifyReportInputs(inputs, { now, maxAgeSeconds = 900 }) {
  if (!Number.isFinite(now)) throw new Error("Qualification requires an explicit time");
  if (!Array.isArray(inputs?.quotes) || !Array.isArray(inputs?.dataQuality?.symbols)) throw new Error("Missing validated input summary");
  const calendar = calendarContext(inputs.evidence?.calendar, now);
  const historical = withHistoricalIndicators(inputs, { now, maxAgeSeconds });
  const contextual = withRegimeEvents(historical, { now,
    benchmarkFeatures: historical.quotes.find(q => q.symbol === "SPY")?.historical });
  return withPreparation({ ...contextual, dataQuality: { ...contextual.dataQuality,
    session_state: calendar.state, eligible_session: calendar.next_session?.date || null } }, now);
}

module.exports = { earningsRequestWindow, qualifyReportInputs };
