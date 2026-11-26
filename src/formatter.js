const { assertReportDocument } = require("./reportDocument");

// Render an application-owned document. Qualification, ranking and model text
// adaptation happen before this boundary.
function formatDashboard(document) {
  assertReportDocument(document);
  const { stocks, header, market, footer, preparation } = document;
  const approved = stocks.filter(s => s.decision.status === "approved");
  const regime = { uptrend: "Uptrend", downtrend: "Downtrend", mixed: "Range-bound / mixed trend", unknown: "Unknown" };
  const { context: marketContext, summary } = market;
  const date = header.date || "date unconfirmed";
  const preparationIssues = preparation.issue_count;
  return `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:600px){#report-watchlist th:first-child{width:22%}#report-watchlist th:nth-child(2){width:33%}}</style></head><body style="font-family:Arial,sans-serif;background:#0f172a;color:#e5e7eb;padding:20px;line-height:1.65;font-size:14px;overflow-wrap:anywhere;">
    <header style="margin-bottom:20px;"><h2 style="color:#22c55e;margin-bottom:4px;">Daily Market Research</h2>
      <div style="color:#94a3b8;">${escapeHtml(date)} · ${header.session_state === "open" ? "Market-hours research" : header.session_state === "closed" ? "Next-opening preparation" : "Research watchlist"}</div></header>
    <div style="background:#1e293b;padding:16px;border-radius:10px;">
      <h3 style="color:#38bdf8;margin-top:0;">Market analysis · AI commentary</h3><div style="white-space:pre-wrap;">${escapeHtml(summary)}</div>
      ${marketContext ? `<div style="border-top:1px solid #334155;margin-top:12px;padding-top:10px;">SPY market context: ${escapeHtml(regime[marketContext.regime.state] || regime.unknown)} (context only, no automatic direction restriction)</div>` : ""}
    </div>
    <h3 style="margin-top:24px;">Watchlist</h3>
    <p style="color:#94a3b8;font-size:12px;">Approved plans: ${approved.length}${preparation.enabled ? ` | Conditional preparation: ${preparation.strategy_count}(revalidation required)` : ""}${approved.length > 1 ? "; Approved plans are ordered by model score, scores are not win probabilities" : ""}</p>
    ${preparationIssues ? `<p style="color:#facc15;">Preparation results need review: ${preparationIssues} stocks lack a valid decision or failed strategy validation.</p>` : ""}
    <table id="report-watchlist" width="100%" cellpadding="7" style="border-collapse:collapse;text-align:left;table-layout:fixed;">
      <tr style="color:#94a3b8;"><th width="24%">Stock / Quote</th><th width="23%">Status</th><th>Reason to watch</th></tr>
      ${stocks.map(watchlistRow).join("")}</table>
    <h3 style="margin-top:24px;">Stock analysis</h3>
    ${approved.map(stock => approvedStockCard(stock, footer.eligible_session)).join("")}
    ${stocks.filter(s => s.decision.status !== "approved").map(researchCard).join("")}
    ${dataFooter(footer)}
    </body></html>`;
}

function watchlistRow(stock) {
  const q = stock.quote, { status, note, conflict, output_problem: outputProblem } = stock.decision;
  return `<tr style="border-top:1px solid #334155;"><td><b>${escapeHtml(q.symbol)}</b><div style="font-size:12px;color:#94a3b8;">${Number.isFinite(q.price) ? `$${q.price.toFixed(2)}` : "Quote unavailable"}${Number.isFinite(q.changePercent) ? ` / ${q.changePercent.toFixed(2)}%` : ""}</div></td><td style="color: ${conflict ? "#f87171" : status === "preparation" || outputProblem ? "#facc15" : status === "approved" ? "#22c55e" : "#cbd5e1"};">${status === "approved" ? "Approved plan" : status === "preparation" ? "Conditional preparation · revalidation required" : status === "event_risk" ? "Event risk" : status === "preparation_error" ? "Preparation output issue" : status === "watch_only" ? "Watch only(model decision)" : "Research only / Watch"}</td><td>${escapeHtml(note)}</td></tr>`;
}

