# Verification and release

This repository contains one supported reporting pipeline and a separate historical stock evaluator. The offline report and evaluation demo use synthetic evidence. Generated artifacts, credentials, dependencies and private development history are excluded from the source ZIP.

## Local verification

Verified on 2026-11-26 with Node.js 24.11.1, Python 3.14 and PostgreSQL 17.6:

| Check | Result |
|---|---|
| Node unit/regression tests | 112 passed |
| Python tests | 32 passed |
| Actual PostgreSQL integration tests | 14 passed, zero skipped |
| Standalone ZIP setup | Fresh npm dependencies/Python environment; demos, unit tests and database suite passed from the extraction |
| Offline reporting | One HTML report; all five scenario regressions retained in memory |
| Financial invariants | Original frozen expectations retained in `test/fixtures/report-facts-baseline.json` |

Coverage includes invalid model/data suppression, preparation isolation, option selection, paid-response checkpoints, frozen-output recovery, atomic plan batches, uncertain email delivery, migration/adoption preservation, execution-policy cases and Node/Python cohort agreement across DST.

CI is configured for Node.js 22, Python 3.11 and PostgreSQL 17 with synthetic inputs and no live service credentials. Hosted CI, live provider/model/email calls and deployment have not been verified. Local tests demonstrate mechanics and covered correctness cases, not trading profitability or account entitlements.

## Build and publish separately

1. Run the checks in [setup](setup.md), then `npm run package:release` with the Python environment active.
2. Extract `local-data/market-research-pipeline.zip`. It contains standalone source, dotfiles, lockfile, tests and the README preview. It excludes `.git`, `.env`, installed dependencies, virtual environments and local output.
3. Review the archive and choose a license before publication. No license has been selected by this extraction.
4. Initialize fresh Git history in the standalone folder and publish that folder to a new repository. Do not push the parent private project or its history.
5. Run hosted CI and report its actual result. A hosted application is optional; reviewers can run the offline demo.

The release checker verifies required files, local imports, dependency/lock consistency, excluded components and common secret/path patterns. This is a focused packaging check rather than a comprehensive security audit. Publication and deployment have not been performed.
