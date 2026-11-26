const { featuresForHistory } = require("./historicalInputs");
const { sessionDate } = require("./marketCalendar");
const policy = require("../../config/evaluation-policy.json");
const { validDate } = require("./earnings");
const VERSION = "regime-events-v1";

function tradingWindow(calendar, issuedAt) {
  if (calendar?.status !== "ok" || !Number.isFinite(issuedAt)) return null;
  const day = sessionDate(issuedAt);
  if (day < calendar.start || day > calendar.end) return null;
  const count = policy.entry_sessions + policy.holding_sessions - 1;
  const sessions = calendar.sessions.filter(s => s.date > day).slice(0, count);
  if (sessions.length !== count) return null;
  return { from: sessions[0].date, to: sessions.at(-1).date, sessions: sessions.map(s => s.date), evaluation_version: policy.version };
}

function computeRegime(history, calendar, now, features = featuresForHistory(history, calendar, now, "SPY")) {
  const { sma50, sma200 } = features.values;
  const close = history?.candles?.find(c => c.date === features.asof_session)?.close;
  const usable = features.status !== "invalid" && features.completed_sessions >= 200 && [close, sma50, sma200].every(Number.isFinite);
  return { version: "spy-trend-v1", symbol: "SPY", source: "alpaca", feed: "sip", adjustment: "split",
    state: usable ? close > sma50 && sma50 > sma200 ? "uptrend" : close < sma50 && sma50 < sma200 ? "downtrend" : "mixed" : "unknown",
    asof_session: features.asof_session, close: usable ? close : null, sma50: usable ? sma50 : null, sma200: usable ? sma200 : null,
    reasons: usable ? [] : [...features.reasons, "insufficient_or_invalid_spy_history_200"] };
}

function assessEarnings(snapshot, window, now, symbol = snapshot?.symbol) {
  const empty = { state: "unknown", coverage: "unknown", source_status: snapshot?.status || "missing", conflicts: [],
    fetched_at: snapshot?.fetched_at || null, provider_updated_at: snapshot?.provider_updated_at || null };
  if (!window) return { ...empty, reasons: ["earnings_window_unknown"] };
  if (snapshot?.symbol !== symbol || snapshot?.source !== "finnhub") return { ...empty, reasons: ["earnings_identity_or_source_unknown"] };
  const stamp = Date.parse(snapshot?.fetched_at);
  if (!Number.isFinite(stamp) || stamp > now) return { ...empty, reasons: ["earnings_evidence_time_unknown_or_future"] };
  if (!Array.isArray(snapshot?.events) || !["observed", "partial", "empty"].includes(snapshot.status)) return { ...empty, reasons: ["earnings_evidence_missing_or_failed"] };
  const reportedEvents = snapshot.events.filter(e => e && e.symbol === symbol && validDate(e.date)
    && ["confirmed", "estimated", "reported_unconfirmed"].includes(e.certainty)
    && Number.isFinite(Date.parse(e.observed_at)) && Date.parse(e.observed_at) <= stamp
    && (e.provider_updated_at == null || Date.parse(e.provider_updated_at) <= stamp));
  const conflicts = reportedEvents.filter(e => e.date >= window.from && e.date <= window.to);
  const stale = now - stamp > 86400000;
  return { ...empty, state: conflicts.length ? "reported_conflict" : "unknown", conflicts, reported_events: reportedEvents,
    reasons: [...(snapshot.reasons || []), ...(stale ? ["earnings_snapshot_stale"] : []),
      ...(!conflicts.length ? ["no_reported_conflict_does_not_establish_event_free"] : ["reported_earnings_in_full_trade_window"])],
    requested_window_covered: snapshot.from <= window.from && snapshot.to >= window.to };
}

function withRegimeEvents(inputs, { now = Date.parse(inputs.dataQuality.checked_at), benchmarkFeatures } = {}) {
  const calendar = inputs.evidence?.calendar;
  const window = tradingWindow(calendar, now);
  const regime = computeRegime(inputs.evidence?.histories?.SPY, calendar, now, benchmarkFeatures);
  const earnings = Object.fromEntries(inputs.quotes.map(q => [q.symbol,
    assessEarnings(inputs.evidence?.earnings?.[q.symbol], window, now, q.symbol)]));
  return { ...inputs, marketContext: { version: VERSION, checked_at: new Date(now).toISOString(), window, regime, earnings,
    alignment_filter: false, unknown_events_policy: "disclose_without_claiming_event_free", earnings_filter: "reported_date_whole_session" } };
}

function filterContextPlans(plans, context) {
  const recommendations = [], exclusions = [];
  for (const plan of plans) {
    const risk = context.earnings[plan.symbol];
    let reason;
    if (!context.window) reason = "earnings_window_unknown";
    else if (risk?.state === "reported_conflict") reason = "reported_earnings_conflict";
    if (reason) exclusions.push({ symbol: plan.symbol, reason, conflicts: risk?.conflicts || [] });
    else recommendations.push({ ...plan, market_regime: context.regime.state });
  }
  return { recommendations, exclusions };
}

module.exports = { VERSION, tradingWindow, computeRegime, assessEarnings, withRegimeEvents, filterContextPlans };
