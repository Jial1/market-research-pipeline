# ReportDocumentV1

`src/reportDocument.js` builds the application-owned rendering contract after final qualification, preparation validation and options selection. The model cannot assign its approval states. The runner saves it as `output.reportDocument` alongside frozen HTML for replay.

| Field | Contents |
|---|---|
| `schema_version`, `issued_at`, `header` | Document version, issuance instant, New York report date and market-session state |
| `market` | Validated model commentary and computed market/earnings context |
| `stocks` | Approved stocks ranked by model score, followed by the remaining watchlist; scores are not win probabilities |
| `stocks[].quote`, `measured_evidence` | Qualified values, source timestamps and completed-bar calculations |
| `stocks[].analysis` | Structure, momentum, catalyst and risk commentary; missing/withheld states remain explicit |
| `stocks[].decision` | Final status, reasons, watchlist explanation and research warnings |
| `stocks[].plan`, `preparation`, `earnings` | Approved plan or null, separate conditional strategy/outcome, and applicable earnings evidence |
| `stocks[].options_supplement` | Direction-matched selected/skipped supplement for an approved plan, or null |
| `tracked_plans` | Qualified plans in persistence order, independent of display ranking |
| `evaluation_policy`, `exclusions` | Frozen execution assumptions and final exclusion records |
| `preparation`, `footer` | Strategy/output-issue counts, evidence dates, sources and preparation/tracked-entry sessions |

Statuses are `approved`, `preparation`, `event_risk`, `preparation_error`, `watch_only` and `research_only`. Only an approved stock has a tracked plan. Preparation stays outside stock evaluation. Research commentary containing numerical trade instructions is withheld; all rendered text is escaped.

The builder detaches the document from mutable inputs. It contains no HTML or raw response and survives JSON serialization. `formatDashboard(document)` accepts this document only. Its guard rejects unsupported versions, duplicate stocks and inconsistent plan/status pairs. Financial qualification stays upstream; the renderer formats supplied decisions and values.

The run output also retains the raw response, validation metadata, normalized storage inputs and chain evidence. The runner checkpoints this output before plan storage/artifact writing/delivery. Recovery reuses the saved output rather than rebuilding an issued document against later prices.

Tests cover independent rendering, decision separation, display/persistence order, input detachment, escaped commentary and issuance-time suppression. The frozen financial expectations live in `test/fixtures/report-facts-baseline.json` and are not regenerated from changed application code.

Completed historical runs without a document replay their stored output and HTML. An unfinished incompatible response contract requires its original code; there is no legacy model-text parser in the current runner.
