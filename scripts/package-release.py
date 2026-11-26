"""Create a clean source ZIP; omit credentials, dependencies and local run artifacts."""
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    subprocess.run(["node", "scripts/check-release.js"], cwd=ROOT, check=True)
    listing = subprocess.check_output([
        "node", "-e", "console.log(JSON.stringify(require('./scripts/check-release').files()))"
    ], cwd=ROOT, text=True)
    names = [Path(name) for name in json.loads(listing)]
    target = ROOT / "local-data/market-research-pipeline.zip"
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(names):
            archive.write(name, Path("market-research-pipeline") / name.relative_to(ROOT))
    print(f"Clean source archive: {target} ({len(names)} files)")

if __name__ == "__main__":
    main()
