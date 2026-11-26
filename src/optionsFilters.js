function getRejectionReasons(option, optionsConfig) {
  const reasons = [];

  if (!option.expiration) reasons.push("missing expiration");
  if (!option.strike) reasons.push("missing strike");
  if (!option.mid || option.mid <= 0) reasons.push("missing usable mid price");
  if (![option.bid, option.ask].every(value => Number.isFinite(value) && value > 0)) {
    reasons.push("invalid bid/ask");
  } else if (option.ask < option.bid) {
    reasons.push("crossed bid/ask");
  }
  if (option.days_to_expiration === null || option.days_to_expiration === undefined) {
    reasons.push("missing days to expiration");
  } else {
    if (option.days_to_expiration < optionsConfig.minDte) reasons.push("DTE too short");
    if (option.days_to_expiration > optionsConfig.maxDte) reasons.push("DTE too long");
  }

  if (!Number.isFinite(option.bid_ask_spread_pct) || option.bid_ask_spread_pct < 0) {
    reasons.push("invalid bid/ask spread");
  } else if (option.bid_ask_spread_pct > optionsConfig.maxBidAskSpreadPct) {
    reasons.push("bid/ask spread too wide");
  }

  if ((option.open_interest ?? 0) < optionsConfig.minOpenInterest) {
    reasons.push("open interest too low");
  }

  if ((option.volume ?? 0) < optionsConfig.minVolume) {
    reasons.push("volume too low");
  }

  if (option.premium_cost !== null && option.premium_cost > optionsConfig.maxPremiumRisk) {
    reasons.push("premium risk too high");
  }

  return reasons;
}

module.exports = { getRejectionReasons };
