const { fetchOptionChain } = require("./optionsData");
const { addOptionMetrics } = require("./optionsMath");
const { getRejectionReasons } = require("./optionsFilters");
const { scoreOption } = require("./optionsScorer");

function optionTypeForDirection(direction) {
  return direction === "short" ? "put" : "call";
}

function strategyForType(optionType) {
  return optionType === "put" ? "long_put" : "long_call";
}

function buildSkipSupplement(stockSetup, reason) {
  const optionType = optionTypeForDirection(stockSetup.trade_direction);
  return {
    stock_report_id: null,
    symbol: stockSetup.symbol,
    linked_stock_direction: stockSetup.trade_direction,
    option_type: optionType,
    strategy: "skip_options",
    review_label: "skip",
    skip_reason: reason,
    option_reason: null
  };
}

function candidateSortValue(option, config) {
  const preferredDte = option.days_to_expiration >= config.preferredMinDte &&
    option.days_to_expiration <= config.preferredMaxDte;
  const dteBonus = preferredDte ? 8 : 0;
  const moneynessBonus = option.moneyness === "ATM" ? 8 : option.moneyness === "ITM" ? 4 : 0;
  return option.option_score + dteBonus + moneynessBonus;
}

function selectBestOption(stockSetup, contracts, config) {
  const optionType = optionTypeForDirection(stockSetup.trade_direction);
  const possible = contracts
    .filter(contract => contract.option_type === optionType)
    .map(contract => addOptionMetrics(contract, stockSetup));

  if (possible.length === 0) {
    return buildSkipSupplement(stockSetup, `No ${optionType} contracts available from option chain.`);
  }

  const rejected = [];
  const scored = [];
  for (const option of possible) {
    const reasons = getRejectionReasons(option, config);
    if (reasons.length > 0) {
      rejected.push(...reasons);
      continue;
    }

    scored.push(scoreOption(option, config));
  }

  if (scored.length === 0) {
    const commonReason = mostCommon(rejected) || "No contract passed liquidity and risk filters.";
    return buildSkipSupplement(stockSetup, commonReason);
  }

  scored.sort((a, b) => candidateSortValue(b, config) - candidateSortValue(a, config));
  const best = scored[0];
  const skipReason = best.review_label === "skip"
    ? best.expensive_reason || "Option score below threshold."
    : null;

  return {
    ...best,
    stock_report_id: null,
    linked_stock_direction: stockSetup.trade_direction,
    strategy: best.review_label === "skip" ? "skip_options" : strategyForType(optionType),
    skip_reason: skipReason,
    option_reason: buildOptionReason(best)
  };
}

function buildOptionReason(option) {
  if (option.review_label === "skip") {
    return option.expensive_reason || "Contract did not provide enough short-term payoff for the risk.";
  }

  const pieces = [];
  if (Number.isFinite(option.scenario_return_at_stock_target_5d)) {
    pieces.push(`target scenario ${option.scenario_return_at_stock_target_5d}%`);
  }
  if (Number.isFinite(option.bid_ask_spread_pct)) {
    pieces.push(`spread ${option.bid_ask_spread_pct}%`);
  }
  if (Number.isFinite(option.liquidity_score)) {
    pieces.push(`liquidity score ${option.liquidity_score}`);
  }

  return pieces.length > 0
    ? pieces.join(", ")
    : "Selected as the best available call/put expression for the stock setup.";
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

async function buildOptionsSupplements(stockSetups, quotes, config, optionChainSnapshots = [], { fetchChain = fetchOptionChain } = {}) {
  if (!Array.isArray(optionChainSnapshots)) throw new Error("Options evidence requires a snapshot array");
  if (!config.enabled || stockSetups.length === 0) return [];

  const supplements = [];
  for (const setup of stockSetups) {
    const quote = quotes.find(row => row.symbol === setup.symbol) || {};
    const stockSetup = {
      ...setup,
      current_price: setup.current_price || quote.price
    };

    try {
      const contracts = await fetchChain(stockSetup.symbol, stockSetup.current_price, {
        ...config,
        optionSide: optionTypeForDirection(stockSetup.trade_direction)
      });
      optionChainSnapshots.push({ symbol: stockSetup.symbol, contracts });
      supplements.push(selectBestOption(stockSetup, contracts, config));
    } catch (error) {
      supplements.push(buildSkipSupplement(stockSetup, `Option chain unavailable: ${error.message}`));
    }
  }

  return supplements;
}

module.exports = {
  buildOptionsSupplements,
  selectBestOption
};
