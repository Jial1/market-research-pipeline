const { calendarContext, sessionDate } = require("./marketCalendar");
const positive = v => Number.isFinite(v) && v > 0;
const iso = ms => Number.isFinite(ms) && Math.abs(ms) < 8640000000000000 ? new Date(ms).toISOString() : null;

function quoteObservation(symbol, data, now) {
  const reasons = [];
  if (![data?.c, data?.o, data?.h, data?.l, data?.pc].every(positive)
    || data.h < Math.max(data.o, data.l) || data.l > data.o
    || !Number.isFinite(data.d) || !Number.isFinite(data.dp)) reasons.push("invalid_quote_values");
  const stamp = Number.isFinite(data?.t) && data.t > 0 ? data.t * 1000 : NaN;
  if (!iso(stamp)) reasons.push("missing_or_invalid_provider_time");
  else if (stamp > now) reasons.push("future_provider_time");
  return {
    symbol, price: positive(data?.c) ? data.c : null, change: data?.d ?? null, changePercent: data?.dp ?? null,
    high: data?.h ?? null, low: data?.l ?? null, open: data?.o ?? null, previousClose: data?.pc ?? null,
    source: "finnhub", provider_at: iso(stamp), fetched_at: iso(now),
    quality: { status: reasons.length ? "invalid" : "observed", actionable: false, reasons }
  };
}

function validateQuote(quote, calendar, now, maxAgeSeconds = 900) {
  // Recompute session eligibility; a prior closure is not a data error.
  const reasons = (quote.quality?.reasons || []).filter(reason => reason !== "market_closed");
  const context = calendarContext(calendar, now);
  const stamp = Date.parse(quote.provider_at);
  if (!quote.quality || quote.quality.status === "failed") reasons.push("quote_unavailable");
  if (!Number.isFinite(stamp) || stamp > now) reasons.push("invalid_quote_timestamp");
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error("Invalid quote freshness threshold");
  if (context.state === "unknown") reasons.push("calendar_unknown");
  else if (context.state === "open") {
    if (!context.next_session) reasons.push("next_session_unknown");
    if (!positive(quote.price) || quote.price > quote.high || quote.price < quote.low) reasons.push("price_outside_session_range");
    if (sessionDate(stamp || now) !== context.date || stamp < Date.parse(context.current_session.open_at)
      || (now - stamp) / 1000 > maxAgeSeconds) reasons.push("stale_quote");
  } else {
    const previous = context.previous_session;
    if (!previous || !Number.isFinite(stamp) || sessionDate(stamp) !== previous.date
      || stamp < Date.parse(previous.close_at) - maxAgeSeconds * 1000) reasons.push("stale_last_session_quote");
  }
  const valid = reasons.length === 0;
  return { ...quote, quality: { enforced: true, status: valid ? context.state === "open" ? "ok" : "research_only" : "invalid",
    actionable: valid && context.state === "open", reasons: valid && context.state === "closed" ? ["market_closed"] : [...new Set(reasons)] } };
}

function validateCandles(symbol, rows, calendar, now) {
  const reasons = [];
  const sessions = new Map((calendar.sessions || []).map(s => [s.date, s]));
  if (calendar.status !== "ok") reasons.push("calendar_unknown");
  if (!Array.isArray(rows)) rows = [];
  const candles = [];
  const seen = new Set();
  let previous = -Infinity;
  let excludedIncomplete = 0;
  for (const bar of rows) {
    const stamp = typeof bar?.t === "string" ? Date.parse(bar.t) : NaN;
    if (!Number.isFinite(stamp) || stamp > now || ![bar.o, bar.h, bar.l, bar.c].every(positive)
      || bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c)
      || !Number.isFinite(bar.v) || bar.v < 0) { reasons.push("invalid_candle"); continue; }
    const date = sessionDate(stamp);
    if (seen.has(date) || stamp <= previous) reasons.push("duplicate_or_unordered_candles");
    seen.add(date); previous = stamp;
    const session = sessions.get(date);
    if (!session) { reasons.push("non_session_candle"); continue; }
    if (Date.parse(session.close_at) > now) { excludedIncomplete++; continue; }
    candles.push({ date, provider_at: iso(stamp), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v });
  }
  candles.sort((a, b) => a.date.localeCompare(b.date));
  if (!candles.length) reasons.push("no_completed_history");
  const expectedLast = calendarContext(calendar, now).previous_session?.date;
  if (candles.length && candles.at(-1).date !== expectedLast) reasons.push("stale_history");
  if (candles.length) {
    const present = new Set(candles.map(c => c.date));
    if ([...sessions.values()].some(s => s.date >= candles[0].date && Date.parse(s.close_at) <= now && !present.has(s.date))) {
      reasons.push("history_session_gap");
    }
  }
  return { symbol, source: "alpaca", feed: "sip", adjustment: "split", fetched_at: iso(now), candles,
    excluded_incomplete: excludedIncomplete,
    quality: { status: reasons.length ? "invalid" : "ok", reasons: [...new Set(reasons)],
      completed_sessions: candles.length, sufficient_51: !reasons.length && candles.length >= 51,
      sufficient_200: !reasons.length && candles.length >= 200 } };
}

module.exports = { quoteObservation, validateQuote, validateCandles };
