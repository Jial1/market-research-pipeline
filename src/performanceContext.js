function asPercent(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return "N/A";
  return `${(number * 100).toFixed(1)}%`;
}

function asReturn(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return "N/A";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatRecommendationFeedback(context) {
  if (context?.evaluation_version) {
    return [
      `Corrected hypothetical stock outcomes (${context.evaluation_version}; last ${context.days} issuance days).`,
      `Plans evaluated: ${context.total_plans}; filled and closed: ${context.filled_closed}; pending: ${context.pending}; unavailable: ${context.unavailable}; unfilled terminal: ${context.unfilled_terminal}.`,
      `Net win rate among filled closed trades: ${asPercent(context.net_win_rate)}; average net return: ${asReturn(context.avg_net_return_pct)}; ambiguous plans: ${context.ambiguous_count}.`,
      "Legacy scores excluded. Returns include the policy's assumed friction; unfilled and pending plans have no scored trade return. Small and correlated samples do not prove trading benefit."
    ].join("\n");
  }
  return "";
}
module.exports = { formatRecommendationFeedback };
