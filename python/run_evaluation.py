"""Evaluate saved stock plans under one versioned policy; explicit live command."""
import argparse
import os
from datetime import datetime, timezone
from pathlib import Path

def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    from database import Database
    from correct_evaluator import CorrectEvaluator
    from evaluation_data import EvaluationData
    from evaluation_policy import make_policy
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cutoff", help="Timezone-aware ISO timestamp; defaults to current UTC")
    parser.add_argument("--friction-bps", type=float, help="Explicit cost-policy variant")
    args = parser.parse_args()
    for key in ("DATABASE_URL", "ALPACA_API_KEY", "ALPACA_SECRET_KEY"):
        if not os.environ.get(key):
            parser.error(f"Missing {key}; use python python/demo.py for an offline example")
    db = Database(os.environ["DATABASE_URL"])
    evaluator = CorrectEvaluator(db, EvaluationData(os.environ["ALPACA_API_KEY"], os.environ["ALPACA_SECRET_KEY"]),
                                 args.cutoff, make_policy(args.friction_bps))
    if evaluator.cutoff > datetime.now(timezone.utc):
        parser.error("cutoff cannot be in the future")
    try:
        db.connect()
        if not db.validate_schema():
            parser.error("Portfolio schema is not current; run npm run db:migrate before evaluation")
        evaluator.run_evaluation()
    finally:
        db.close()

if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Evaluation failed; check configuration and saved evaluation evidence") from None
