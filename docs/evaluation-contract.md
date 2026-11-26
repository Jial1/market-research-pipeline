# Node/Python evaluation contract

Node issues qualified stock plans. Python evaluates them and writes outcomes. Node reads those outcomes for report feedback. PostgreSQL is the boundary; neither runtime starts the other language. Subprocess calls between languages exist only in verification tests.

`config/evaluation-policy.json` remains the single source of execution assumptions and order mappings. `config/evaluation-contract.json` defines outcome groups and the default feedback lookback. Its `evaluation-contract-v1` identifier describes aggregation and cohort semantics, separately from the frozen `next-session-v1` execution policy and database migration version.

## Persisted boundary

| Data | Writer → reader | Contract |
|---|---|---|
| `trading_reports` | Node → Python | UUID `id`/`run_id`; symbol; finite positive entry/target/stop; `long`/`short`; breakout/pullback entry; issuance timestamp with timezone; eligible session as an exchange date; mapped order type; complete frozen evaluation-policy JSON |
| `recommendation_evaluations` | Python → Node | Unique `(report_id, evaluation_version)`; state, terminal/filled/ambiguity booleans; timezone-aware cutoff; nullable gross/net returns in percentage points; detailed policy/evidence and evidence hash in `details` |
| `evaluation_metrics` | Python → storage/review | Summary for one policy version and New York cutoff date; cumulative default production cohort, including Python-only gross-return and cost-sensitivity details |
| `report_runs` | Node → replay/cohort filters | Saved snapshots/output and namespace; stock rows link to the run. Options and preparation remain outside the stock evaluation sample |

JavaScript JSON numbers become PostgreSQL numeric fields and Python numbers. JSON `null` becomes SQL `NULL`/Python `None`; it is not a zero return. Timestamp comparisons use instants; eligible-session dates retain their date meaning. Saved policy JSON must match the evaluator's supported issuance policy before provider reads. Explicit cost variants change evaluation version without overwriting the issuance policy.

Python selects due plans with issuance/session/policy metadata, and retries only nonterminal outcomes whose saved cutoff is no later than the requested cutoff. Terminal outcomes cannot be overwritten within their version; an older cutoff cannot overwrite a newer nonterminal result. The existing SQL constraints, storage validation and cross-language tests enforce the boundary. No ORM, generated client or separate RPC/schema-validation framework is introduced.

## Common metrics

Both implementations read the shared outcome groups. `src/evaluationMetrics.js` is the pure Node aggregation function; `python/metrics_calculator.py` calculates the same common fields plus Python's existing details. Language-specific arithmetic is small and tested against one shared set of hand-calculated cases in `test/fixtures/evaluation-contract.json`.

| Field | Meaning |
|---|---|
| `total_plans` | Evaluated rows in the selected cohort/version; issued plans with no saved outcome are not counted |
| `filled_closed` | State is `won`, `lost` or `time_exit`, entry was hit, and net return is non-null |
| `pending`, `unavailable` | Counts of those states; neither belongs to the scored sample |
| `unfilled_terminal` | `expired`, `invalidated` or `research_only` outcomes |
| `ambiguous_count` | Ambiguity flags across all selected outcomes, including unscored ones |
| `net_win_rate` | Strictly positive net returns divided by `filled_closed`; zero counts in the denominator but is not a win |
| `avg_net_return_pct` | Arithmetic mean of scored net returns, in percentage points |

Empty scored samples yield null win rate/averages. A state labelled `won` can have a negative net return after costs; the net return determines the net win rate. Cost versions never mix. Python additionally retains `filled_count` across all outcomes, average gross return and low/base/high cost-sensitivity means for the scored sample. Node does not need those extra fields for report feedback.

The shared terminal states are the union of scored and unfilled-terminal groups. `pending` and `unavailable` remain retryable. Moving these identifiers into a contract does not change execution rules, friction, terminal immutability or metric denominators.

## Cohorts and cutoff

Node feedback defaults to **30 elapsed 24-hour issuance days**, the requested evaluation version and the reporting namespace. Python summaries default to all issuance history through the cutoff in the production namespace. They intentionally describe different cohorts. Python accepts optional `issuance_days` and `namespace` arguments when an equal-cohort comparison is needed; its evaluation CLI keeps the cumulative default. Node's optional cutoff defaults to database `now()`.

Both readers require issuance and outcome cutoff to be no later than the requested cutoff. Bounded readers also require issuance to be at or after `cutoff - days × 24 hours`; both issuance boundaries are inclusive. Namespace matching is exact, treating an absent namespace as production (`""`). Different cohort sizes are not evidence of different scoring definitions.

The elapsed-hour definition makes the lookback independent of the PostgreSQL session timezone. This corrects the previous `INTERVAL '1 day'` behavior, whose boundary could shift across daylight saving time in a non-UTC session. The change can affect outcomes within that boundary hour; it does not modify saved outcomes or the execution policy. Tests span the autumn DST transition with Node in New York time and Python in UTC.

The database stores the latest result per plan/version, not every intermediate evaluation. Reading with an earlier cutoff excludes newer stored results; it does not reconstruct an overwritten earlier result. Use a separate replay database when a complete historical experiment is needed.
