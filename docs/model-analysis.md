# ModelAnalysisV1

`src/modelAnalysis.js` defines the versioned JSON Schema, response parser and structured research-commentary adapter. `src/reportPrompt.js` submits this exact schema through Chat Completions `response_format.json_schema` with `strict: true`. The application validates the response against the same schema; provider constraints never replace application qualification.

The configured model must support that response format; the repository default is `gpt-4o-mini`. Every object has required fields and `additionalProperties: false`; preparation uses a nested `anyOf` for its two explicit decision shapes. These choices follow the [OpenAI structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat). An unsupported model/schema request fails without an automatic fallback or another paid call.

| Field | Meaning |
|---|---|
| `schema_version` | Exactly `model-analysis-v1` |
| `market_summary` | English market commentary; retains the existing `Daily Summary:` display label |
| `stocks` | Exactly one row for each quoted symbol, with `structure`, `momentum`, `catalyst` and `risk` strings; empty strings explicitly mean unavailable commentary |
| `recommendations` | Candidate stock plans, or `[]`; fields are explicit direction/order style, numeric levels, score/confidence and descriptive evidence/risk text |
| `preparation` | Explicit `watch_only` or `propose` decisions, or `[]` when not required |

Directions are `long` or `short`; entry styles are `breakout` or `pullback`. Candidate `setup_score` and `ai_confidence` may be `null` when unavailable; the existing application metric/default rules still apply. Other descriptive plan fields use empty strings for unavailable text. A watch-only decision has only symbol, decision and reason. A propose decision has symbol, decision, direction, entry/target/stop, trigger/thesis/invalidation/risk and evidence-as-of date. The model cannot assign approval, data eligibility, measured indicators or evaluation policy through extra fields.

## Validation and qualification

The parser accepts one JSON object, with no fences, extra prose, old marker blocks or fallback extraction. Its small schema validator implements only the keywords used by the owned schema: closed objects, required keys, arrays, types, enums, nullable numbers and `anyOf`. It does not coerce values or fill omitted fields. Unknown fields, missing required fields, malformed numbers/directions and schema versions fail validation. Every array rejects duplicate/unknown symbols. Missing stock rows also fail validation. A malformed document suppresses all candidate/preparation numbers and records its validation state; the report still retains application evidence and visible reasons.

Schema validity is not permission to trade. `src/recommendations.js` checks final quote/history eligibility, positive finite prices, price geometry and minimum risk/reward. `src/evaluationPolicy.js` assigns supported frozen order policy; context checks apply earnings restrictions. `src/preparation.js` separately checks expected decisions, evidence dates, preparation windows, watch-only reasons and numerical strategies. Missing eligible preparation decisions remain visible output problems. Non-normal model completion suppresses numerical plans even if its JSON is structurally valid. Final issuance-time freshness/session checks remain authoritative.

`src/qualification.js` owns initial and issuance input qualification. The initial pass uses the actual clock after collection, and the issuance pass recalculates from saved normalized evidence with the issuance clock. Neither trusts cached eligibility or requests additional provider/model data. This preserves the model's evidence snapshot while withholding plans whose source or timing no longer qualifies.

Research commentary fields containing trade instructions are withheld before document rendering. Qualified tracked plans retain their validated analysis and order values. Preparation stays display-only and cannot enter historical trade evaluation.

## Saved runs and compatibility

Snapshots store `model_schema_version=model-analysis-v1`, `prompt_version=daily-report-model-analysis-v1`, the exact request and raw response. Recovery settings identify `public-report-v3`. The model adapter returns `{content, finish_reason, usage}` directly; the runner saves completion metadata beside the raw response. Responses are checkpointed before downstream output/options work, including empty or refused responses. Retrying a later failure reuses that checkpoint; an empty string is a saved response, not a reason to generate again. Model retries remain disabled and existing deadlines remain in place.

Validation results are saved under `output.model_validation`; raw response text remains under `output.report`. An incompatible unfinished run without saved output is rejected before paid work. Complete it with its original version; there is no permanent legacy parser in the new runner. Already-saved outputs and completed historical reports replay their frozen HTML without model interpretation. PostgreSQL tests cover compatible recovery, rejected contract changes, invalid/empty/refused checkpoints and old completed-output replay.

The single runnable report and all test scenarios use this contract. Financial expectations are stored in `test/fixtures/report-facts-baseline.json`; generated reports are not committed.
