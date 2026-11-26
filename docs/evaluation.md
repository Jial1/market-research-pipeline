# Historical recommendation evaluation

The supported policy is `next-session-v1`, defined in `config/evaluation-policy.json` and implemented by the pure function `evaluate_path` in `python/evaluation_policy.py`.

This evaluates hypothetical **stock setups**. It does not evaluate option returns, actual fills or a portfolio.

| Decision | Rule |
|---|---|
| Start | First exchange session strictly after the New York issuance date; ignore issuance-day moves |
| Orders | Long breakout/pullback map to buy-stop/buy-limit; short breakout/pullback map to sell-stop/sell-limit; other types are research-only |
| Entry window | Three eligible sessions; never triggered means expired, with no trade return |
| Holding window | Up to three sessions including entry; otherwise exit at the final close |
| Opening fills | Stop entries can fill worse at the open; limit entries receive no favorable improvement |
| Invalid opening | An unfilled setup opening at/beyond its target or stop is invalidated |
| Ambiguous bars | Stop precedes target when both touch; intraday entry receives no same-bar target credit; ambiguity is flagged |
| Missing evidence | Unavailable and retryable; never use a current quote to invent a historical path |
| Completed bars | Use only sessions closed at least 16 minutes before the fixed UTC cutoff |
| Corporate actions | Compare raw execution bars with paired split-adjusted evidence; split boundaries remain unavailable |
| Costs | Assumed per-side low/base/high friction is 0/5/15 bps; sensitivity assumptions are not observed execution costs |
| Versioning | Pending/unavailable can retry; terminal outcomes remain immutable within the version; cost variants remain separate |

For a long setup with entry 100, target 110 and stop 95:

- Open entry at 100 followed by a target touch: gross +10%, base net +9.9%.
- Enter at 100, then a later opening gap to 92: gross -8%, base net -8.1%.
- An open-entry bar touches both 110 and 95: stop exit, base net -5.1%, ambiguity flagged.
- No entry trigger during the three-session window: expired; no scored trade return.
- A required completed bar is missing: unavailable; no scored trade return.

`npm run evaluate:demo` prints these synthetic outcomes without writing generated files. The unit tests also cover short orders, late entry, time exits, partial sessions, DST/calendar handling and policy variants.

Metrics disclose total evaluated plans, filled/closed plans, pending/unavailable counts, unfilled terminal outcomes, ambiguity, net win rate and average net return among filled/closed plans. Empty scored samples display unavailable values. Returns from isolated, potentially correlated plans do not establish portfolio returns, drawdown or Sharpe ratio.

The [Node/Python contract](evaluation-contract.md) specifies persisted fields, state groups, metric denominators and cohort boundaries. Report feedback uses a 30 × 24-hour issuance window; Python's default summary is cumulative. Both use identical scoring semantics for an equal cohort/version. The shared hand-calculated cases include zero returns, a gross winning outcome with a net loss, missing returns, unfilled outcomes and isolated cost variants.
