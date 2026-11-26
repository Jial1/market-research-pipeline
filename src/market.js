const { createReadGet } = require("./readRetry");
const providerGet = createReadGet();
const { quoteObservation } = require("./data/quality");

async function fetchQuote(symbol, { get = providerGet, now = Date.now, apiKey } = {}) {
  if (!apiKey) throw new Error("Missing Finnhub credentials");
  const res = await get("https://finnhub.io/api/v1/quote", {
    headers: { "X-Finnhub-Token": apiKey }, params: { symbol }, timeout: 10000
  });
  return quoteObservation(symbol, res.data, now());
}

async function fetchQuotes(symbols, options = {}) {
  const results = [];

  for (let s of symbols) {
    try {
      const quote = await fetchQuote(s, options);
      results.push(quote);
    } catch (e) {
      results.push({ symbol: s, error: "quote_request_failed", source: "finnhub", provider_at: null,
        fetched_at: new Date((options.now || Date.now)()).toISOString(),
        quality: { status: "failed", actionable: false, reasons: ["quote_request_failed"] } });
    }
  }

  return results;
}

module.exports = { fetchQuotes, fetchQuote };
