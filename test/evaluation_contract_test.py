"""Shared hand-calculated contracts, independent of the database and providers."""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from evaluation_contract import CONTRACT, TERMINAL
from evaluation_policy import POLICY
from metrics_calculator import summarize_corrected
from correct_evaluator import CorrectEvaluator

FIXTURES = json.loads((ROOT / "test/fixtures/evaluation-contract.json").read_text(encoding="utf-8"))


class EvaluationContractTests(unittest.TestCase):
    def test_shared_hand_calculated_metrics_and_python_details(self):
        self.assertEqual(CONTRACT["version"], FIXTURES["contract_version"])
        before = copy.deepcopy(FIXTURES)
        for case in FIXTURES["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(summarize_corrected([FIXTURES["rows"][name] for name in case["row_names"]], POLICY["version"]),
                                 case["expected_common"] | case["expected_python"])
        self.assertEqual(FIXTURES, before)

    def test_shared_orders_and_outcome_lifecycle(self):
        self.assertEqual(POLICY["version"], FIXTURES["policy_version"])
        for row in FIXTURES["orders"]:
            self.assertEqual(POLICY["orders"].get(f'{row["trade_direction"]}:{row["entry_prediction"]}'), row["order_type"])
        self.assertEqual(TERMINAL, {"won", "lost", "time_exit", "expired", "invalidated", "research_only"})
        self.assertTrue(TERMINAL.isdisjoint(CONTRACT["retryable_states"]))

    def test_changed_issuance_policy_is_rejected_before_provider_reads(self):
        class NoReads:
            def calendar(self, *args):
                raise AssertionError("Mismatched policy must not request data")
        changed = copy.deepcopy(POLICY)
        changed["holding_sessions"] += 1
        result = CorrectEvaluator(None, NoReads(), "2026-11-20T20:16:00Z").evaluate_report({"evaluation_policy": changed})
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["reason"], "issuance_policy_mismatch")
        self.assertIsNone(result["net_return_pct"])


if __name__ == "__main__":
    unittest.main()
