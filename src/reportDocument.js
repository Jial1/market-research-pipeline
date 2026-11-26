const { sessionDate } = require("./data/marketCalendar");
const { stockAnalysis } = require("./modelAnalysis");

const REPORT_DOCUMENT_VERSION = "report-document-v1";
const PREPARATION_ERRORS = new Set(["output_error", "decision_missing", "rejected"]);

// Application-owned rendering contract. Inputs are the final qualified pipeline
// results, never recommendation candidates extracted here from model text.
// stocks are in display order; tracked_plans retain the original persistence order.
function buildReportDocument({ analysis = null, quotes, recommendations = [], optionsSupplements = [], dataQuality,
  evaluationPolicy = null, exclusions = [], marketContext = null, preparation = null, issuedAt = null }) {
  if (!Array.isArray(quotes) || !dataQuality || !Array.isArray(dataQuality.symbols)) {
    throw new Error("ReportDocumentV1 requires qualified quotes and data quality");
  }
  const approved = recommendations.filter(p => quotes.some(q => q.symbol === p.symbol && q.quality?.actionable === true));
  const ranked = [...approved].sort((a, b) => (Number(b.setup_score) || 0) - (Number(a.setup_score) || 0));
  const accepted = new Set(approved.map(p => p.symbol));
  const orderedQuotes = [...ranked.map(p => quotes.find(q => q.symbol === p.symbol)), ...quotes.filter(q => !accepted.has(q.symbol))];
  const enabled = Boolean(preparation?.context?.enabled);
  const stocks = orderedQuotes.map(quote => {
    const symbol = quote.symbol;
    const plan = approved.find(p => p.symbol === symbol) || null;
    const strategy = preparation?.strategies.find(p => p.symbol === symbol) || null;
    const outcome = enabled ? preparation.outcomes?.[symbol] : null;
    const exclusion = exclusions.find(e => e.symbol === symbol || e.symbol === "all");
    const earnings = (enabled ? preparation.context.symbols[symbol]?.earnings : marketContext?.earnings[symbol]) || null;
    const conflict = earnings?.state === "reported_conflict";
    const outputProblem = PREPARATION_ERRORS.has(outcome?.state);
    const qualityReasons = (quote.quality?.reasons || []).filter(r => r !== "market_closed");
    const reasons = [...new Set([...(quote.quality?.reasons || []), ...(exclusion ? [exclusion.reason] : [])])];
    const note = conflict ? "Earnings date conflict" : exclusion ? readableReason(exclusion.reason)
      : qualityReasons.length ? qualityReasons.map(readableReason).join("; ")
      : plan?.reason || strategy?.thesis || preparationMessage(symbol, preparation) || "No validated approved plan was generated";
    const status = plan ? "approved" : strategy ? "preparation" : conflict ? "event_risk"
      : outputProblem ? "preparation_error" : outcome?.state === "watch_only" ? "watch_only" : "research_only";
    const preparationReason = preparation?.exclusions.find(e => e.symbol === symbol)?.reason || preparation?.context?.symbols[symbol]?.reason;
    return { symbol, quote: { symbol, price: quote.price, changePercent: quote.changePercent, source: quote.source,
        provider_at: quote.provider_at, fetched_at: quote.fetched_at, quality: quote.quality }, measured_evidence: quote.historical || null,
      analysis: plan ? { state: "supplied", fields: { Structure: plan.structure, Momentum: plan.momentum, Catalysts: plan.catalyst, Risk: plan.risk } }
        : stockAnalysis(analysis, symbol),
      decision: { status, reasons: [...new Set([...reasons,
        ...exclusions.filter(e => e.symbol === symbol || e.symbol === "all").map(e => e.reason),
        ...(conflict ? ["reported_earnings_conflict"] : []), ...(outputProblem && outcome.reason ? [outcome.reason] : [])])],
        note, conflict, output_problem: outputProblem,
        research_reasons: reasons.filter(r => r !== "market_closed" && !(r === "reported_earnings_conflict" && conflict)).map(readableReason) },
      plan, earnings,
      preparation: { enabled, strategy, outcome: outcome || null, message: preparationMessage(symbol, preparation),
        suppress_notice: preparationReason === "reported_earnings_conflict" },
      options_supplement: plan ? optionsSupplements.find(s => s.symbol === symbol && (!s.linked_stock_direction || s.linked_stock_direction === plan.trade_direction)) || null : null };
  });
  const checked = Date.parse(dataQuality.checked_at);
  const dates = values => [...new Set(values.filter(Boolean))].sort();
  const document = {
    schema_version: REPORT_DOCUMENT_VERSION,
    issued_at: issuedAt,
    header: { date: Number.isFinite(checked) ? sessionDate(checked) : null, session_state: dataQuality.session_state },
    market: { summary: analysis?.market_summary.trim() || "No summary available", context: marketContext },
    stocks, tracked_plans: approved, evaluation_policy: evaluationPolicy, exclusions,
    preparation: { enabled, strategy_count: preparation?.strategies.length || 0,
      issue_count: Object.values(preparation?.outcomes || {}).filter(o => PREPARATION_ERRORS.has(o.state)).length,
      output_status: preparation?.output_status || null },
    footer: { quote_dates: dates(quotes.map(q => Number.isFinite(Date.parse(q.provider_at)) ? sessionDate(Date.parse(q.provider_at)) : null)),
      history_dates: dates(quotes.map(q => q.historical?.asof_session)),
      sources: [...new Set([...quotes.map(q => q.source), ...quotes.map(q => q.historical?.source), ...dataQuality.symbols.map(q => q.source)].filter(Boolean))],
      session_state: dataQuality.session_state, preparation_enabled: enabled,
      preparation_session: preparation?.context?.window?.from || null, eligible_session: dataQuality.eligible_session || null }
  };
  // Detach the document from mutable provider/pipeline objects; saved JSON can be
  // passed straight to the renderer without its original model response.
  return assertReportDocument(JSON.parse(JSON.stringify(document)));
}