function earningsNote(risk) {
  if (!risk) return "";
  const events = risk.reported_events || risk.conflicts || [];
  const timing = { before_open: "before open", after_close: "after close", during_session: "during session", unknown: "time unknown" };
  const certainty = { confirmed: "confirmed", estimated: "estimated date", reported_unconfirmed: "date unconfirmed" };
  const conflict = risk.state === "reported_conflict";
  const dates = events.map(e => `${escapeHtml(e.date)} ${escapeHtml(timing[e.timing] || "time unknown")} (${escapeHtml(certainty[e.certainty] || "date unconfirmed")})`).join("; ");
  const unreliable = !["observed", "empty"].includes(risk.source_status)
    || (risk.reasons || []).some(r => r !== "no_reported_conflict_does_not_establish_event_free" && r !== "reported_earnings_in_full_trade_window");
  if (!dates && !unreliable) return "";
  return `<div style="margin:8px 0;color: ${conflict ? "#f87171" : "#facc15"};">
    ${dates ? `<b>${conflict ? "Earnings risk" : "Earnings date"}: </b>${dates}${conflict ? "<div>Within the planned trading window, no approved plan is provided.</div>" : ""}` : ""}
    ${unreliable ? "<div>Earnings verification is incomplete or unavailable, verify manually.</div>" : ""}</div>`;
}

function measuredEvidence(h) {
  const v = h?.values;
  if (!v) return "";
  const n = (value, suffix = "") => Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "Unavailable";
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #334155;color:#94a3b8;font-size:12px;line-height:1.7;">
    <b>Measured evidence</b> (completed daily bars through ${escapeHtml(h.asof_session || "unknown")})
    <div>SMA20 / SMA50: ${n(v.sma20)} / ${n(v.sma50)} | 20-session return: ${n(v.return20d, "%")}</div>
    <div>ATR14: ${n(v.atr14)} | Last 20-session price range: ${n(v.range20Low)} – ${n(v.range20High)}</div></div>`;
}

function stockAnalysis(analysis) {
  if (analysis.state === "missing") return `<div style="color:#94a3b8;margin-top:10px;">No stock analysis was supplied by the model; Measured evidence is retained below.</div>`;
  if (analysis.state === "withheld") return `<div style="color:#94a3b8;margin-top:10px;">No displayable stock analysis was supplied by the model; Measured evidence is retained below.</div>`;
  return `<div style="margin-top:10px;line-height:1.7;"><b>Stock analysis · AI commentary</b>${analysisFields(analysis.fields)}</div>`;
}

function analysisFields(fields) {
  return ["Structure", "Momentum", "Catalysts", "Risk"].map(label =>
    `<div style="color: ${label === "Risk" ? "#f87171" : "#cbd5e1"};"><b>${label}: </b>${escapeHtml(fields[label] || "Not supplied by the model")}</div>`).join("");
}

function preparationCard(preparation) {
  if (!preparation.enabled) return "";
  const strategy = preparation.strategy;
  if (!strategy) {
    if (preparation.suppress_notice) return "";
    return `<div style="color:#94a3b8;margin-top:10px;">${escapeHtml(preparation.message)}</div>`;
  }
  return `<div style="border-left:3px solid #facc15;padding:0 0 0 12px;margin-top:12px;">
    <b style="color:#facc15;">Conditional strategy · Preparation reference (not an approved plan)</b>
    <div>Reference session: ${escapeHtml(strategy.session)} | ${strategy.trade_direction === "long" ? "Bullish scenario" : "Bearish scenario"} | R/R ${strategy.risk_reward.toFixed(2)}</div>
    <div>Basis: ${escapeHtml(strategy.thesis)} (history through ${escapeHtml(strategy.evidence_asof)})</div>
    <div>Confirmation condition: ${escapeHtml(strategy.trigger)}</div>
    <div>Conditional entry: ${strategy.entry_price} | Target: ${strategy.target_price} | Stop: ${strategy.stop_loss}</div>
    <div>Abandon condition: ${escapeHtml(strategy.invalidation)}</div><div style="color:#f87171;">Risk: ${escapeHtml(strategy.risk)}</div>
    <div style="color:#facc15;">Revalidate quotes, events and conditions after the open. Preparation is not automatically promoted to an approved plan and is excluded from trade evaluation.</div></div>`;
}

