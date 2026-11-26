const { createReadGet } = require("./readRetry");
const providerGet = createReadGet();

async function fetchNewsSnapshot(symbol, { get = providerGet, now = Date.now, apiKey } = {}) {
  const started = now();
  const base = { source: "finnhub", fetched_at: new Date(started).toISOString() };
  if (!apiKey) return { ...base, items: [], quality: { status: "failed", reasons: ["missing_news_credentials"] } };
  try {
    const response = await get("https://finnhub.io/api/v1/company-news", {
      headers: { "X-Finnhub-Token": apiKey }, timeout: 10000,
      params: { symbol, from: new Date(started - 3 * 86400000).toISOString().slice(0, 10), to: new Date(started).toISOString().slice(0, 10) }
    });
    const fetched = now();
    if (!Array.isArray(response.data)) throw new Error("Invalid news response");
    let invalid = 0;
    const seen = new Set();
    const items = response.data.filter(item => {
      if (!item || typeof item.headline !== "string" || !item.headline.trim()
        || typeof item.source !== "string" || !Number.isFinite(item.datetime) || item.datetime <= 0
        || item.datetime * 1000 > fetched || item.datetime * 1000 < started - 4 * 86400000) { invalid++; return false; }
      return true;
    }).sort((a, b) => b.datetime - a.datetime).filter(item => {
      const key = `${item.datetime}:${item.headline}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 3).map(item => ({ headline: item.headline, source: item.source,
      summary: typeof item.summary === "string" ? item.summary : "", published_at: new Date(item.datetime * 1000).toISOString(),
      url: typeof item.url === "string" && /^https?:\/\//.test(item.url) ? item.url : null }));
    return { ...base, fetched_at: new Date(fetched).toISOString(), items,
      quality: { status: invalid ? "invalid" : items.length ? "ok" : "empty", reasons: invalid ? ["invalid_news_items_removed"] : [] } };
  } catch {
    return { ...base, items: [], quality: { status: "failed", reasons: ["news_request_failed_or_invalid"] } };
  }
}

async function fetchAllNews(symbols, options = {}) {
  const result = {};
  for (const symbol of symbols) {
    const snapshot = await fetchNewsSnapshot(symbol, options);
    result[symbol] = snapshot;
  }
  return result;
}
module.exports = { fetchAllNews, fetchNewsSnapshot };
