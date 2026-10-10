#!/usr/bin/env python3
"""Each state's 2026 U.S. Senate and U.S. House candidates from the Federal
Election Commission (api.open.fec.gov), for "Your ballot" before an address is
entered. Writes data/elections/federal-2026/<st>.json. Standard library only;
runs daily in the "Refresh election data" workflow (FEC_API_KEY, else DEMO_KEY).

Only the FEC's statutory candidates are kept (candidate_status "C": registered
and past the $5,000 threshold, active this cycle). Anyone can register with the
FEC, so the raw list includes people running for seats that aren't up this year
and people who never campaigned; the statutory filter drops them. It can still
include someone who lost a primary or withdrew, so the page says so and points
to the official sample ballot.

    python3 tools/build_federal_races.py
    python3 tools/build_federal_races.py --states WA,CA
"""
import argparse
import datetime
import json
import os
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "elections" / "federal-2026"
API = "https://api.open.fec.gov/v1/candidates/"
RACES = "https://api.open.fec.gov/v1/elections/search/"
YEAR = 2026
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
          "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
          "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR"]


def get(params, key, api=API):
    q = urllib.parse.urlencode({**params, "api_key": key, "per_page": 100, **({"sort": "name"} if api == API else {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{api}?{q}", headers={"User-Agent": UA}), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt == 3:
                raise SystemExit(f"FEC candidates for {params}: {type(e).__name__}")
            time.sleep(5 * (attempt + 1))


def candidates(st, office, key):
    out, page = [], 1
    while True:
        d = get({"state": st, "office": office, "election_year": YEAR, "candidate_status": "C", "is_active_candidate": "true", "page": page}, key)
        out += d["results"]
        if page >= d["pagination"]["pages"]:
            return out
        page += 1
        time.sleep(0.5)


def row(c):
    return {
        "id": c["candidate_id"],
        "name": c["name"],                     # as filed with the FEC ("LAST, FIRST")
        "party": c.get("party_full") or "",    # as filed
        "incumbent": c.get("incumbent_challenge") == "I",
        "url": f"https://www.fec.gov/data/candidate/{c['candidate_id']}/",
    }


def senate_up(st, key):
    """True if the FEC lists a U.S. Senate race in this state this cycle (a regular or special election)."""
    d = get({"state": st, "cycle": YEAR}, key, RACES)
    offices = {str(r.get("office") or "").upper()[:1] for r in d.get("results", [])}
    if not offices and st not in ("PR",):
        raise SystemExit(f"FEC elections search for {st}: no races listed; the API may have changed")
    return "S" in offices


def build(st, key):
    # Candidates who registered for a seat that isn't up this year are left out with the race.
    up = senate_up(st, key)
    senate = [row(c) for c in candidates(st, "S", key)] if up else []
    house = defaultdict(list)
    for c in candidates(st, "H", key):
        house[str(int(c.get("district") or 0))].append(row(c))
    # One entry a candidate (the FEC can list the same candidate twice).
    dedupe = lambda xs: list({x["id"]: x for x in xs}.values())
    return {
        "state": st,
        "year": YEAR,
        "source": "Federal Election Commission, candidate filings (statutory candidates active in 2026)",
        "source_url": f"https://www.fec.gov/data/candidates/?election_year={YEAR}&state={st}&candidate_status=C",
        "built_on": datetime.date.today().isoformat(),
        "senate_up": up,
        "senate": dedupe(senate),
        "house": {d: dedupe(xs) for d, xs in sorted(house.items(), key=lambda kv: int(kv[0]))},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", default="")
    args = ap.parse_args()
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    states = [s.strip().upper() for s in args.states.split(",") if s.strip()] or STATES
    OUT.mkdir(parents=True, exist_ok=True)
    for st in states:
        data = build(st, key)
        (OUT / f"{st.lower()}.json").write_text(json.dumps(data, indent=1) + "\n")
        print(f"{st}: Senate {len(data['senate'])}, House {sum(len(v) for v in data['house'].values())} in {len(data['house'])} districts")
        time.sleep(0.5)


if __name__ == "__main__":
    main()
