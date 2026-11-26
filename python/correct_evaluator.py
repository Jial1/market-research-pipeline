"""Opt-in orchestration for corrected outcomes. Legacy results remain untouched."""
import hashlib
import json
from datetime import datetime, timezone
from evaluation_policy import POLICY, evaluate_path, iso_time, NY
from evaluation_data import DataUnavailable
from metrics_calculator import summarize_corrected


class CorrectEvaluator:
    def __init__(self, db, data, cutoff=None, policy=None):
        self.db, self.data = db, data
        self.cutoff = iso_time(cutoff or datetime.now(timezone.utc))
        self.policy = policy or POLICY

    def evaluate_report(self, report):
        sessions, candles, evidence = [], [], {}
        try:
            # Issuance policy must exist; cost sensitivity may use an explicit variant.
            original = report.get("evaluation_policy")
            expected = dict(self.policy, version=POLICY["version"], friction_bps_per_side=POLICY["friction_bps_per_side"])
            if original != expected:
                raise DataUnavailable("issuance_policy_mismatch")
            sessions = self.data.calendar(report["issued_at"])
            candles, evidence = self.data.history(report, sessions, self.cutoff, self.policy)
            result = evaluate_path(report, sessions, candles, self.cutoff, self.policy)
        except (DataUnavailable, KeyError, ValueError, TypeError) as error:
            if isinstance(error, DataUnavailable):
                evidence = error.evidence
            result = {"state": "unavailable", "reason": str(error) if isinstance(error, DataUnavailable) else "invalid_metadata",
                      "was_entry_hit": False, "gross_return_pct": None, "net_return_pct": None,
                      "ambiguous": False, "evaluation_version": self.policy["version"], "cutoff": self.cutoff.isoformat()}
        result["policy"] = self.policy
        result["evidence"] = {"calendar": sessions, "history": evidence}
        result["evidence_hash"] = hashlib.sha256(json.dumps(result["evidence"], sort_keys=True).encode()).hexdigest()
        return result

    def run_evaluation(self):
        reports = self.db.get_due_correct_reports(self.cutoff, self.policy["version"])
        for report in reports:
            result = self.evaluate_report(report)
            self.db.store_correct_outcome(report["id"], result)
            print(f'{report["symbol"]}: {result["state"]} ({result["reason"]})')
        summary = summarize_corrected(self.db.get_correct_outcomes(self.cutoff, self.policy["version"]), self.policy["version"])
        self.db.store_correct_metrics(self.cutoff.astimezone(NY).date(), self.policy["version"], summary)
        print(json.dumps(summary))
        return len(reports)
