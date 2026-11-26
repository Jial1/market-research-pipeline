const contract = require("../config/evaluation-contract.json");

// Cohort selection belongs to SQL; both languages use the same outcome groups.
function summarizeEvaluation(rows, version) {
  rows = rows.filter(row => row.evaluation_version === version);
  const scored = rows.filter(row => contract.scored_states.includes(row.state)
    && row.was_entry_hit && row.net_return_pct != null);
  return { evaluation_version: version, total_plans: rows.length, filled_closed: scored.length,
    pending: rows.filter(row => row.state === "pending").length,
    unavailable: rows.filter(row => row.state === "unavailable").length,
    unfilled_terminal: rows.filter(row => contract.unfilled_terminal_states.includes(row.state)).length,
    ambiguous_count: rows.filter(row => row.ambiguous).length,
    net_win_rate: scored.length ? scored.filter(row => row.net_return_pct > 0).length / scored.length : null,
    avg_net_return_pct: scored.length ? scored.reduce((sum, row) => sum + row.net_return_pct, 0) / scored.length : null };
}

module.exports = { summarizeEvaluation };
