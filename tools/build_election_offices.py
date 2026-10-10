#!/usr/bin/env python3
"""Each state's official election office website, from USA.gov's directory of
state election offices (https://www.usa.gov/state-election-office), written to
data/states/election-offices.json. Standard library only. Runs weekly in the
"Refresh state officials" workflow.

    python3 tools/build_election_offices.py
    python3 tools/build_election_offices.py --from saved.html
"""
import argparse
import datetime
import html
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "states" / "election-offices.json"
SOURCE = "https://www.usa.gov/state-election-office"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"


def offices(page):
    """{"WA": {"name": "Washington", "url": "https://www.sos.wa.gov/elections"}} from the directory's links ("Washington (WA)")."""
    out = {}
    for url, label in re.findall(r'<a[^>]+href="(https?://[^"]+)"[^>]*>\s*([^<]+?)\s*</a>', page):
        m = re.fullmatch(r"(.+?) \(([A-Z]{2})\)", html.unescape(label).strip())
        if m and "usa.gov" not in url:
            out[m.group(2)] = {"name": m.group(1), "url": html.unescape(url)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="saved")
    args = ap.parse_args()
    if args.saved:
        page = Path(args.saved).read_text(encoding="utf-8")
    else:
        with urllib.request.urlopen(urllib.request.Request(SOURCE, headers={"User-Agent": UA}), timeout=60) as r:
            page = r.read().decode("utf-8", "replace")
    found = offices(page)
    if len(found) < 50:
        raise SystemExit(f"only {len(found)} election offices found on {SOURCE}; nothing written")
    OUT.write_text(json.dumps({"source": SOURCE, "built_on": datetime.date.today().isoformat(), "offices": dict(sorted(found.items()))}, indent=1) + "\n")
    print(f"{len(found)} election offices")


if __name__ == "__main__":
    main()
