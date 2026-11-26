const policy = require("../config/evaluation-policy.json");

function applyEvaluationPolicy(plans) {
  const recommendations = [], exclusions = [];
  for (const plan of plans) {
    const order = policy.orders[`${plan.trade_direction}:${plan.entry_prediction}`];
    if (!order) exclusions.push({ symbol: plan.symbol, reason: "unsupported_entry_type" });
    else recommendations.push({ ...plan, order_type: order, evaluation_policy: policy });
  }
  return { recommendations, exclusions };
}

module.exports = { policy, applyEvaluationPolicy };
