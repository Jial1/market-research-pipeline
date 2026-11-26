const { round } = require("./optionsMath");

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function scoreLiquidity(option, config) {
  const spreadScore = option.bid_ask_spread_pct === null
    ? 30
    : clamp(100 - option.bid_ask_spread_pct / config.maxBidAskSpreadPct * 70);
  const oiScore = clamp((option.open_interest || 0) / Math.max(config.minOpenInterest * 5, 1) * 100);
  const volumeScore = clamp((option.volume || 0) / Math.max(config.minVolume * 10, 1) * 100);

  return Math.round(spreadScore * 0.45 + oiScore * 0.35 + volumeScore * 0.20);
}

function scorePricing(option) {
  let score = 75;

  if (option.theta_cost_1d_pct_of_premium !== null) {
    score -= Math.max(0, option.theta_cost_1d_pct_of_premium - 3) * 5;
  }

  if (option.distance_to_breakeven_pct !== null) {
    score -= Math.max(0, option.distance_to_breakeven_pct - 5) * 4;
  }

  const iv = option.implied_volatility;
  if (Number.isFinite(iv) && iv > 0.8) score -= 12;
  if (Number.isFinite(iv) && iv < 0.25) score += 6;

  return Math.round(clamp(score));
}

function scoreScenario(option) {
  const targetReturn = option.scenario_return_at_stock_target_5d;
  const stopReturn = option.scenario_return_at_stock_stop_3d;

  let score = 50;
  if (Number.isFinite(targetReturn)) {
    score += Math.min(targetReturn, 80) * 0.55;
  }

  if (Number.isFinite(stopReturn)) {
    score -= Math.max(Math.abs(Math.min(stopReturn, 0)) - 35, 0) * 0.45;
  }

  if (Number.isFinite(targetReturn) && Number.isFinite(stopReturn) && stopReturn < 0) {
    const payoffRatio = targetReturn / Math.abs(stopReturn);
    score += Math.min(payoffRatio, 2) * 10;
  }

  return Math.round(clamp(score));
}

function reviewLabel(optionScore) {
  if (optionScore >= 75) return "candidate";
  if (optionScore >= 60) return "watch";
  return "skip";
}

function scoreOption(option, config) {
  const liquidityScore = scoreLiquidity(option, config);
  const pricingScore = scorePricing(option);
  const scenarioScore = scoreScenario(option);
  const optionScore = Math.round(
    liquidityScore * 0.30 +
    pricingScore * 0.30 +
    scenarioScore * 0.40
  );

  const expensiveReasons = [];
  if (option.distance_to_breakeven_pct !== null && option.distance_to_breakeven_pct > 7) {
    expensiveReasons.push("expiration breakeven is far from spot");
  }
  if (option.theta_cost_1d_pct_of_premium !== null && option.theta_cost_1d_pct_of_premium > 5) {
    expensiveReasons.push("theta cost is high");
  }
  if (Number.isFinite(option.implied_volatility) && option.implied_volatility > 0.8) {
    expensiveReasons.push("implied volatility is elevated");
  }
  if (Number.isFinite(option.scenario_return_at_stock_target_5d) && option.scenario_return_at_stock_target_5d < 20) {
    expensiveReasons.push("target scenario return is weak");
  }

  return {
    ...option,
    liquidity_score: liquidityScore,
    pricing_score: pricingScore,
    scenario_score: scenarioScore,
    option_score: optionScore,
    review_label: reviewLabel(optionScore),
    is_option_too_expensive: expensiveReasons.length > 0,
    expensive_reason: expensiveReasons.length > 0 ? expensiveReasons.join("; ") : null,
    target_reward_to_stop_loss_ratio: calculateScenarioRewardRisk(option)
  };
}

function calculateScenarioRewardRisk(option) {
  const targetReturn = option.scenario_return_at_stock_target_5d;
  const stopReturn = option.scenario_return_at_stock_stop_3d;
  if (!Number.isFinite(targetReturn) || !Number.isFinite(stopReturn) || stopReturn >= 0) return null;
  return round(targetReturn / Math.abs(stopReturn), 2);
}

module.exports = { scoreOption };
