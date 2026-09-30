#!/usr/bin/env python3
"""Build the ZIP code lookup data from Census Bureau files.

    python3 tools/build_zip_districts.py <work-dir>

Downloads (about 1.4 GB, so this runs in GitHub Actions: see
.github/workflows/zip-districts.yml) and writes:

  data/zip/<first 3 digits>.json   ZIP -> the districts it overlaps
  data/counties.json               county FIPS -> [name, state]

A ZIP code here is its Census ZIP Code Tabulation Area (ZCTA), the Census
Bureau's area for a ZIP code. Each 2020 census block is assigned to a ZCTA,
a county, a 119th Congress district and (in California) a 2024 state senate
and assembly district. For each ZCTA the file lists every combination of
those districts that covers at least 1% of its land area, with that share.
The site asks the visitor to choose, or to enter an address, whenever a ZIP
has more than one combination.

Sources (all public, U.S. Census Bureau):
  ZCTA to block:  https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tabblock20_natl.txt
  119th Congress: https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/119-congressional-district-befs/cd119.zip
  2024 state legislative districts:
                  https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/2024-state-legislative-bef/sldu24.zip
                  https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/2024-state-legislative-bef/sldl24.zip
  Counties:       https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt

Standard library only.
"""

import csv
import io
import json
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tabblock20_natl.txt"
BEF = "https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025"
CD = f"{BEF}/119-congressional-district-befs/cd119.zip"
SLDU = f"{BEF}/2024-state-legislative-bef/sldu24.zip"
SLDL = f"{BEF}/2024-state-legislative-bef/sldl24.zip"
COUNTIES = "https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt"
CA = "06"
MIN_SHARE = 0.01

STATE_BY_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
    "72": "PR", "78": "VI",
}


def fetch(url, work):
    out = work / url.rsplit("/", 1)[-1]
    if not out.exists():
        print(f"downloading {url}", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "ThePillory data build (+https://thepillory.co)"})
        with urllib.request.urlopen(req) as r, open(out, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    return out


def bef(path, only_state=None):
    """Block GEOID -> district code, from a block equivalency zip. The
    national file comes first; the per-state files (newer, e.g. after a
    court-ordered map) replace it for their states."""
    out = {}
    with zipfile.ZipFile(path) as z:
        names = sorted(z.namelist(), key=lambda n: (not n.startswith("National"), n))
        for name in names:
            if not name.endswith(".txt"):
                continue
            with z.open(name) as f:
                rows = csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig"))
                next(rows, None)
                for row in rows:
                    if len(row) < 2:
                        continue
                    geoid, code = row[0].strip(), row[1].strip()
                    if only_state and not geoid.startswith(only_state):
                        continue
                    out[geoid] = code
    print(f"{path.name}: {len(out)} blocks", flush=True)
    return out


def district_number(code):
    """'05' -> '5'; at-large ('00') and delegate ('98') -> '0'. Non-numeric codes -> ''."""
    if not code.isdigit():
        return ""
    n = int(code)
    return "0" if n in (0, 98) else str(n)


def main():
    work = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/zipbuild")
    work.mkdir(parents=True, exist_ok=True)

    counties = {}
    with open(fetch(COUNTIES, work), encoding="utf-8-sig") as f:
        for row in csv.DictReader(f, delimiter="|"):
            counties[row["STATEFP"] + row["COUNTYFP"]] = [row["COUNTYNAME"], row["STATE"]]
    (ROOT / "data" / "counties.json").write_text(
        json.dumps(dict(sorted(counties.items())), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(counties)} counties", flush=True)

    cd = bef(fetch(CD, work))
    su = bef(fetch(SLDU, work), only_state=CA)
    sl = bef(fetch(SLDL, work), only_state=CA)

    # ZCTA -> (st, cd, su, sl, county) -> land area
    area = defaultdict(lambda: defaultdict(float))
    with open(fetch(REL, work), encoding="utf-8-sig") as f:
        rows = csv.reader(f, delimiter="|")
        head = next(rows)
        iz, ib, ia = head.index("GEOID_ZCTA5_20"), head.index("GEOID_TABBLOCK_20"), head.index("AREALAND_PART")
        for row in rows:
            zcta, block = row[iz], row[ib]
            if not zcta or not block:
                continue
            st = STATE_BY_FIPS.get(block[:2])
            if not st:
                continue
            key = (
                st,
                district_number(cd.get(block, "")),
                district_number(su.get(block, "")) if block.startswith(CA) else "",
                district_number(sl.get(block, "")) if block.startswith(CA) else "",
                block[:5],
            )
            # Land area; a block with none (water) still counts a little, so a ZCTA of only water isn't lost.
            area[zcta][key] += max(float(row[ia] or 0), 1.0)

    by_prefix = defaultdict(dict)
    for zcta, combos in area.items():
        total = sum(combos.values())
        options = sorted(((a / total, k) for k, a in combos.items()), reverse=True)
        kept = [list(k) + [round(share, 3)] for share, k in options if share >= MIN_SHARE] or [list(options[0][1]) + [1.0]]
        by_prefix[zcta[:3]][zcta] = kept

    out = ROOT / "data" / "zip"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()
    for prefix, zips in sorted(by_prefix.items()):
        (out / f"{prefix}.json").write_text(
            json.dumps(dict(sorted(zips.items())), separators=(",", ":")) + "\n", encoding="utf-8")
    multi = sum(1 for zips in by_prefix.values() for o in zips.values() if len(o) > 1)
    print(f"{sum(len(z) for z in by_prefix.values())} ZIP areas in {len(by_prefix)} files; {multi} span more than one combination")


if __name__ == "__main__":
    main()
