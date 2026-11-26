const { createReadGet } = require("../readRetry");
const providerGet = createReadGet();
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

function normalizeEarnings(symbol, data, { from, to, now }) {
  const base = { symbol, source: "finnhub", fetched_at: new Date(now).toISOString(), provider_updated_at: null,
    from, to, coverage: "unknown", events: [], reasons: [] };
  if (!Array.isArray(data?.earningsCalendar)) return { ...base, status: "invalid", reasons: ["invalid_earnings_response"] };
  let invalid = 0;
  for (const row of data.earningsCalendar) {
    if (!row || row.symbol !== symbol || !validDate(row.date) || row.date < from || row.date > to
      || (row.epsActual != null || row.revenueActual != null)) { invalid++; continue; }
    const event = { symbol, date: row.date, timing: { bmo: "before_open", amc: "after_close", dmh: "during_session" }[row.hour] || "unknown",
      certainty: "reported_unconfirmed", source: "finnhub", observed_at: base.fetched_at, provider_updated_at: null };
    if (!base.events.some(e => e.date === event.date && e.timing === event.timing)) base.events.push(event);
  }
  base.events.sort((a, b) => a.date.localeCompare(b.date));
  return { ...base, status: invalid ? base.events.length ? "partial" : "invalid" : base.events.length ? "observed" : "empty",
    reasons: invalid ? ["invalid_or_mismatched_earnings_rows"] : [] };
}

async function fetchEarnings(symbol, { from, to, now = Date.now(), env = {}, get = providerGet } = {}) {
  const failed = reason => ({ symbol, source: "finnhub", fetched_at: new Date(now).toISOString(), provider_updated_at: null,
    from, to, status: "failed", coverage: "unknown", events: [], reasons: [reason] });
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !validDate(from) || !validDate(to) || from > to) return failed("invalid_earnings_request");
  if (!env.FINNHUB_API_KEY) return failed("missing_earnings_credentials");
  try {
    const response = await get("https://finnhub.io/api/v1/calendar/earnings", {
      params: { symbol, from, to }, headers: { "X-Finnhub-Token": env.FINNHUB_API_KEY }, timeout: 10000
    });
    return normalizeEarnings(symbol, response.data, { from, to, now });
  } catch { return failed("earnings_request_failed"); }
}

module.exports = { fetchEarnings, normalizeEarnings, validDate };