function researchCard(stock) {
  const { quote, earnings: risk, analysis, preparation } = stock;
  const reasons = stock.decision.research_reasons;
  return `<article data-report-symbol="${escapeHtml(quote.symbol)}" style="background:#1e293b;padding:16px;border-radius:9px;margin:12px 0;">
    ${tickerHeader(quote.symbol, quote)}
    <div style="color:#facc15;"><b>Research only / Watch</b>${reasons.length ? ` · ${escapeHtml(reasons.join("; "))}` : ""}</div>
    ${earningsNote(risk)}
    ${stockAnalysis(analysis)}
    ${measuredEvidence(stock.measured_evidence)}
    ${preparationCard(preparation)}
    </article>`;
}

function approvedStockCard(stock, eligibleSession) {
  const { plan, quote, earnings: risk } = stock;
  const order = { buy_stop: "Buy stop", buy_limit: "Buy limit", sell_stop: "Sell stop", sell_limit: "Sell limit" }[plan.order_type];
  return `<article data-report-symbol="${escapeHtml(plan.symbol)}" style="background:#1e293b;padding:16px;border-radius:9px;margin:12px 0;">
    ${tickerHeader(plan.symbol, quote)}
    <div style="color:#22c55e;">Approved plan · ${plan.trade_direction === "short" ? "Short" : "Long"} · ${escapeHtml(plan.setup_quality)} / ${escapeHtml(plan.setup_score)}</div>
    ${earningsNote(risk)}
    <div style="margin-top:10px;"><b>Stock analysis · AI commentary</b>
      ${analysisFields(stock.analysis.fields)}</div>
    ${measuredEvidence(stock.measured_evidence)}
    <div style="border-left:3px solid #22c55e;padding-left:12px;margin-top:12px;">
      <b style="color:#22c55e;">Approved plan</b> · R/R ${escapeHtml(plan.risk_reward)}
      <div>Entry date: ${escapeHtml(eligibleSession || "unconfirmed")}${order ? ` | ${escapeHtml(order)}` : ""}</div>
      ${plan.reason ? `<div>Plan rationale: ${escapeHtml(plan.reason)}</div>` : ""}
      <div>Entry: ${escapeHtml(plan.entry_price)} | Target: ${escapeHtml(plan.target_price)} | Stop: ${escapeHtml(plan.stop_loss)}</div>
    </div>
    ${optionSupplementCard(stock.options_supplement)}</article>`;
}

function dataFooter(footer) {
  const quoteDates = footer.quote_dates.join(", ") || "unknown";
  const historyDates = footer.history_dates.join(", ") || "unknown";
  const sources = footer.sources.join(" / ") || "unspecified";
  const state = { open: "Regular market session", closed: "Market closed", unknown: "Market status unconfirmed" }[footer.session_state] || "Market status unconfirmed";
  return `<footer id="report-data-notes" style="border-top:1px solid #334155;padding-top:12px;margin-top:24px;color:#94a3b8;font-size:12px;">
    <div>Quote dates: ${escapeHtml(quoteDates)} | Daily bars through: ${escapeHtml(historyDates)} | Sources: ${escapeHtml(sources)}</div>
    <div>${state}${footer.preparation_enabled ? ` | Preparation reference: ${escapeHtml(footer.preparation_session || "unconfirmed")}` : ""} | Tracked plan entry: ${escapeHtml(footer.eligible_session || "unconfirmed")}</div>
    <div>Event coverage may be incomplete. No displayed date does not establish an earnings-free trading window. Full timestamps, indicators and evaluation rules remain in saved run records.</div></footer>`;
}

