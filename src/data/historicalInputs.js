const { validateCandles } = require("./quality");
const { calculateIndicators, VERSION } = require("./indicators");
const { calendarContext, sessionDate } = require("./marketCalendar");

function featuresForHistory(history, calendar, checkedAt, symbol = history?.symbol) {
  const failed = reason => ({ ...calculateIndicators([]), status: "invalid", enforced: true, eligible: false,
    source: history?.source || "unknown", feed: history?.feed || "unknown", adjustment: history?.adjustment || "unknown", reasons: [reason] });
  if (history?.symbol !== symbol || !Array.isArray(history?.candles) || history?.source !== "alpaca" || history.feed !== "sip" || history.adjustment !== "split" || history.quality?.status !== "ok") {
    return failed("unqualified_history");
  }
  const cutoff = Date.parse(history.validated_asof);
  if (!Number.isFinite(cutoff) || !Number.isFinite(checkedAt) || cutoff > checkedAt - 16 * 60000) {
    return failed("history_cutoff_unknown_or_unsafe");
  }
  if (history.candles.some(c => !c || !Number.isFinite(Date.parse(c.provider_at)) || sessionDate(Date.parse(c.provider_at)) !== c.date)) return failed("invalid_history_dates");
  const checked = validateCandles(history.symbol, (history.candles || []).map(c => ({
    t: c.provider_at, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume
  })), calendar || {}, cutoff);
  if (checked.quality.status !== "ok") return failed(checked.quality.reasons.join(","));
  if (checked.candles.at(-1)?.date !== calendarContext(calendar, checkedAt - 16 * 60000).previous_session?.date) return failed("history_stale_at_report");
  const features = calculateIndicators(checked.candles);
  const eligible = features.status === "ok" && Object.entries(features.values).every(([key, value]) => key === "sma200" || Number.isFinite(value));
  return { ...features, enforced: true, eligible, source: "alpaca", feed: "sip", adjustment: "split",
    validated_asof: history.validated_asof, excluded_incomplete: (history.excluded_incomplete || 0) + checked.excluded_incomplete,
    reasons: eligible ? [] : ["insufficient_history_51"] };
}

function withHistoricalIndicators(inputs, { now, maxAgeSeconds = 900 } = {}) {
  const checkedAt = now ?? Date.parse(inputs.dataQuality?.checked_at);
  const quotes = inputs.quotes.map(q => {
    const baseQuality = q.base_quality || q.quality;
    const checkedQuote = now === undefined ? { ...q, quality: baseQuality }
      : require("./quality").validateQuote({ ...q, quality: baseQuality }, inputs.evidence?.calendar || {}, checkedAt, maxAgeSeconds);
    const historical = featuresForHistory(inputs.evidence?.histories?.[q.symbol], inputs.evidence?.calendar, checkedAt, q.symbol);
    const actionable = checkedQuote.quality?.actionable === true && historical.eligible;
    const reasons = [...new Set([...(checkedQuote.quality?.reasons || []), ...historical.reasons])];
    return { ...q, base_quality: baseQuality, historical, quality: { ...checkedQuote.quality, enforced: true, actionable,
      status: historical.status === "invalid" || checkedQuote.quality?.status === "invalid" ? "invalid" : actionable ? "ok" : "research_only", reasons } };
  });
  return { ...inputs, quotes, historicalIndicators: { enabled: true, version: VERSION },
    dataQuality: { ...inputs.dataQuality, checked_at: Number.isFinite(checkedAt) ? new Date(checkedAt).toISOString() : null, symbols: inputs.dataQuality.symbols.map(row => {
      const quote = quotes.find(q => q.symbol === row.symbol);
      return quote ? { ...row, ...quote.quality, historical: quote.historical } : row;
    }) } };
}

module.exports = { featuresForHistory, withHistoricalIndicators };
