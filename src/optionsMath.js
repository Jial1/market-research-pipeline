function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function daysToExpiration(expiration, now = new Date()) {
  const expirationDate = new Date(`${expiration}T21:00:00Z`);
  if (Number.isNaN(expirationDate.getTime())) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((expirationDate - now) / msPerDay);
}

function calculateMid(bid, ask, last = null) {
  const normalizedBid = toNumber(bid);
  const normalizedAsk = toNumber(ask);
  const normalizedLast = toNumber(last);

  if (normalizedBid !== null && normalizedAsk !== null) {
    if (normalizedBid <= 0 || normalizedAsk <= 0 || normalizedAsk < normalizedBid) return null;
    return round((normalizedBid + normalizedAsk) / 2, 2);
  }

  if (normalizedLast !== null && normalizedLast > 0) {
    return round(normalizedLast, 2);
  }

  return null;
}

function bidAskSpreadPct(bid, ask, mid) {
  const normalizedBid = toNumber(bid);
  const normalizedAsk = toNumber(ask);
  const normalizedMid = toNumber(mid);
  if (![normalizedBid, normalizedAsk, normalizedMid].every(value => Number.isFinite(value) && value > 0)
    || normalizedAsk < normalizedBid) return null;
  return round((normalizedAsk - normalizedBid) / normalizedMid * 100, 2);
}

function moneyness(optionType, strike, underlyingPrice) {
  if (!Number.isFinite(strike) || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    return "unknown";
  }

  const distancePct = Math.abs(strike - underlyingPrice) / underlyingPrice * 100;
  if (distancePct <= 2) return "ATM";

  if (optionType === "put") {
    return strike > underlyingPrice ? "ITM" : "OTM";
  }

  return strike < underlyingPrice ? "ITM" : "OTM";
}

function expirationBreakeven(optionType, strike, mid) {
  if (!Number.isFinite(strike) || !Number.isFinite(mid)) return null;
  return optionType === "put"
    ? round(strike - mid, 2)
    : round(strike + mid, 2);
}

function distanceToBreakevenPct(optionType, breakeven, underlyingPrice) {
  if (!Number.isFinite(breakeven) || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    return null;
  }

  const distance = optionType === "put"
    ? underlyingPrice - breakeven
    : breakeven - underlyingPrice;
  return round(distance / underlyingPrice * 100, 2);
}

function fallbackDelta(optionType, strike, underlyingPrice) {
  if (!Number.isFinite(strike) || !Number.isFinite(underlyingPrice)) {
    return optionType === "put" ? -0.5 : 0.5;
  }

  const money = moneyness(optionType, strike, underlyingPrice);
  if (optionType === "put") {
    if (money === "ITM") return -0.65;
    if (money === "OTM") return -0.35;
    return -0.5;
  }

  if (money === "ITM") return 0.65;
  if (money === "OTM") return 0.35;
  return 0.5;
}

function estimateFutureOptionPrice(option, futureUnderlyingPrice, daysPassed, ivChange = 0) {
  const mid = toNumber(option.mid);
  const underlyingPrice = toNumber(option.underlying_price);
  if (!mid || !underlyingPrice || !Number.isFinite(futureUnderlyingPrice)) return null;

  const stockMove = futureUnderlyingPrice - underlyingPrice;
  const delta = toNumber(option.delta) ?? fallbackDelta(option.option_type, option.strike, underlyingPrice);
  const gamma = toNumber(option.gamma) ?? 0;
  const theta = toNumber(option.theta) ?? 0;
  const vega = toNumber(option.vega) ?? 0;
  const estimated = mid
    + delta * stockMove
    + 0.5 * gamma * stockMove * stockMove
    + theta * daysPassed
    + vega * ivChange;

  return round(Math.max(0.01, estimated), 2);
}

function estimateScenarioReturn(option, futureUnderlyingPrice, daysPassed, ivChange = 0) {
  const mid = toNumber(option.mid);
  const futurePrice = estimateFutureOptionPrice(option, futureUnderlyingPrice, daysPassed, ivChange);
  if (!mid || !futurePrice) return null;
  return round((futurePrice - mid) / mid * 100, 2);
}

function addOptionMetrics(option, stockSetup) {
  const mid = calculateMid(option.bid, option.ask, option.last);
  const bidAskPct = bidAskSpreadPct(option.bid, option.ask, mid);
  const underlyingPrice = toNumber(option.underlying_price ?? stockSetup.current_price);
  const strike = toNumber(option.strike);
  const optionType = option.option_type;
  const breakeven = expirationBreakeven(optionType, strike, mid);
  const targetPrice = toNumber(stockSetup.target_price);
  const stopPrice = toNumber(stockSetup.stop_loss);

  const enriched = {
    ...option,
    strike,
    underlying_price: underlyingPrice,
    mid,
    bid_ask_spread_pct: bidAskPct,
    premium_cost: mid ? round(mid * 100, 2) : null,
    expiration_breakeven: breakeven,
    distance_to_breakeven_pct: distanceToBreakevenPct(optionType, breakeven, underlyingPrice),
    moneyness: moneyness(optionType, strike, underlyingPrice)
  };

  enriched.scenario_return_1d_underlying_1pct = estimateScenarioReturn(
    enriched,
    optionType === "put" ? underlyingPrice * 0.99 : underlyingPrice * 1.01,
    1
  );
  enriched.scenario_return_3d_underlying_2pct = estimateScenarioReturn(
    enriched,
    optionType === "put" ? underlyingPrice * 0.98 : underlyingPrice * 1.02,
    3
  );
  enriched.scenario_return_at_stock_target_5d = estimateScenarioReturn(enriched, targetPrice, 5);
  enriched.scenario_return_at_stock_stop_3d = estimateScenarioReturn(enriched, stopPrice, 3);

  const theta = toNumber(enriched.theta);
  enriched.theta_cost_1d_pct_of_premium = theta && mid
    ? round(Math.abs(theta) / mid * 100, 2)
    : null;

  return enriched;
}

module.exports = {
  addOptionMetrics,
  bidAskSpreadPct,
  calculateMid,
  daysToExpiration,
  estimateScenarioReturn,
  expirationBreakeven,
  round,
  toNumber
};
