# Engineering decisions and interview walkthrough

## One complete product loop

The system produces a report, saves qualified recommendations and checks their later outcomes. This makes it possible to discuss correctness beyond generating convincing text. Options remain a supporting report feature; stock evaluation is its own explicitly bounded model.

## Treat model output as untrusted input

One versioned JSON object provides the model-response contract. Parsing alone is insufficient: validation checks symbols, finite positive prices, directional geometry, timing and data quality. Model assertions cannot make missing history valid. HTML escaping protects the rendered report; it is not a factual verification of the model's prose.

Stock price levels must be positive finite JSON numbers; numeric strings and unsupported directions are rejected. Repeated symbols reject all decisions for that symbol, including when one repeated row is invalid. An empty or malformed model response cannot produce numerical plans through a prose fallback. The storage layer checks these critical invariants again before issuing SQL. Options require positive finite bid/ask values and a nonnegative spread; crossed markets never become scored candidates.

Example: a stock can have an apparently valid entry/target/stop while its quote becomes stale during generation. Final issuance checks suppress the plan. Tests cover this boundary.

## Measure indicators outside the model

Moving averages, returns, ATR and price ranges are calculated from completed bars. The prompt receives measured values with dates and coverage, not a request to invent technical indicators. Insufficient history remains explicit. This keeps deterministic arithmetic independently testable.

## Keep research separate from tracked plans

An overnight preparation card may contain conditional reference levels, but it does not create a stock-plan row or an evaluation sample. The report displays preparation and tracked-plan dates separately. This prevents a useful research display from becoming an invented executable record.

## Freeze evaluation assumptions

Daily bars do not reveal the order of intraday price touches. The policy chooses conservative handling, flags ambiguity and versions its assumptions. It starts after issuance, never substitutes a current quote for missing path evidence, and excludes unfilled/pending records from scored returns.

This does not solve market execution realism. It makes the assumptions reviewable and repeatable.

## Use a database boundary between existing languages

Node.js already owns API orchestration and HTML reporting; Python owns deterministic historical evaluation. Keeping this boundary preserves tested logic and makes each job independently runnable. A single language could simplify packaging; two languages introduce environment and contract maintenance costs. The shared schema/policy and actual cross-language integration test address that cost.

## Persist paid work and delivery state

Store input evidence and model output before later work. Use a run key, database lock and transaction to prevent repeated plan insertion. Mark email uncertainty before the external call so a crash cannot silently trigger duplicate delivery. There is no distributed exactly-once guarantee: model persistence and provider acceptance each have uncertainty windows.

The complete report and options evidence belong to the saved run output. Stock rows contain the normalized fields needed for due-plan selection and evaluation; they do not repeat the full report. The public application has no per-contract SQL analytics, so it no longer duplicates options evidence into separate tables. Existing tables remain archives until a separately reviewed cleanup. This trades speculative query flexibility for a smaller persistence path while retaining replay evidence.

## Five-minute walkthrough

1. Run `npm start` and open `local-data/demo/report.html`. Explain the problem and what the report gives its reader.
2. Trace NVDA through quote/history qualification, calculated indicators and the saved model response.
3. Show how the application accepts or excludes a proposed stock plan; compare the earnings-blocked MSFT card in the same report.
4. Show the stored issuance timestamp and frozen policy, then walk through one target exit and one ambiguous stop case.
5. Show a meaningful test and discuss one tradeoff: daily-bar ambiguity, external-data availability or the Node/Python boundary.

For deeper questions, explain the transaction boundary, terminal outcome immutability, version-isolated metrics, stale-after-generation checks and email uncertainty. Describe only work you understand and can defend. Use measured outcomes only when independently established; the synthetic cases demonstrate mechanics, not model quality.
