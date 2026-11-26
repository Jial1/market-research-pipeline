# Architecture

This is a batch system: Node.js produces stock research reports; Python evaluates saved stock plans. PostgreSQL is their shared boundary. Demo and live reporting use the same core with different input/model/options adapters.

## Reporting flow

1. The CLI loads configuration once. Composition captures credentials and constructs reusable clients. Evidence collection retrieves quotes, news, calendars, historical bars, SPY history and earnings.
2. Qualification checks current evidence and computes indicators, market context and preparation eligibility. The runner saves the qualified snapshot, exact model request, evidence hash and contract versions before generation.
3. The model adapter returns `{content, finish_reason, usage}`. The runner saves even empty/refused/invalid paid responses before downstream work, so a later failure can reuse them.
4. Construction validates the model JSON and qualifies evidence again at issuance. It determines tracked plans and separate conditional preparation, selects options for qualified plans, builds the application-owned report document and renders HTML.
5. The runner checkpoints the completed output, atomically inserts stock plans, awaits local artifacts and optionally sends email. A completed output is reused on recovery rather than requalified against later prices.

## Component ownership

| Component | Responsibility |
|---|---|
| `src/index.js`, `src/config.js`, `src/composition.js` | Commands, configuration and concrete client/adapter wiring |
| `src/data/reportInputs.js`, provider adapters | Acquire and normalize evidence; preserve source dates and unavailable states |
| `src/qualification.js` | Initial and issuance-time qualification, including earnings request bounds |
| `src/data/indicators.js`, historical/context helpers | Deterministic completed-bar calculations, SPY context and earnings assessment |
| `src/modelAnalysis.js`, `src/reportPrompt.js` | One strict model JSON contract and exact request construction |
| `src/recommendations.js`, `src/preparation.js`, `src/evaluationPolicy.js` | Candidate validation, preparation separation and frozen execution-policy assignment |
| `src/optionsData.js`, options math/filter/scoring/supplement modules | Retrieve chains, reject invalid contracts, calculate scenarios, select or explicitly skip |
| `src/reportBuilder.js` | Construct qualified snapshots and final report outputs using explicit callbacks |
| `src/reportDocument.js`, `src/formatter.js` | Application-owned display decisions and document-only HTML rendering |
| `src/reportRun.js` | Daily identity, locks, checkpoints, replay, storage/delivery ordering and cleanup |
| `src/runRecords.js`, `src/database.js` | Durable state transitions, atomic/idempotent plan insertion and outcome-feedback reads |
| `src/runInfrastructure.js`, `src/ai.js`, `src/mailer.js`, `src/readRetry.js` | Files, redaction, model/email calls and bounded provider-read retries |

Provider validation checks response identity and shape. Domain qualification checks whether that evidence is usable now. Issuance revalidation is intentional: provider/model delays can cross a quote-age limit, market close, completed-bar cutoff or earnings-age boundary. Neither qualification pass fetches providers again. Benchmark features are reused within a pass when SPY is also in the watchlist; no cross-stage eligibility cache is trusted.

The model proposes analysis and candidates. Application code owns approval, measured indicators and evaluation policy. The renderer reads only [ReportDocumentV1](report-document.md); it does not parse model output or approve plans. See [ModelAnalysisV1](model-analysis.md) for validation and incomplete-response handling.

## Evaluation and shared data

`python/run_evaluation.py` selects due plans through the database adapter. `evaluation_data.py` collects bounded subsequent evidence; `evaluation_policy.py` evaluates it without network/database access. `correct_evaluator.py` persists versioned outcomes and summaries. Pending/unavailable outcomes can retry; terminal outcomes are immutable within their version.

Both languages read `config/evaluation-policy.json` and `config/evaluation-contract.json`. Reporting feedback defaults to a 30 × 24-hour issuance cohort; Python's production summary is cumulative. Equal-cohort metrics agree, while Python retains additional gross-return/cost details. See [the boundary and metric definitions](evaluation-contract.md).

| Table | Current use |
|---|---|
| `schema_migrations` | Applied migration versions, filenames and checksums |
| `report_runs` | Settings, input/request/raw-response checkpoints, final document/HTML/options output and run/delivery state |
| `trading_reports` | Qualified stock plans linked to a run, with issuance/session/order/frozen policy |
| `recommendation_evaluations` | Latest outcome per plan/version, cutoff, terminal state, returns and evidence |
| `evaluation_metrics` | Summary snapshots by date and evaluation version |
| `option_chain_snapshots`, `option_supplements` | Historical archives; new reports store options evidence in run output |

`npm run db:migrate` is the sole schema-change command. Node and Python jobs only check history. Existing archive columns and tables are preserved; [the migration guide](database-migrations.md) explains initialization, adoption and upgrades.

## Recovery and failure boundaries

- A daily advisory lock prevents overlapping work; plan inserts and their stored flag share one transaction. Conflicts leave issued rows unchanged.
- Responses and completed outputs have separate checkpoints. Saved empty responses are still reused. A crash before response persistence leaves uncertainty about whether generation occurred.
- Recovery checks `public-report-v3` settings and prompt/model versions. An incompatible unfinished run without output needs its original code. Saved completed output replays without another model call.
- Email becomes `unknown` before the network call. A timeout/crash does not automatically resend. Local-only completion records `disabled`.
- Provider reads have bounded retries. Paid model generation and email sends have deadlines and no automatic retry loop. Missing persistence prevents tracked reporting and delivery.
- Evidence gaps remain unavailable/research-only. Preparation and options scenarios never enter the tracked stock evaluation sample.

## Repository and review path

`src/` owns reporting; `python/` owns evaluation; `sql/migrations/` owns schema changes. `fixtures/` provides shared synthetic inputs. `test/` contains focused regressions and PostgreSQL integration cases. The single offline report and live artifacts go under ignored `local-data/`; `examples/` contains the README preview only.

Start with `reportRun.js` and `reportBuilder.js`, trace a plan into `runRecords.js`, then follow `python/evaluation_policy.py` and `test/publicWorkflow.integration.test.js`. [Engineering decisions](engineering-decisions.md) explains the tradeoffs.
