const { fetchMarketCalendar } = require("./marketCalendar");
const { fetchAlpacaCandles } = require("./alpacaCandles");

async function collectReportInputs(symbols, { now = Date.now, fetchQuotes = require("../market").fetchQuotes,
  fetchAllNews = require("../news").fetchAllNews, fetchCalendar = fetchMarketCalendar,
  fetchHistory = fetchAlpacaCandles, earningsWindow, fetchEarnings = require("./earnings").fetchEarnings } = {}) {
  if (typeof earningsWindow !== "function") throw new Error("An explicit earnings-window policy is required");
  const calendar = await fetchCalendar({ now: now() });
  const quotes = await fetchQuotes(symbols);
  const news = await fetchAllNews(symbols);
  const histories = {};
  for (const symbol of [...new Set([...symbols, "SPY"])]) histories[symbol] = await fetchHistory(symbol, calendar, { now: now() });
  const earnings = {};
  const window = earningsWindow(calendar, now());
  if (window) for (const symbol of [...new Set(symbols)]) earnings[symbol] = await fetchEarnings(symbol, { ...window, now: now() });
  const checkedAt = now();
  return {
    quotes, news, evidence: { calendar, histories, earnings },
    dataQuality: { checked_at: new Date(checkedAt).toISOString(),
      symbols: quotes.map(q => ({ symbol: q.symbol, source: q.source, provider_at: q.provider_at, fetched_at: q.fetched_at,
        ...q.quality, history: { source: histories[q.symbol]?.source, feed: histories[q.symbol]?.feed,
          adjustment: histories[q.symbol]?.adjustment, fetched_at: histories[q.symbol]?.fetched_at,
          validated_asof: histories[q.symbol]?.validated_asof,
          last_provider_at: histories[q.symbol]?.candles?.at(-1)?.provider_at, quality: histories[q.symbol]?.quality },
        news: news[q.symbol]?.quality || { status: "unknown" } })) }
  };
}

module.exports = { collectReportInputs };
