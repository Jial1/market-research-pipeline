# Running the system

## Requirements

Node.js 22+, Python 3.11+ and npm. PostgreSQL 17+ is needed only for live operation or integration tests. Docker Compose is one convenient way to start a dedicated local database.

```sh
npm ci
python -m venv .venv
# Activate .venv (see README), then:
python -m pip install -r python/requirements.txt
```

Use `npm start` to generate one offline report at `local-data/demo/report.html`. `npm run evaluate:demo` prints synthetic evaluation outcomes without writing files. No credentials or database are needed for these commands. Python requires the bundled tzdata dependency on systems without IANA timezone data, including Windows.

For programmatic `runReport` calls, dry-run mode disables database writes and email; injected input/model/options adapters still determine where data comes from. Supply an options adapter when options are enabled, including in dry runs. The default CLI demo supplies local fixtures for every adapter and remains fully offline.

## Live configuration

Copy `.env.example` to `.env` in this repository. Only that exact file is loaded by live entry points; a parent project's `.env` is not loaded. Do not copy a private environment file or reuse its database.

Configuration and clients are created once at startup. Validation, run recording, indicators, earnings/context and evaluation are always enabled. Email is selected explicitly at the CLI; options use `ENABLE_OPTIONS_SUPPLEMENT`. Invalid values and retired private-project flags/credential aliases are rejected; see `src/config.js` for the accepted settings. Options use MarketData only, with `MARKETDATA_TOKEN`; stock/news/earnings credentials do not act as an options fallback.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Live report generation; the configured model must support the retained request format |
| `FINNHUB_API_KEY` | Quotes, news and earnings evidence |
| `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | Trading calendar and historical stock bars for reporting/evaluation |
| `MARKETDATA_TOKEN` | Daily options-chain supplement |
| `ENABLE_OPTIONS_SUPPLEMENT` | Defaults true; false explicitly omits live options |
| `QUOTE_MAX_AGE_SECONDS` | Positive quote freshness threshold; defaults to 900 |
| `DATABASE_URL` | A new dedicated PostgreSQL database |
| `RESEND_API_KEY`, `EMAIL_TO`, `EMAIL_FROM` | Optional email credentials, comma-separated recipients and verified sender |

Provider access and entitlements determine whether history/news/options can be retrieved. The retained historical path expects SIP and specific raw/split adjustments; credentials alone do not establish access. Incomplete evidence is reported as unavailable or research-only. The demo makes no claim about account entitlements.

## Initialize or upgrade the database

```sh
docker compose up -d --wait
# With DATABASE_URL configured from .env.example:
npm run db:migrate
```

The Compose database binds only to localhost and uses example development credentials. The same migration command initializes an empty schema or applies pending versions to an existing versioned public database. Rerunning it with current history applies nothing. Cloud connections should use the provider's verified TLS configuration; only the localhost example disables TLS.

Run migrations before reporting or evaluation. Neither runtime creates or alters tables; both require the exact migration history from this checkout. Migration credentials need schema-change privileges; runtime credentials need access to the history and application tables/sequences, without DDL privileges.

The current schema is version 5. Existing version-4 public databases use the same command; it preserves legacy text at run level without changing saved reports, plans, evaluations or option archives. New reports keep report text and options evidence in the saved run output, with stock rows linked by `run_id`.

For an existing public database from before migration tracking, back it up and verify the target first, then use `npm run db:migrate -- --adopt-existing`. Adoption accepts only the exact prior public schema and preserves its rows. An unrelated, partial or altered schema is refused; do not point this command at the private project database. See [migration ownership and adoption](database-migrations.md).

## Generate and evaluate live reports

```sh
npm run report:live
# Optional delivery, selected before this day's first run:
npm run report:email
# Run after subsequent eligible sessions have closed:
npm run evaluate:live
```

Live generation calls external providers, persists qualified stock plans and writes JSON/HTML under `local-data/report-runs/`. Console output identifies the artifact. Options stay attached to qualified stock plans; unavailable chains produce an explicit skip.

Email is disabled unless `--email` is passed by `report:email`. Select delivery mode before generating the day's first report: a completed daily run is reused, so running `report:email` afterward does not send a previously completed local-only run. An uncertain delivery never automatically resends. Inspect the saved run/provider state before intervening; no reconciliation CLI is included.

New reports and email subjects are English. Existing saved outputs are reused as recorded; changing the prompt language does not translate an older completed report or trigger another paid generation. The offline examples are regenerated from English saved responses.

The configured `OPENAI_MODEL` must support Chat Completions strict JSON Schema output; the default is `gpt-4o-mini`. See [the response contract](model-analysis.md). No prose/block fallback or automatic paid retry is used. Model schema/prompt versions are saved with each run. An incompatible unfinished run without saved output must be completed with its original code version; completed saved reports continue to replay.

The live evaluator writes database outcomes and summary metrics. `--cutoff` fixes a timezone-aware replay cutoff, and `--friction-bps` creates a separate cost version:

```sh
npm run evaluate:live -- --cutoff 2026-10-23T20:16:00Z
npm run evaluate:live -- --friction-bps 8
```

The database stores the latest result per plan/version, not a complete event history. Historical experiments should use a separate database, not overwrite an existing operational dataset.

Report feedback covers 30 elapsed 24-hour issuance days in the reporting namespace; the evaluator's stored production summary is cumulative through its cutoff. Both share scoring rules but intentionally use different cohorts. See [the evaluation contract](evaluation-contract.md) for equal-cohort comparison, exact cutoff boundaries and the daylight-saving boundary correction.

## Tests

```sh
npm test
npm run test:python
npm run check:release
```

For actual PostgreSQL integration, use a disposable local database. Tests create randomized schemas and drop them afterward. `TEST_DATABASE_URL` is separate from `DATABASE_URL` and must use a loopback host.

```powershell
# Windows PowerShell, after activating .venv:
$env:TEST_DATABASE_URL='postgresql://portfolio:portfolio@localhost:55432/portfolio?sslmode=disable'
$env:PYTHON=(Resolve-Path '.venv/Scripts/python.exe').Path
npm run test:integration
```

```sh
# macOS/Linux, after activating .venv:
TEST_DATABASE_URL='postgresql://portfolio:portfolio@localhost:55432/portfolio?sslmode=disable' PYTHON=python npm run test:integration
```

The cross-language test issues a synthetic report through Node, evaluates its stored plan in Python, and reads default-policy feedback in Node. Integration coverage also checks recovery, preparation/earnings evidence, atomic storage, schema upgrades and uncertain delivery. Tests run sequentially because advisory run locks are database-wide across isolated schemas.

CI runs demos, unit tests and integration tests against a disposable PostgreSQL service. No live market, AI or email credentials are configured. Scheduling real jobs is an optional deployment task outside this portfolio release.

The current pipeline version is `public-report-v3`. Finish an older incomplete run without saved output using its original code. Completed outputs continue to replay unchanged. Recovery uses explicit pipeline/prompt/model versions and settings; runtime Git inspection and separate operational-summary files are removed.
