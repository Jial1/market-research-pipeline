# Limitations

- The AI response is research commentary, not independently verified factual analysis. Structured validation checks application contracts, not the truth of every sentence.
- Data-provider coverage, delays, adjustments, entitlements and earnings uncertainty affect whether plans qualify. An empty earnings response does not establish an event-free window.
- Only completed daily bars support historical indicators and evaluation. Daily bars cannot establish intraday ordering, actual spread, liquidity or execution quality. The model flags ambiguity and makes conservative assumptions.
- Cost sensitivity uses assumed friction, not observed commissions or slippage. Option scenarios use approximate Greeks and are not option performance measurements.
- Saved stock plans are evaluated independently. Overlap, correlated exposures, capital constraints and portfolio position sizing are not modeled. Do not interpret isolated-plan metrics as account returns.
- Preparation-only strategies are never evaluated as tracked plans. Unsupported order types remain research-only. Missing paths remain unavailable instead of using current quotes.
- Terminal results are immutable per evaluation version. The persistence model retains latest results and date/version metric snapshots, not a full historical event log.
- Run locks prevent ordinary overlapping work. A crash between an external side effect and persistence still creates uncertainty. There is no end-to-end exactly-once guarantee.
- The public edition preserves one selected report configuration. It does not include Discord, experimental comparisons, private deployment/recovery tools, automated execution or a hosted user interface.
- The README preview and runnable demos use synthetic evidence. Local test passes and report parity do not prove model effectiveness, broad provider reliability, deployment or profitable trading.
