"""Called by the Node integration test; saved Node plans become Python outcomes."""
import copy
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import psycopg2
from psycopg2.extras import RealDictCursor
from database import Database
from correct_evaluator import CorrectEvaluator
from evaluation_policy import POLICY, make_policy, iso_time

def main():
    url, schema = os.environ["TEST_DATABASE_URL"], os.environ["TEST_SCHEMA"]
    assert urlparse(url).hostname in {"localhost", "127.0.0.1", "::1"}
    assert re.fullmatch(r"portfolio_test_[a-f0-9]{12}", schema)
    db = Database(url)
    db.conn = psycopg2.connect(url, options=f"-c search_path={schema},public")
    db.cursor = db.conn.cursor(cursor_factory=RealDictCursor)
    try:
        assert db.validate_schema(), "Node and Python must agree on migration history"
        db.cursor.execute("SELECT r.*,runs.output AS saved_output FROM trading_reports r JOIN report_runs runs ON runs.id=r.run_id")
        for plan in db.cursor.fetchall():
            output = plan["saved_output"]
            proposed = next(p for p in output["recommendations"] if p["symbol"] == plan["symbol"])
            for field in ("entry_price", "target_price", "stop_loss", "trade_direction", "entry_prediction", "order_type", "evaluation_policy"):
                assert plan[field] == proposed[field], f"Node/Python plan field mismatch: {field}"
            assert iso_time(plan["issued_at"]) == iso_time(output["issued_at"])
            assert str(plan["eligible_session"]) == output["eligible_session"]
        db.cursor.execute("SELECT snapshot FROM report_runs LIMIT 1")
        calendar = db.cursor.fetchone()["snapshot"]["inputs"]["evidence"]["calendar"]["sessions"]
        class Data:
            def calendar(self, issued):
                return calendar
            def history(self, plan, sessions, cutoff, policy):
                entry, target = plan["entry_price"], plan["target_price"]
                bars = [{"date": str(plan["eligible_session"]), "open": entry, "high": target + 1,
                         "low": entry - .1, "close": target}]
                return bars, {"source": "synthetic", "candles": bars}
        evaluator = CorrectEvaluator(db, Data(), "2026-10-22T20:16:00Z")
        assert evaluator.run_evaluation() == 1
        rows = db.get_correct_outcomes(evaluator.cutoff, POLICY["version"])
        assert len(rows) == 1 and rows[0]["state"] == "won"
        original = rows[0]
        # A later attempt cannot rewrite a terminal result.
        changed = copy.deepcopy(original["details"])
        changed.update(state="lost", net_return_pct=-99, cutoff="2026-10-23T20:16:00Z")
        db.store_correct_outcome(original["report_id"], changed)
        assert db.get_correct_outcomes(evaluator.cutoff, POLICY["version"])[0]["net_return_pct"] == original["net_return_pct"]
        assert evaluator.run_evaluation() == 0
        variant = CorrectEvaluator(db, Data(), evaluator.cutoff, make_policy(8))
        assert variant.run_evaluation() == 1
        assert db.get_correct_outcomes(evaluator.cutoff, POLICY["version"])[0]["net_return_pct"] == original["net_return_pct"]
    finally:
        db.close()

if __name__ == "__main__":
    main()
