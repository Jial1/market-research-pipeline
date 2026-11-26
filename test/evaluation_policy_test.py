"""Hand-calculated paths and provider-boundary checks; no credentials/network."""
import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from evaluation_policy import POLICY, evaluate_path, make_policy
from evaluation_data import EvaluationData, DataUnavailable
from correct_evaluator import CorrectEvaluator

DATES = ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]
SESSIONS = [{"date": d, "open_at": f"{d}T13:30:00Z", "close_at": f"{d}T20:00:00Z"} for d in DATES]
REPORT = {"symbol": "NVDA", "issued_at": "2026-10-15T16:00:00Z", "eligible_session": DATES[1],
          "trade_direction": "long", "entry_prediction": "breakout", "order_type": "buy_stop",
          "entry_price": 100, "target_price": 110, "stop_loss": 95, "evaluation_policy": POLICY}


def bar(day=1, o=99, h=99.5, l=98, c=99):
    return {"date": DATES[day], "open": o, "high": h, "low": l, "close": c}


def evaluate(bars, report=None, cutoff="2026-10-22T20:16:00Z", policy=None):
    return evaluate_path(report or REPORT, SESSIONS, bars, cutoff, policy)


class PathTests(unittest.TestCase):
    def test_pre_issuance_touch_is_ignored(self):
        result = evaluate([bar(0, 100, 112, 94, 105), bar()], cutoff="2026-10-16T20:16:00Z")
        self.assertEqual(result["state"], "pending")
        self.assertFalse(result["was_entry_hit"])
        self.assertIsNone(result["net_return_pct"])

    def test_all_four_order_types(self):
        for direction, entry_type, order, opening, low, high, expected in [
            ("long", "breakout", "buy_stop", 102, 101, 105, 102),
            ("long", "pullback", "buy_limit", 98, 97, 103, 100),
            ("short", "breakout", "sell_stop", 98, 96, 99, 98),
            ("short", "pullback", "sell_limit", 102, 101, 104, 100),
        ]:
            with self.subTest(order=order):
                report = dict(REPORT, trade_direction=direction, entry_prediction=entry_type, order_type=order)
                if direction == "short":
                    report.update(target_price=90, stop_loss=105)
                result = evaluate([bar(o=opening, h=high, l=low, c=opening)], report, "2026-10-16T20:16:00Z")
                self.assertEqual(result["entry_price"], expected)
                self.assertEqual(result["state"], "pending")

    def test_invalid_openings_do_not_become_fills(self):
        for opening in (94, 95, 110, 111):
            with self.subTest(opening=opening):
                result = evaluate([bar(o=opening, h=opening+1, l=opening-1, c=opening)])
                self.assertEqual(result["state"], "invalidated")
                self.assertIsNone(result["gross_return_pct"])

    def test_adverse_stop_gap(self):
        result = evaluate([bar(o=100, h=104, l=99, c=103), bar(2, 92, 94, 90, 93)])
        self.assertEqual(result["reason"], "stop_gap")
        self.assertEqual(result["exit_price"], 92)
        self.assertAlmostEqual(result["gross_return_pct"], -8)

    def test_short_adverse_gap(self):
        report = dict(REPORT, trade_direction="short", order_type="sell_stop", target_price=90, stop_loss=105)
        result = evaluate([bar(o=100, h=101, l=96, c=98), bar(2, 108, 110, 107, 109)], report)
        self.assertEqual(result["exit_price"], 108)
        self.assertAlmostEqual(result["net_return_pct"], -8.1)

    def test_both_exits_stop_first(self):
        result = evaluate([bar(o=100, h=104, l=99, c=103), bar(2, 103, 111, 94, 106)])
        self.assertEqual(result["state"], "lost")
        self.assertEqual(result["exit_price"], 95)
        self.assertTrue(result["ambiguous"])

    def test_intraday_entry_target_is_deferred(self):
        result = evaluate([bar(o=99, h=111, l=99, c=108), bar(2, 108, 109, 106, 107)], cutoff="2026-10-19T20:16:00Z")
        self.assertEqual(result["state"], "pending")
        self.assertTrue(result["ambiguous"])
        self.assertIsNone(result["net_return_pct"])

    def test_intraday_entry_stop_is_ambiguous(self):
        result = evaluate([bar(o=99, h=102, l=94, c=101)])
        self.assertEqual(result["state"], "lost")
        self.assertTrue(result["ambiguous"])

    def test_open_entry_can_take_target_and_cost_sensitivity(self):
        result = evaluate([bar(o=100, h=111, l=99, c=109)])
        self.assertEqual(result["state"], "won")
        self.assertAlmostEqual(result["net_return_pct"], 9.9)
        self.assertEqual(result["cost_sensitivity"], {"low": 10, "base": 9.9, "high": 9.7})

    def test_target_open_gap_does_not_improve_limit_exit(self):
        result = evaluate([bar(o=100, h=104, l=99, c=103), bar(2, 115, 116, 112, 114)])
        self.assertEqual(result["exit_price"], 110)
        self.assertFalse(result["ambiguous"])

    def test_short_gap_entry_and_target(self):
        report = dict(REPORT, trade_direction="short", order_type="sell_stop", target_price=90, stop_loss=105)
        result = evaluate([bar(o=98, h=99, l=89, c=91)], report)
        self.assertAlmostEqual(result["gross_return_pct"], 8/98*100)
        self.assertAlmostEqual(result["net_return_pct"], 8/98*100-0.1)

    def test_expiry_never_counts_as_zero_return_trade(self):
        result = evaluate([bar(1), bar(2), bar(3)])
        self.assertEqual(result["state"], "expired")
        self.assertIsNone(result["net_return_pct"])

    def test_latest_entry_holds_through_fifth_session(self):
        bars = [bar(1), bar(2), bar(3, 100, 104, 99, 102), bar(4, 102, 104, 101, 103), bar(5, 103, 104, 102, 103)]
        result = evaluate(bars)
        self.assertEqual(result["state"], "time_exit")
        self.assertEqual(result["exit_date"], DATES[5])
        self.assertAlmostEqual(result["net_return_pct"], 2.9)

    def test_missing_session_is_retryable(self):
        self.assertEqual(evaluate([bar(2)])["state"], "unavailable")

    def test_partial_session_and_delay_boundary(self):
        bars = [bar(o=100, h=111, l=99, c=109)]
        self.assertFalse(evaluate(bars, cutoff="2026-10-16T20:15:59Z")["was_entry_hit"])
        self.assertEqual(evaluate(bars, cutoff="2026-10-16T20:16:00Z")["state"], "won")

    def test_bad_history_and_ordering(self):
        for bars in ([bar(), bar()], [bar(2), bar(1)], [bar(h=90)], [bar(c=float("nan"))]):
            self.assertEqual(evaluate(bars)["state"], "unavailable")

    def test_metadata_and_eligibility_cannot_be_inferred(self):
        for changes in ({"issued_at": None}, {"issued_at": "2026-10-15T16:00:00"},
                        {"eligible_session": DATES[0]}, {"order_type": "unknown"}, {"target_price": 90}):
            self.assertEqual(evaluate([], dict(REPORT, **changes))["state"], "research_only")

    def test_pre_entry_excursions_are_not_counted(self):
        report = dict(REPORT, entry_prediction="pullback", order_type="buy_limit")
        result = evaluate([bar(1, 105, 109, 101, 106), bar(2, 105, 108, 99, 101)], report, "2026-10-19T20:16:00Z")
        self.assertAlmostEqual(result["mfe_pct"], 1)

    def test_cost_variants_are_versioned_and_validated(self):
        policy = make_policy(8)
        self.assertEqual(policy["version"], "next-session-v1-cost-8")
        result = evaluate([bar(o=100, h=111, l=99, c=109)], policy=policy)
        self.assertAlmostEqual(result["net_return_pct"], 9.84)
        for value in (-1, 101, float("nan")):
            with self.assertRaises(ValueError):
                make_policy(value)



