"""Deterministic hypothetical outcomes. No network, database or environment file."""
from evaluation_policy import POLICY, evaluate_path

DATES = ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]
SESSIONS = [{"date": d, "open_at": f"{d}T13:30:00Z", "close_at": f"{d}T20:00:00Z"} for d in DATES]
PLAN = {"symbol": "SYNTHETIC", "issued_at": "2026-10-15T16:00:00Z", "eligible_session": DATES[1],
        "trade_direction": "long", "entry_prediction": "breakout", "order_type": "buy_stop",
        "entry_price": 100, "target_price": 110, "stop_loss": 95, "evaluation_policy": POLICY}

def bar(index, opening, high, low, close):
    return dict(date=DATES[index], open=opening, high=high, low=low, close=close)

def main():
    print("Synthetic hypothetical stock outcomes; not measured performance.")
    cases = [
        ("target_after_open_entry", [bar(1, 100, 111, 99, 110)], "won"),
        ("stop_gap", [bar(1, 100, 104, 99, 103), bar(2, 92, 94, 90, 93)], "lost"),
        ("same_bar_ambiguity", [bar(1, 100, 111, 94, 101)], "lost"),
        ("entry_expires", [bar(i, 98, 99, 97, 98) for i in (1, 2, 3)], "expired"),
        ("missing_completed_session", [], "unavailable"),
    ]
    for name, candles, expected in cases:
        result = evaluate_path(PLAN, SESSIONS, candles, "2026-10-22T20:16:00Z")
        if result["state"] != expected:
            raise AssertionError(f"{name}: expected {expected}, got {result['state']}")
        print(f"{name}: {result['state']}; net return={result['net_return_pct']}")

if __name__ == "__main__":
    main()
