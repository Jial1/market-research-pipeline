// Completed-session formulas only. No provider requests, live prices or estimates.
const VERSION = "daily-indicators-v1";
const names = ["sma20", "sma50", "sma200", "return5d", "return20d", "return50d", "atr14", "range20Low", "range20High"];
const percentChange = (previous, current) => {
  const value = Number.isFinite(previous) && previous > 0 && Number.isFinite(current) ? (current / previous - 1) * 100 : NaN;
  return Number.isFinite(value) ? value : null;
};
const mean = values => values.reduce((total, value) => total + value / values.length, 0);

function calculateIndicators(candles) {
  const values = Object.fromEntries(names.map(name => [name, null]));
  let previous;
  if (!Array.isArray(candles) || candles.some(c => {
    const validDate = c && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && Number.isFinite(Date.parse(`${c.date}T00:00:00Z`))
      && new Date(`${c.date}T00:00:00Z`).toISOString().startsWith(c.date);
    const invalid = !validDate || (previous && c.date <= previous)
      || ![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0)
      || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close, c.low);
    previous = c?.date;
    return invalid;
  })) return { version: VERSION, status: "invalid", completed_sessions: 0, asof_session: null, values };
  const n = candles.length;
  const closes = candles.map(c => c.close);
  for (const period of [20, 50, 200]) if (n >= period) values[`sma${period}`] = mean(closes.slice(-period));
  for (const period of [5, 20, 50]) if (n >= period + 1) values[`return${period}d`] = percentChange(closes.at(-period - 1), closes.at(-1));
  if (n >= 15) {
    const ranges = candles.slice(-14).map((c, i) => {
      const previousClose = candles[n - 15 + i].close;
      return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
    });
    values.atr14 = mean(ranges);
  }
  if (n >= 20) {
    values.range20Low = Math.min(...candles.slice(-20).map(c => c.low));
    values.range20High = Math.max(...candles.slice(-20).map(c => c.high));
  }
  return { version: VERSION, status: n >= 51 ? "ok" : "limited", completed_sessions: n,
    asof_session: candles.at(-1)?.date || null, values };
}

module.exports = { VERSION, calculateIndicators, percentChange };