class ProviderTests(unittest.TestCase):
    def api(self, *, split=False, repeated=False, missing=False):
        calls = []
        def get(url, params, headers):
            calls.append(params)
            if "calendar" in url:
                return [{"date": d, "open": "09:30", "close": "16:00"} for d in DATES]
            bars = [{"t": f"{d}T04:00:00Z", "o": 100, "h": 104, "l": 99, "c": 102, "v": 1} for d in DATES[:2]]
            if split and params["adjustment"] == "split":
                bars[0] = dict(bars[0], o=50, h=52, l=49.5, c=51)
            if missing:
                bars = bars[1:]
            return {"bars": {"NVDA": bars}, "next_page_token": "same" if repeated else None}
        return EvaluationData("fake", "fake", get), calls

    def test_feed_adjustments_cutoff_and_saved_evidence(self):
        data, calls = self.api()
        sessions = data.calendar(REPORT["issued_at"])
        bars, evidence = data.history(REPORT, sessions, "2026-10-16T20:16:00Z")
        self.assertEqual(len(bars), 2)
        self.assertTrue(all(c["feed"] == "sip" for c in calls[1:]))
        self.assertEqual([c["adjustment"] for c in calls[1:]], ["raw", "split"])
        self.assertEqual(calls[1]["end"], "2026-10-16T20:00:00+00:00")
        self.assertEqual(evidence["split_check"], "stable_ratio")

    def test_split_boundary_stays_unavailable(self):
        data, _ = self.api(split=True)
        with self.assertRaisesRegex(DataUnavailable, "split_crossing"):
            data.history(REPORT, SESSIONS, "2026-10-16T20:16:00Z")
        outcome = CorrectEvaluator(None, data, "2026-10-16T20:16:00Z").evaluate_report(REPORT)
        self.assertEqual(outcome["state"], "unavailable")
        self.assertEqual(len(outcome["evidence"]["history"]["ratios"]), 2)

    def test_missing_baseline_and_repeated_page_fail_closed(self):
        for args in ({"missing": True}, {"repeated": True}):
            data, _ = self.api(**args)
            with self.assertRaises(DataUnavailable):
                data.history(REPORT, SESSIONS, "2026-10-16T20:16:00Z")

    def test_errors_are_sanitized_no_fallback(self):
        def fail(*args):
            raise ValueError("secret-token postgres://private")
        data = EvaluationData("fake", "fake", fail)
        with self.assertRaisesRegex(DataUnavailable, "^provider_request_failed$"):
            data.calendar(REPORT["issued_at"])
        outcome = CorrectEvaluator(None, data, "2026-10-16T20:16:00Z").evaluate_report(REPORT)
        self.assertEqual(outcome["state"], "unavailable")
        self.assertNotIn("secret-token", str(outcome))
        self.assertIsNone(outcome["net_return_pct"])
        with self.assertRaisesRegex(DataUnavailable, "missing_alpaca_credentials"):
            EvaluationData(None, "fake", lambda *args: self.fail("unexpected request")).calendar(REPORT["issued_at"])

    def test_future_or_partial_provider_bars_are_rejected(self):
        for timestamp in ("2026-10-19T04:00:00Z", "2099-01-01T05:00:00Z"):
            def get(url, params, headers):
                return {"bars": {"NVDA": [{"t": timestamp, "o": 100, "h": 101, "l": 99, "c": 100, "v": 1}]}}
            data = EvaluationData("fake", "fake", get)
            with self.assertRaises(DataUnavailable):
                data.history(REPORT, SESSIONS, "2026-10-16T20:16:00Z")

    def test_timezone_dst_early_close_and_horizon(self):
        days = ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]
        data = EvaluationData("fake", "fake", lambda *args: [{"date": d, "open": "09:30", "close": "13:00" if d == days[0] else "16:00"} for d in days])
        sessions = data.calendar("2026-10-30T16:00:00Z")
        self.assertTrue(sessions[0]["close_at"].endswith("17:00:00+00:00"))
        self.assertTrue(sessions[1]["open_at"].endswith("14:30:00+00:00"))
        with self.assertRaisesRegex(DataUnavailable, "horizon"):
            data.calendar("2030-01-01T16:00:00Z")


if __name__ == "__main__":
    unittest.main()
