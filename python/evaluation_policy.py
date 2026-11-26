"""Versioned, deterministic daily-bar model. No network or database access."""
import copy
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from evaluation_contract import TERMINAL

POLICY = json.loads((Path(__file__).resolve().parents[1] / "config/evaluation-policy.json").read_text())
NY = ZoneInfo("America/New_York")


def iso_time(value):
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone_required")
    return parsed.astimezone(timezone.utc)


def make_policy(base_bps=None):
    policy = copy.deepcopy(POLICY)
    if base_bps is not None and base_bps != policy["friction_bps_per_side"]["base"]:
        if not math.isfinite(base_bps) or not 0 <= base_bps <= 100:
            raise ValueError("invalid_friction")
        policy["friction_bps_per_side"]["base"] = base_bps
        policy["friction_bps_per_side"]["high"] = max(15, base_bps * 3)
        policy["version"] += f"-cost-{base_bps:g}"
    return policy


def evaluate_path(report, sessions, candles, cutoff, policy=None):
    policy = policy or POLICY
    cutoff = iso_time(cutoff)
    result = {"state": "pending", "reason": "awaiting_session", "was_entry_hit": False,
              "entry_date": None, "entry_price": None, "exit_date": None, "exit_price": None,
              "gross_return_pct": None, "net_return_pct": None, "cost_sensitivity": None,
              "ambiguous": False, "ambiguity_reasons": [], "mfe_pct": None, "mae_pct": None,
              "evaluation_version": policy["version"], "cutoff": cutoff.isoformat()}

    def finish(state, reason):
        result.update(state=state, reason=reason)
        return result

    try:
        issued = iso_time(report["issued_at"])
        eligible = str(report["eligible_session"])
        direction = report["trade_direction"]
        order = policy["orders"].get(f'{direction}:{report.get("entry_prediction")}')
        if not order or report.get("order_type") != order:
            return finish("research_only", "unsupported_entry_type")
        entry, target, stop = (float(report[k]) for k in ("entry_price", "target_price", "stop_loss"))
        if not all(math.isfinite(x) and x > 0 for x in (entry, target, stop)):
            raise ValueError()
        if not (target > entry > stop if direction == "long" else target < entry < stop):
            return finish("research_only", "invalid_geometry")
        if issued > cutoff:
            return finish("unavailable", "issuance_after_cutoff")
    except (KeyError, TypeError, ValueError):
        return finish("research_only", "missing_or_invalid_issuance_metadata")
    try:
        dates = [str(s["date"]) for s in sessions]
        if dates != sorted(set(dates)):
            raise ValueError()
        issued_day = issued.astimezone(NY).date().isoformat()
        expected = next(d for d in dates if d > issued_day)
        if eligible != expected:
            return finish("research_only", "eligibility_not_next_session")
        future = [s for s in sessions if str(s["date"]) >= eligible]
        # Three entry sessions plus two further sessions for the latest holding window.
        needed = policy["entry_sessions"] + policy["holding_sessions"] - 1
        if len(future) < needed:
            raise ValueError()
        window = future[:needed]
        safe_cutoff = cutoff - timedelta(minutes=policy["history_delay_minutes"])
        completed = [s for s in window if iso_time(s["close_at"]) <= safe_cutoff]
        bars = {}
        previous = None
        for candle in candles:
            day = str(candle["date"])
            if previous and day <= previous:
                raise ValueError()
            previous = day
            o, h, l, c = (candle[k] for k in ("open", "high", "low", "close"))
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 for v in (o, h, l, c)):
                raise ValueError()
            if not l <= min(o, c) <= max(o, c) <= h:
                raise ValueError()
            bars[day] = candle
    except (KeyError, TypeError, ValueError, StopIteration):
        return finish("unavailable", "calendar_or_history_invalid")

    sign = 1 if direction == "long" else -1
    entry_index = None
    for index, session in enumerate(completed):
        day = str(session["date"])
        bar = bars.get(day)
        if bar is None:
            return finish("unavailable", "missing_completed_session")
        o, h, l, c = (bar[k] for k in ("open", "high", "low", "close"))
        entered_now = entry_index is None
        at_open = False
        if entered_now:
            invalid_open = (o <= stop or o >= target) if direction == "long" else (o >= stop or o <= target)
            if invalid_open:
                return finish("invalidated", "opening_invalidates_plan")
            trigger_open = {"buy_stop": o >= entry, "buy_limit": o <= entry,
                            "sell_stop": o <= entry, "sell_limit": o >= entry}[order]
            touched = {"buy_stop": h >= entry, "buy_limit": l <= entry,
                       "sell_stop": l <= entry, "sell_limit": h >= entry}[order]
            if not trigger_open and not touched:
                if index + 1 == policy["entry_sessions"]:
                    return finish("expired", "entry_window_expired")
                continue
            fill = o if trigger_open and order.endswith("stop") else entry
            at_open = trigger_open
            entry_index = index
            result.update(was_entry_hit=True, entry_date=day, entry_price=fill)
        fill = result["entry_price"]
        stop_hit = l <= stop if direction == "long" else h >= stop
        target_hit = h >= target if direction == "long" else l <= target
        exit_price = None
        state, reason = None, None
        if not entered_now and (o <= stop if direction == "long" else o >= stop):
            exit_price, state, reason = o, "lost", "stop_gap"
        elif not entered_now and (o >= target if direction == "long" else o <= target):
            exit_price, state, reason = target, "won", "target_at_open"
        elif stop_hit:
            exit_price, state, reason = stop, "lost", "stop"
            if target_hit or (entered_now and not at_open):
                result["ambiguity_reasons"].append("stop_first_daily_order_unknown")
        elif target_hit and (not entered_now or at_open):
            exit_price, state, reason = target, "won", "target"
        elif target_hit:
            result["ambiguity_reasons"].append("entry_bar_target_deferred")
        if exit_price is None and index - entry_index + 1 >= policy["holding_sessions"]:
            exit_price, state, reason = c, "time_exit", "holding_window_ended"
        # Full extrema are unsafe before an intraday entry or after an intraday exit.
        points = [fill, exit_price if exit_price is not None else c]
        if (not entered_now or at_open) and (exit_price is None or state == "time_exit"):
            points += [h, l]
        moves = [(p - fill) / fill * 100 * sign for p in points]
        result["mfe_pct"] = max([result["mfe_pct"] or 0] + moves)
        result["mae_pct"] = min([result["mae_pct"] or 0] + moves)
        result["ambiguous"] = bool(result["ambiguity_reasons"])
        if exit_price is not None:
            gross = (exit_price - fill) / fill * 100 * sign
            costs = {k: gross - 2 * v / 100 for k, v in policy["friction_bps_per_side"].items()}
            result.update(exit_date=day, exit_price=exit_price, gross_return_pct=gross,
                          net_return_pct=costs["base"], cost_sensitivity=costs)
            return finish(state, reason)
    result["ambiguous"] = bool(result["ambiguity_reasons"])
    return finish("pending", "position_open" if result["was_entry_hit"] else "awaiting_entry")
