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

Hosted CI passed on 2026-11-26 with Node.js 22, Python 3.11 and PostgreSQL 17: [initial publication run](https://github.com/Jial1/market-research-pipeline/actions/runs/45908377510). It verified both offline demos, Node/Python tests, actual database integration, release checks and generated-file isolation with synthetic inputs and no live service credentials. The [workflow history](https://github.com/Jial1/market-research-pipeline/actions/workflows/ci.yml) shows subsequent results.

Live provider/model/email calls and deployment have not been verified. These tests demonstrate mechanics and covered correctness cases, not trading profitability or account entitlements.

## Source archive

1. Run the checks in [setup](setup.md), then `npm run package:release` with the Python environment active.
2. Extract `local-data/market-research-pipeline.zip`. It contains standalone source, dotfiles, lockfile, tests and the README preview. It excludes `.git`, `.env`, installed dependencies, virtual environments and local output.

The public source is available at [Jial1/market-research-pipeline](https://github.com/Jial1/market-research-pipeline). Its Git history starts with the standalone interview edition; private development history is excluded. No license has been selected.

The release checker verifies required files, local imports, dependency/lock consistency, excluded components and common secret/path patterns. This is a focused packaging check rather than a comprehensive security audit. A hosted application is optional; reviewers can run the offline demo.
