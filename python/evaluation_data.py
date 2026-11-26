"""Bounded read-only Alpaca calendar/candles. Provider errors never expose URLs/keys."""
import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from evaluation_policy import NY, iso_time, POLICY
from read_retry import read_with_retry


class DataUnavailable(Exception):
    def __init__(self, reason, evidence=None):
        super().__init__(reason)
        self.evidence = evidence or {}


def read_json(url, params, headers):
    request = Request(url + "?" + urlencode(params), headers=headers)
    with urlopen(request, timeout=10) as response:
        return json.load(response)


class EvaluationData:
    def __init__(self, key, secret, get=read_json):
        self.headers = {"APCA-API-KEY-ID": key or "", "APCA-API-SECRET-KEY": secret or ""}
        self.get = get
        self.cache = {}

    def _request(self, url, params):
        if not all(self.headers.values()):
            raise DataUnavailable("missing_alpaca_credentials")
        try:
            return read_with_retry(lambda: self.get(url, params, self.headers))
        except Exception:
            raise DataUnavailable("provider_request_failed") from None

    def calendar(self, issued_at):
        issued_day = iso_time(issued_at).astimezone(NY).date()
        start, end = issued_day - timedelta(days=7), issued_day + timedelta(days=21)
        if start.year < 1970 or end.year > 2029:
            raise DataUnavailable("calendar_outside_qualified_horizon")
        key = ("calendar", start, end)
        if key in self.cache:
            return self.cache[key]
        rows = self._request("https://paper-api.alpaca.markets/v2/calendar", {"start": start.isoformat(), "end": end.isoformat()})
        try:
            if not isinstance(rows, list) or not rows:
                raise ValueError()
            sessions = []
            for row in rows:
                day = date.fromisoformat(row["date"])
                if not start <= day <= end or (sessions and row["date"] <= sessions[-1]["date"]):
                    raise ValueError()
                def local_time(field):
                    if not re.fullmatch(r"\d{2}:\d{2}", row[field]):
                        raise ValueError()
                    return datetime.fromisoformat(f'{day}T{row[field]}').replace(tzinfo=NY).astimezone(timezone.utc).isoformat()
                opening, close = local_time("open"), local_time("close")
                if opening >= close:
                    raise ValueError()
                sessions.append({"date": day.isoformat(), "open_at": opening, "close_at": close})
            if not any(s["date"] <= issued_day.isoformat() for s in sessions) or sum(s["date"] > issued_day.isoformat() for s in sessions) < 5:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise DataUnavailable("invalid_calendar") from None
        self.cache[key] = sessions
        return sessions

    def _bars(self, symbol, start, end, adjustment, asof):
        key = (symbol, start, end, adjustment, asof)
        if key in self.cache:
            return self.cache[key]
        rows, seen, token = [], set(), None
        for _ in range(5):
            params = {"symbols": symbol, "timeframe": "1Day", "feed": "sip", "adjustment": adjustment,
                      "start": start, "end": end, "asof": asof, "sort": "asc", "limit": 1000}
            if token:
                params["page_token"] = token
            payload = self._request("https://data.alpaca.markets/v2/stocks/bars", params)
            try:
                bars = payload["bars"]
                if not isinstance(bars, dict) or set(bars) - {symbol} or not isinstance(bars.get(symbol, []), list):
                    raise ValueError()
                rows.extend(bars.get(symbol, []))
                token = payload.get("next_page_token")
                if not token:
                    break
                if not isinstance(token, str) or token in seen:
                    raise ValueError()
                seen.add(token)
            except (KeyError, TypeError, ValueError):
                raise DataUnavailable("invalid_history_response") from None
        else:
            raise DataUnavailable("incomplete_history_pagination")
        self.cache[key] = rows
        return rows

    def history(self, report, sessions, cutoff, policy=POLICY):
        symbol = report["symbol"]
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol):
            raise DataUnavailable("invalid_symbol")
        issued_day = iso_time(report["issued_at"]).astimezone(NY).date().isoformat()
        # Include last pre-eligibility session as a corporate-action basis check.
        baseline = [s for s in sessions if s["date"] <= issued_day][-1]
        window = [s for s in sessions if s["date"] > issued_day][:5]
        safe = iso_time(cutoff) - timedelta(minutes=policy["history_delay_minutes"])
        completed = [s for s in window if iso_time(s["close_at"]) <= safe]
        if not completed:
            return [], {"source": "alpaca", "feed": "sip", "reason": "no_completed_eligible_session"}
        start = datetime.fromisoformat(baseline["date"]).replace(tzinfo=NY).astimezone(timezone.utc).isoformat()
        end = completed[-1]["close_at"]
        raw = self._bars(symbol, start, end, "raw", issued_day)
        split = self._bars(symbol, start, end, "split", issued_day)
        allowed = {s["date"] for s in sessions if baseline["date"] <= s["date"] <= completed[-1]["date"]}

        def normalize(rows):
            out, previous = [], None
            for bar in rows:
                timestamp = iso_time(bar["t"])
                day = timestamp.astimezone(NY).date().isoformat()
                if day not in allowed or timestamp > safe or (previous and day <= previous):
                    raise ValueError()
                values = [bar[k] for k in ("o", "h", "l", "c", "v")]
                if not all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v) for v in values):
                    raise ValueError()
                o, h, l, c, volume = values
                if min(o, h, l, c) <= 0 or volume < 0 or not l <= min(o, c) <= max(o, c) <= h:
                    raise ValueError()
                out.append({"date": day, "open": o, "high": h, "low": l, "close": c, "volume": volume})
                previous = day
            return out
        try:
            raw, split = normalize(raw), normalize(split)
            if [b["date"] for b in raw] != [b["date"] for b in split] or not raw or raw[0]["date"] != baseline["date"]:
                raise ValueError()
            ratios = [a["close"] / b["close"] for a, b in zip(raw, split)]
            if any(not math.isclose(r, ratios[0], rel_tol=1e-6) for r in ratios):
                raise DataUnavailable("split_crossing_requires_reconciliation",
                                      {"source": "alpaca", "feed": "sip", "raw": raw, "split": split, "ratios": ratios})
        except (KeyError, TypeError, ValueError):
            raise DataUnavailable("invalid_or_unmatched_history") from None
        return raw, {"source": "alpaca", "feed": "sip", "execution_adjustment": "raw",
                     "split_check": "stable_ratio", "asof": issued_day, "start": start, "end": end,
                     "raw": raw, "split": split}
