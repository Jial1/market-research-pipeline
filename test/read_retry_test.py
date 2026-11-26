import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from read_retry import read_with_retry, retry_after


class ReadRetryTests(unittest.TestCase):
    def test_http_and_network_attempts(self):
        failures = [HTTPError("private", 429, "private", {"Retry-After": "2"}, None), URLError(TimeoutError())]
        waits, calls = [], []
        def action():
            calls.append(1)
            if failures:
                raise failures.pop(0)
            return {"ok": True}
        self.assertEqual(read_with_retry(action, sleep=waits.append, jitter=lambda: 0), {"ok": True})
        self.assertEqual(waits, [2, .5])
        self.assertEqual(len(calls), 3)

    def test_cap_and_permanent_or_long_delay(self):
        for code, after, attempts in [(500, None, 3), (403, None, 1), (429, "60", 1)]:
            calls = []
            def action():
                calls.append(1)
                raise HTTPError("private", code, "private", {"Retry-After": after} if after else {}, None)
            with self.assertRaises(HTTPError):
                read_with_retry(action, sleep=lambda ms: None)
            self.assertEqual(len(calls), attempts)
        self.assertEqual(retry_after("Wed, 21 Oct 2026 16:00:03 GMT", 1792598400), 3)
        self.assertIsNone(retry_after("invalid", 0))


if __name__ == "__main__":
    unittest.main()
