"""PostgreSQL persistence for versioned recommendation evaluation."""
import json
import re
import psycopg2
from psycopg2.extras import RealDictCursor, Json
from pathlib import Path
from urllib.parse import urlparse, parse_qs

SCHEMA_MANIFEST = json.loads((Path(__file__).resolve().parents[1] / "config/database-schema.json").read_text(encoding="utf-8"))

class Database:
    def __init__(self, connection_string):
        self.connection_string = connection_string
        self.conn = None
        self.cursor = None

    def connect(self):
        """Establish a bounded PostgreSQL connection using the configured TLS mode."""
        try:
            self.conn = psycopg2.connect(
                self.connection_string,
                sslmode=parse_qs(urlparse(self.connection_string).query).get("sslmode", ["prefer"])[0],
                connect_timeout=10,
                options=parse_qs(urlparse(self.connection_string).query).get("options", [""])[0] + " -c statement_timeout=30000"
            )
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            print("Connected to database")
        except Exception as e:
            print("Database connection unavailable")
            raise

    def validate_schema(self):
        """Read the shared migration history; evaluation never applies DDL."""
        try:
            self.cursor.execute("SELECT current_schema() AS schema_name")
            schema = self.cursor.fetchone()["schema_name"]
            if not isinstance(schema, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema) or schema.lower().startswith("pg_") or schema.lower() == "information_schema":
                self.conn.rollback()
                return False
            self.cursor.execute("SELECT to_regclass(%s) AS ledger", (f'"{schema}".schema_migrations',))
            if not self.cursor.fetchone()["ledger"]:
                self.conn.commit()
                return False
            self.cursor.execute(f'SELECT version,name,checksum FROM "{schema}".schema_migrations ORDER BY version')
            rows = self.cursor.fetchall()
            expected = [{"version": m["version"], "name": m["file"], "checksum": m["sha256"]} for m in SCHEMA_MANIFEST["migrations"]]
            valid = rows == expected and all(type(row["version"]) is int for row in rows)
            self.conn.commit()
            return valid
        except psycopg2.Error:
            self.conn.rollback()
            return False

    def get_due_correct_reports(self, cutoff, version):
        self.cursor.execute("""
            SELECT r.* FROM trading_reports r
            LEFT JOIN recommendation_evaluations e ON e.report_id=r.id AND e.evaluation_version=%s
            WHERE r.run_id IS NOT NULL AND r.issued_at IS NOT NULL
              AND r.eligible_session IS NOT NULL AND r.evaluation_policy IS NOT NULL
              AND r.issued_at <= %s AND r.eligible_session <= (%s::timestamptz AT TIME ZONE 'America/New_York')::date
              AND (e.report_id IS NULL OR (NOT e.terminal AND e.cutoff <= %s))
            ORDER BY r.eligible_session, r.id
        """, (version, cutoff, cutoff, cutoff))
        rows = self.cursor.fetchall()
        self.conn.commit()  # Do not hold an idle read transaction across provider calls.
        return rows

    def store_correct_outcome(self, report_id, result):
        from evaluation_policy import TERMINAL
        try:
            self.cursor.execute("""
                INSERT INTO recommendation_evaluations
                  (report_id,evaluation_version,state,cutoff,terminal,was_entry_hit,gross_return_pct,net_return_pct,ambiguous,details)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(report_id,evaluation_version) DO UPDATE SET
                  state=EXCLUDED.state,cutoff=EXCLUDED.cutoff,terminal=EXCLUDED.terminal,
                  was_entry_hit=EXCLUDED.was_entry_hit,gross_return_pct=EXCLUDED.gross_return_pct,
                  net_return_pct=EXCLUDED.net_return_pct,ambiguous=EXCLUDED.ambiguous,
                  details=EXCLUDED.details,updated_at=now()
                WHERE NOT recommendation_evaluations.terminal AND EXCLUDED.cutoff >= recommendation_evaluations.cutoff
            """, (report_id, result["evaluation_version"], result["state"], result["cutoff"],
                  result["state"] in TERMINAL, result["was_entry_hit"], result["gross_return_pct"],
                  result["net_return_pct"], result["ambiguous"], Json(result)))
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def get_correct_outcomes(self, cutoff, version, *, issuance_days=None, namespace=""):
        self.cursor.execute("""SELECT e.* FROM recommendation_evaluations e
            JOIN trading_reports r ON r.id=e.report_id
            JOIN report_runs runs ON runs.id=r.run_id
            WHERE e.evaluation_version=%s AND e.cutoff <= %s AND r.issued_at <= %s
              AND COALESCE(runs.settings->>'runNamespace','')=%s
              AND (%s::int IS NULL OR r.issued_at >= %s::timestamptz-(%s::int * INTERVAL '24 hours'))""",
            (version, cutoff, cutoff, namespace, issuance_days, cutoff, issuance_days))
        return self.cursor.fetchall()

    def store_correct_metrics(self, day, version, summary):
        try:
            self.cursor.execute("""INSERT INTO evaluation_metrics(date,evaluation_version,summary) VALUES(%s,%s,%s)
                ON CONFLICT(date,evaluation_version) DO UPDATE SET summary=EXCLUDED.summary""", (day, version, Json(summary)))
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def close(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        print("Disconnected from database")
