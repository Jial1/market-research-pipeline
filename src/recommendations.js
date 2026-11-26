const MIN_RISK_REWARD = 1.2;

// Domain qualification of validated candidate rows. No JSON/prose extraction.
function qualifyRecommendations(rows, quotes, { requireHistorical = false } = {}) {
  if (!Array.isArray(rows)) return [];
  quotes = quotes.filter(q => (!q.quality?.enforced || q.quality.actionable === true)
    && (!requireHistorical || q.historical?.eligible === true)
    && (!q.historical?.enforced || q.historical.eligible === true));
  return rejectDuplicateSymbols(rows).map(row => {
    if (!row || typeof row !== "object") return null;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : null;
    const quote = quotes.find(q => q.symbol === symbol);
    if (!quote) return null;
    const recommendation = { symbol, current_price: quote.price, entry_price: row.entry_price,
      trade_direction: typeof row.trade_direction === "string" ? row.trade_direction.trim().toLowerCase() : null,
      entry_prediction: row.entry_prediction || "unknown", target_price: row.target_price, stop_loss: row.stop_loss,
      ai_confidence: Number.isFinite(row.ai_confidence) ? Math.max(0, Math.min(1, row.ai_confidence)) : 0.5,
      structure: row.structure?.trim() || "unknown", momentum: row.momentum?.trim() || "",
      liquidity: row.liquidity?.trim() || "", catalyst: row.catalyst?.trim() || "", reason: row.reason?.trim() || "",
      risk: row.risk?.trim() || "", market_regime: row.market_regime?.trim() || "", catalyst_type: row.catalyst_type?.trim() || "",
      setup_score: row.setup_score, risk_reward: null };
    enrichTradeMetrics(recommendation);
    return isExecutableRecommendation(recommendation) ? recommendation : null;
  }).filter(Boolean);
}

function rejectDuplicateSymbols(rows) {
  const counts = new Map();
  const symbolFor = row => typeof row?.symbol === "string" ? row.symbol.trim().toUpperCase() : null;
  for (const row of rows) {
    const symbol = symbolFor(row);
    if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  return rows.filter(row => counts.get(symbolFor(row)) === 1);
}


function enrichTradeMetrics(recommendation) {
  recommendation.risk_reward = calculateRiskReward(recommendation);
  recommendation.setup_score = calculateSetupScore(recommendation);
  recommendation.setup_quality = recommendation.setup_quality || gradeSetup(recommendation.setup_score);
}


function isExecutableRecommendation(recommendation) {
  if (![recommendation.entry_price, recommendation.target_price, recommendation.stop_loss]
    .every(value => isFiniteNumber(value) && value > 0)
    || !["long", "short"].includes(recommendation.trade_direction)) {
    return false;
  }

  if (!isValidTradeGeometry(recommendation)) {
    console.warn(`Skipping ${recommendation.symbol}: invalid ${recommendation.trade_direction} price geometry.`);
    return false;
  }

  if (!isFiniteNumber(recommendation.risk_reward) || recommendation.risk_reward < MIN_RISK_REWARD) {
    console.warn(
      `Skipping ${recommendation.symbol}: risk/reward ${recommendation.risk_reward ?? "N/A"} below ${MIN_RISK_REWARD}.`
    );
    return false;
  }

  return true;
}


function isValidTradeGeometry({ trade_direction, entry_price, target_price, stop_loss }) {
  if (trade_direction === "short") {
    return target_price < entry_price && stop_loss > entry_price;
  }

  return target_price > entry_price && stop_loss < entry_price;
}


function calculateRiskReward({ trade_direction, entry_price, target_price, stop_loss }) {
  if (!isFiniteNumber(entry_price) || !isFiniteNumber(target_price) || !isFiniteNumber(stop_loss)) {
    return null;
  }

  const reward = trade_direction === "short"
    ? entry_price - target_price
    : target_price - entry_price;
  const risk = trade_direction === "short"
    ? stop_loss - entry_price
    : entry_price - stop_loss;

  if (reward <= 0 || risk <= 0) return null;
  return round(reward / risk, 2);
}


function calculateSetupScore(recommendation) {
  if (isFiniteNumber(recommendation.setup_score)) {
    return Math.max(0, Math.min(100, Math.round(recommendation.setup_score)));
  }

  const rrScore = Math.min(recommendation.risk_reward || 0, 3) / 3 * 35;
  const confidenceScore = (recommendation.ai_confidence || 0.5) * 35;
  const typeScore = ["breakout", "pullback"].includes(recommendation.entry_prediction) ? 15 : 8;
  const reasonScore = recommendation.reason ? 8 : 0;
  const riskScore = recommendation.risk ? 7 : 0;

  return Math.max(0, Math.min(100, Math.round(rrScore + confidenceScore + typeScore + reasonScore + riskScore)));
}


function gradeSetup(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}


function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}


function round(value, decimals = 2) {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}


module.exports = { qualifyRecommendations };
