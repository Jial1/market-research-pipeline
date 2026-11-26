import sys
import unittest
import psycopg2
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from database import Database, SCHEMA_MANIFEST


class SchemaVersionTests(unittest.TestCase):
    def database(self, *, rows=None, schema="portfolio_test", ledger=True):
        db = Database("unused")
        db.conn = Mock()
        db.cursor = Mock()
        db.cursor.fetchone.side_effect = [{"schema_name": schema}, {"ledger": "schema_migrations" if ledger else None}]
        db.cursor.fetchall.return_value = rows if rows is not None else [
            {"version": m["version"], "name": m["file"], "checksum": m["sha256"]} for m in SCHEMA_MANIFEST["migrations"]]
        return db

    def test_system_or_invalid_schema_is_rejected_before_ledger_access(self):
        for schema in [None, "pg_catalog", "information_schema", 'bad"; DROP TABLE x']:
            db = self.database(schema=schema)
            self.assertFalse(db.validate_schema())
            self.assertEqual(db.cursor.execute.call_count, 1)

    def test_failed_schema_read_rolls_back_without_trying_to_migrate(self):
        db = self.database()
        db.cursor.execute.side_effect = psycopg2.ProgrammingError("unavailable history")
        self.assertFalse(db.validate_schema())
        db.conn.rollback.assert_called_once()


if __name__ == "__main__":
    unittest.main()
