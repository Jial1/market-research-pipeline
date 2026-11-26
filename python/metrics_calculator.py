"""Aggregate only filled terminal returns under one policy version."""
from evaluation_contract import CONTRACT

def summarize_corrected(rows, version):
    rows = [r for r in rows if r["evaluation_version"] == version]
    scored = [r for r in rows if r["state"] in CONTRACT["scored_states"] and r["was_entry_hit"] and r["net_return_pct"] is not None]
    returns = [r["net_return_pct"] for r in scored]
    return {"evaluation_version": version, "total_plans": len(rows), "filled_closed": len(scored),
            "pending": sum(r["state"] == "pending" for r in rows),
            "unavailable": sum(r["state"] == "unavailable" for r in rows),
            "unfilled_terminal": sum(r["state"] in CONTRACT["unfilled_terminal_states"] for r in rows),
            "filled_count": sum(r["was_entry_hit"] for r in rows),
            "ambiguous_count": sum(r["ambiguous"] for r in rows),
            "net_win_rate": sum(x > 0 for x in returns) / len(scored) if scored else None,
            "avg_net_return_pct": sum(returns) / len(scored) if scored else None,
            "avg_gross_return_pct": sum(r["gross_return_pct"] for r in scored) / len(scored) if scored else None,
            "cost_sensitivity": {name: sum(r["details"]["cost_sensitivity"][name] for r in scored) / len(scored) if scored else None
                                 for name in ("low", "base", "high")}}