function optionSupplementCard(option) {
  if (!option) return "";

  if (option.strategy === "skip_options" || option.review_label === "skip") {
    return `
      <div style="margin-top:12px; padding:12px; border:1px solid #475569; border-radius:8px; background:#0f172a;">
        <div style="color:#facc15; font-weight:bold; margin-bottom:6px;">Options Supplement</div>
        <div style="color:#f87171;">Skip options: ${escapeHtml(option.skip_reason || option.expensive_reason || "No attractive call/put candidate.")}</div>
      </div>
    `;
  }

  const labelColor = option.review_label === "candidate" ? "#22c55e" : "#facc15";

  return `
    <div style="margin-top:12px; padding:12px; border:1px solid #475569; border-radius:8px; background:#0f172a;">
      <div style="color:#facc15; font-weight:bold; margin-bottom:6px;">Options Supplement: ${escapeHtml(String(option.option_type || "").toUpperCase())}</div>
      <div style="color:#e5e7eb; font-weight:bold;">${escapeHtml(formatOptionContract(option))}</div>
      <div style="color:#94a3b8; margin-top:6px;">
        Mid ${formatMoney(option.mid)} | Premium Risk ${formatMoney(option.premium_cost)} | Exp. BE ${formatPrice(option.expiration_breakeven)}
      </div>
      <div style="color:#94a3b8;">
        Spread ${formatPct(option.bid_ask_spread_pct)} | OI ${formatNumber(option.open_interest)} | Vol ${formatNumber(option.volume)} | DTE ${escapeHtml(option.days_to_expiration ?? "N/A")}
      </div>
      <div style="color:#38bdf8; margin-top:8px;">Short-term scenarios</div>
      <div style="color:#94a3b8;">1d direction +1%: ${formatSignedPct(option.scenario_return_1d_underlying_1pct)}</div>
      <div style="color:#94a3b8;">3d direction +2%: ${formatSignedPct(option.scenario_return_3d_underlying_2pct)}</div>
      <div style="color:#22c55e;">Target in 5d: ${formatSignedPct(option.scenario_return_at_stock_target_5d)}</div>
      <div style="color:#f87171;">Stop in 3d: ${formatSignedPct(option.scenario_return_at_stock_stop_3d)}</div>
      <div style="color:#94a3b8; margin-top:8px;">
        Scores: option ${formatNumber(option.option_score)} | liquidity ${formatNumber(option.liquidity_score)} | pricing ${formatNumber(option.pricing_score)} | scenario ${formatNumber(option.scenario_score)}
      </div>
      <div style="color: ${labelColor}; font-weight:bold;">Review: ${escapeHtml(option.review_label || "watch")}</div>
      ${option.option_reason ? `<div style="color:#64748b; font-size:12px; margin-top:4px;">${escapeHtml(option.option_reason)}</div>` : ""}
      ${option.expensive_reason ? `<div style="color:#f87171; font-size:12px; margin-top:4px;">Cost warning: ${escapeHtml(option.expensive_reason)}</div>` : ""}
    </div>
  `;
}

function formatOptionContract(option) {
  const type = option.option_type === "put" ? "P" : "C";
  return `Buy ${option.symbol} ${formatPrice(option.strike)}${type} exp ${option.expiration}`;
}

function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : "N/A";
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "N/A";
}

function formatPct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "N/A";
}

function formatSignedPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "N/A";
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "N/A";
}

function tickerHeader(symbol, quote) {
  const change = quote.changePercent || 0;
  const price = quote.price || 0;
  const color = change > 0 ? "#22c55e" : change < 0 ? "#ef4444" : "#94a3b8";

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px;">
      <div style="display:flex; align-items:baseline; gap:4px; flex-wrap:wrap;">
        <span style="font-size:18px; font-weight:bold; color:#38bdf8;">${escapeHtml(symbol)}</span>
        <span style="color:#e5e7eb; font-size:16px;">${Number.isFinite(quote.price) && quote.price > 0 ? `$${price.toFixed(2)}` : "Quote unavailable"}</span>
        <span style="color: ${color}; font-weight:bold;">${Number.isFinite(quote.changePercent) ? `${change.toFixed(2)}%` : "—"}</span>
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { formatDashboard };
