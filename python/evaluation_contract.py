"""Language-neutral outcome groups; execution assumptions remain in evaluation-policy.json."""
import json
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "config/evaluation-contract.json").read_text(encoding="utf-8"))
TERMINAL = set(CONTRACT["scored_states"] + CONTRACT["unfilled_terminal_states"])
