# Database migrations

Schema changes have one owner: `npm run db:migrate`. It loads this repository's `.env` and uses `DATABASE_URL`. Use a dedicated public-project database. Reporting and evaluation only check migration history; they do not initialize or upgrade tables.

## Fresh setup and later upgrades

```sh
npm run db:migrate
```

An empty schema receives migrations in order. A versioned schema receives only pending migrations; an up-to-date schema applies nothing. The command prints the selected schema, current version, applied versions and adoption status. It targets `current_schema()` from the connection's search path, normally `public`. A custom existing schema can be selected with the PostgreSQL URL's `options` parameter, such as `options=-c%20search_path%3Dportfolio`; use the same schema for Node and Python jobs. Invalid/system schema names are rejected.

Use migration credentials with schema-change privileges. Runtime credentials need `SELECT` on `schema_migrations` plus the application table/sequence privileges required for their reads and writes; neither runtime needs DDL privileges. Stop jobs during schema upgrades and restart them with the matching checkout. Offline demos need no database.

## Adopt an existing public database

Back up the database and verify that `DATABASE_URL` selects the intended public-project database. For the previous public layout without migration history:

```sh
npm run db:migrate -- --adopt-existing
```

Adoption requires an exact catalog fingerprint of the pre-versioned public schema through version 4. That signature was captured from the previous public bootstrap, independently of the new runner. It covers application objects, columns/defaults, constraints and indexes. Row contents, schema names, owners and relation OIDs are excluded. Adoption records versions 1–4 without rewriting existing data, then applies pending migrations. Version 5 adds preserved run-level text as described below; saved outputs and existing application rows retain their original fields and values.

An unversioned nonempty schema is refused without the flag. The flag does not bypass checking: partial layouts, extra application objects or altered constraints/columns/indexes are refused. Do not use it on the private project database. There is no reset, automatic repair or destructive cleanup command. Resolve unexpected history/schema differences through a reviewed migration or restore, rather than editing recorded versions to silence an error.

## Ownership and integrity

- `sql/migrations/` contains the ordered SQL. `001_base.sql` provides the original base tables; versions 2–4 retain their previous SQL unchanged. There is no separate bootstrap schema.
- `config/database-schema.json` lists consecutive versions, filenames and SHA-256 checksums. Checksums normalize CRLF to LF so Windows and Linux checkouts agree. SQL files must exactly match the manifest; unknown files or edited migrations are refused before opening a transaction.
- `src/migrations.js` applies pending versions and records them in `schema_migrations` in one transaction. A [transaction-scoped advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) serializes migration commands targeting the same schema. Failure rolls back both DDL and history. Keep future migrations transaction-compatible.
- Append new numbered SQL and its manifest entry; never edit previously applied SQL. Node and Python share this manifest and reject missing, incomplete, newer or mismatched history before normal work. Runtime checks inspect history, not the whole catalog; protect schema ownership against out-of-band changes. The migration command also checks catalog drift at the frozen version-4 boundary.

## Version 5: run-level evidence and archived data

Run `npm run db:migrate` before using this checkout with an existing versioned public database. Version 5 adds `report_runs.legacy_report_texts`, an array of distinct historical per-stock report texts that are missing from that run's saved `output.report`. Text already present there is not copied again. Empty strings are preserved; nulls represent no text. The migration leaves saved snapshots/outputs, timestamps, run/delivery states, stock plans, evaluations, metrics and old option rows unchanged. Conflicting historical text variants are preserved, not arbitrarily chosen. New runs default to an empty legacy array.

New report text is available through `report_runs.output->>'report'`; option evidence through `output->'optionChainSnapshots'` and `output->'optionsSupplements'`. Stock rows retain their run foreign key and evaluation fields, but new writes do not populate `trading_reports.report_text` or the old options tables. Both options tables and the old text column remain historical archives. A plan without a run identifier stays in the old archive rather than receiving an invented run or evaluation sample. Option chains without a reliable run link are retained in their original table rather than guessed into a report.

This is an additive preservation transition. It does not drop tables/columns or delete/archive rows elsewhere. Any later physical cleanup needs a separate review of exports, ownership and evidence equivalence. Migration history remains immutable, so fresh databases also pass through the old table definitions before reaching the current version.

The supported database baseline is PostgreSQL 17+. Local verification used PostgreSQL 17.6, including fresh initialization, idempotent reruns, adoption, exact preservation of existing fields/rows, legacy-text backfill, pending-version upgrades, refusal cases, concurrent commands, rollback/retry and read-only Node/Python startup checks. Other major versions have not been locally verified; catalog deparsing differences may require reviewing the legacy adoption signature rather than bypassing it.
