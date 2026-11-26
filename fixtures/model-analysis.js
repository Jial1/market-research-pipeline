// Synthetic ModelAnalysisV1 responses. No legacy text conversion is used.
function modelAnalysis(symbols, recommendations = [], preparation = [], market_summary = "Daily Summary:\n- Synthetic report, test only.") {
  return { schema_version: "model-analysis-v1", market_summary,
    stocks: symbols.map(symbol => ({ symbol, structure: "", momentum: "", catalyst: "", risk: "" })),
    recommendations: recommendations.map(row => ({ ai_confidence: null, setup_score: null, structure: "", momentum: "", catalyst: "",
      risk: "", liquidity: "", reason: "", market_regime: "", catalyst_type: "", ...row })), preparation };
}
function amendReport(report, mutate) {
  const analysis = JSON.parse(report);
  mutate(analysis);
  return JSON.stringify(analysis);
}
module.exports = { modelAnalysis, amendReport };