function assertReportDocument(document) {
  if (document?.schema_version !== REPORT_DOCUMENT_VERSION || !Array.isArray(document.stocks)
    || !Array.isArray(document.tracked_plans) || !document.header || !document.market || !document.footer || !document.preparation) {
    throw new Error("Expected ReportDocumentV1");
  }
  const symbols = new Set();
  const statuses = new Set(["approved", "preparation", "event_risk", "preparation_error", "watch_only", "research_only"]);
  for (const stock of document.stocks) {
    if (!stock.symbol || symbols.has(stock.symbol) || !stock.quote || !stock.analysis || !stock.preparation
      || !statuses.has(stock.decision?.status) || (stock.decision.status === "approved") !== Boolean(stock.plan)) {
      throw new Error("Invalid ReportDocumentV1 stock");
    }
    symbols.add(stock.symbol);
  }
  return document;
}

function readableReason(reason) {
  return { market_closed: "Market closed, research only", reported_earnings_conflict: "Earnings date falls within the trading window",
    earnings_window_unknown: "Insufficient trading calendar coverage, cannot verify the full trading window",
    insufficient_history_51: "Fewer than 51 sessions", stale_quote: "Quote is stale", stale_last_session_quote: "No valid closing quote from the latest session",
    unsupported_entry_type: "Entry type did not pass validation", issuance_calendar_unavailable: "Entry session cannot be confirmed",
    preparation_calendar_unavailable: "Insufficient calendar coverage for preparation", preparation_data_unqualified: "Insufficient data for a numerical preparation strategy",
    preparation_earnings_unavailable: "Earnings verification is incomplete for the preparation window, numerical strategies are withheld",
    invalid_preparation_strategy: "The model preparation strategy failed numerical or evidence-date validation",
    empty_preparation_decisions: "The model returned an empty result, no preparation decision was provided for this symbol",
    missing_preparation_decision: "The model omitted a preparation decision for this symbol",
    duplicate_preparation_decision: "The model returned duplicate preparation decisions, cannot determine the result for this symbol",
    invalid_watch_only_decision: "The watch-only decision lacks a valid reason or contains trade fields",
    invalid_preparation_decision: "Invalid model preparation decision format, cannot display",
    invalid_model_json: "Invalid model JSON; numerical plans are withheld",
    invalid_model_schema: "Invalid model response fields; numerical plans are withheld",
    invalid_model_symbols: "Duplicate or unrecognized model symbols; numerical plans are withheld",
    missing_stock_analysis: "The model omitted stock analysis; numerical plans are withheld",
    model_generation_incomplete: "Model generation did not finish normally, numerical plans are withheld" }[reason] || "Data or plan failed validation";
}


function preparationMessage(symbol, preparation) {
  if (!preparation?.context?.enabled) return "";
  const outcome = preparation.outcomes?.[symbol];
  if (outcome?.state === "watch_only") return `Model selected watch only: ${outcome.reason}`;
  if (outcome && outcome.state !== "preparation") return readableReason(outcome.reason);
  const reason = preparation.exclusions.find(e => e.symbol === symbol || e.symbol === "all")?.reason
    || preparation.context.symbols[symbol]?.reason;
  return reason ? readableReason(reason) : "No preparation decision was recorded for this symbol";
}


module.exports = { REPORT_DOCUMENT_VERSION, buildReportDocument, assertReportDocument };
