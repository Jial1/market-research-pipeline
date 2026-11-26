const { createReadGet } = require("../readRetry");
const providerGet = createReadGet();
const { sessionDate, shiftDate } = require("./marketCalendar");
const { validateCandles } = require("./quality");

async function fetchAlpacaCandles(symbol, calendar, { now = Date.now(), env = {}, get = providerGet } = {}) {
  const failure = reason => ({ symbol, source: "alpaca", feed: "sip", adjustment: "split",
    fetched_at: new Date(now).toISOString(), candles: [], quality: { status: "failed", reasons: [reason], sufficient_51: false, sufficient_200: false } });
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return failure("invalid_symbol");
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) return failure("missing_history_credentials");
  if (calendar.status !== "ok") return failure("calendar_unknown");
  // Historical SIP access requires an end at least 15 minutes old.
  const cutoff = now - 16 * 60000;
  let pageToken;
  const seen = new Set();
  const rows = [];
  try {
    for (let page = 0; page < 5; page++) {
      const response = await get("https://data.alpaca.markets/v2/stocks/bars", {
        headers: { "APCA-API-KEY-ID": env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY },
        params: { symbols: symbol, timeframe: "1Day", feed: "sip", adjustment: "split", sort: "asc", limit: 1000,
          start: `${shiftDate(sessionDate(now), -400)}T00:00:00Z`, end: new Date(cutoff).toISOString(), asof: sessionDate(now),
          ...(pageToken ? { page_token: pageToken } : {}) }, timeout: 10000
      });
      const bars = response.data?.bars;
      if (!bars || typeof bars !== "object" || Array.isArray(bars) || Object.keys(bars).some(k => k !== symbol)
        || (bars[symbol] !== undefined && !Array.isArray(bars[symbol]))) return failure("invalid_history_response");
      rows.push(...(bars[symbol] || []));
      pageToken = response.data.next_page_token;
      if (!pageToken) return { ...validateCandles(symbol, rows, calendar, cutoff), fetched_at: new Date(now).toISOString(),
        validated_asof: new Date(cutoff).toISOString() };
      if (typeof pageToken !== "string" || seen.has(pageToken)) return failure("invalid_history_pagination");
      seen.add(pageToken);
    }
    return failure("incomplete_history_pagination");
  } catch {
    return failure("history_request_failed");
  }
}

module.exports = { fetchAlpacaCandles };
