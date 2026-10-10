#!/usr/bin/env python3
"""Every state's federal election dates (primaries, runoffs, specials and the
general; data/elections/dates.json, for when "Open your ballot" leads the home
page) and each state's 2026 U.S. Senate and U.S. House candidates from the Federal
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
DATES = "https://api.open.fec.gov/v1/election-dates/"
DATES_OUT = ROOT / "data" / "elections" / "dates.json"
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
            code = getattr(e, "code", "")
            if attempt == 3:
                hint = " (rate limited: set the FEC_API_KEY secret; DEMO_KEY allows very few requests)" if code == 429 else ""
                raise SystemExit(f"FEC {api.rsplit('/', 2)[-2]} for {params}: {type(e).__name__} {code}{hint}")
            time.sleep(15 * (attempt + 1))


def candidates(st, office, key):
    out, page = [], 1
    while True:
        d = get({"state": st, "office": office, "election_year": YEAR, "candidate_status": "C", "is_active_candidate": "true", "page": page}, key)
        out += d["results"]
        if page >= d["pagination"]["pages"]:
            return out
        page += 1
        time.sleep(0.5)


def committee(c):
    """The candidate's principal campaign committee (FEC designation P), as listed in their filing."""
    for m in c.get("principal_committees") or []:
        if m.get("designation") == "P" and m.get("committee_id"):
            return m["committee_id"]
    return None


def row(c):
    return {
        "id": c["candidate_id"],
        "name": c["name"],                     # as filed with the FEC ("LAST, FIRST")
        "party": c.get("party_full") or "",    # as filed
        "incumbent": c.get("incumbent_challenge") == "I",
        "url": f"https://www.fec.gov/data/candidate/{c['candidate_id']}/",
        "committee": committee(c),             # principal campaign committee ID (tools/build_candidates.mjs)
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


def election_dates(key, years):
    """Every federal election date the FEC lists for these years, by state: primaries, runoffs,
    special elections and the general election. One entry per state, date and kind of election."""
    by_state = {}
    for year in years:
        page = 1
        while True:
            d = get({"election_year": year, "page": page}, key, DATES)
            for r in d["results"]:
                st, day = (r.get("election_state") or "").upper(), str(r.get("election_date") or "")[:10]
                if not st or len(day) != 10:
                    continue
                district = str(r.get("election_district") or "").strip()
                district = "" if district in ("", "0", "00", "None") else str(int(district)) if district.isdigit() else district
                k = (day, r.get("election_type_id") or "", district)
                e = by_state.setdefault(st, {}).setdefault(k, {
                    "date": day,
                    "type": r.get("election_type_id") or "",
                    "name": r.get("election_type_full") or "",  # as the FEC words it
                    "district": district,                       # "" = statewide; else a U.S. House district
                    "offices": [],
                })
                office = {"S": "U.S. Senate", "H": "U.S. House", "P": "President"}.get(r.get("office_sought") or "")
                if office and office not in e["offices"]:
                    e["offices"].append(office)
            if page >= d["pagination"]["pages"]:
                break
            page += 1
            time.sleep(0.5)
    return {st: sorted(v.values(), key=lambda e: (e["date"], e["district"])) for st, v in sorted(by_state.items())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", default="")
    args = ap.parse_args()
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    states = [s.strip().upper() for s in args.states.split(",") if s.strip()] or STATES
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.states:
        dates = election_dates(key, [YEAR, YEAR + 1])
        if len(dates) < 50:
            raise SystemExit(f"FEC election dates: only {len(dates)} states listed; not written")
        DATES_OUT.write_text(json.dumps({
            "source": "Federal Election Commission, election dates",
            "source_url": f"https://www.fec.gov/data/elections/?cycle={YEAR}",
            "built_on": datetime.date.today().isoformat(),
            "states": dates,
        }, indent=1) + "\n")
        print(f"Election dates: {sum(len(v) for v in dates.values())} in {len(dates)} states")
    for st in states:
        data = build(st, key)
        (OUT / f"{st.lower()}.json").write_text(json.dumps(data, indent=1) + "\n")
        print(f"{st}: Senate {len(data['senate'])}, House {sum(len(v) for v in data['house'].values())} in {len(data['house'])} districts")
        time.sleep(0.5)


if __name__ == "__main__":
    main()
