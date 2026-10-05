#!/usr/bin/env python3
"""Build California statewide officers' campaign totals from Cal-Access.

    python3 tools/build_ca_campaign.py <work-dir> [<dbwebexport.zip>]

Downloads the Secretary of State's Cal-Access export (about 1.6 GB, so this
runs in GitHub Actions: see .github/workflows/ca-campaign.yml) and writes
data/ca-campaign.json: for each official in data/state-executive-officials.json,
the campaign committees they control and, for each committee, the totals on
its campaign statements (Form 460) since January 1, 2023.

How a statement is matched to an official: a Form 460 cover page filed by a
candidate or candidate-controlled committee (entity CAO or CTL) that names the
official as the candidate: same last name, and a first name that matches.
Amended statements replace the statement they amend.

The totals are the statement's own Summary Page figures for the period it
covers (column A):
  line 5   total contributions received
  line 11  total expenditures made
  line 16  ending cash balance
Nothing is computed beyond picking those lines. No contributor is read or named.

Source (public, California Secretary of State):
  https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip
  (the raw data behind https://cal-access.sos.ca.gov/)

Cal-Access is being replaced by the CAL-ACCESS Replacement System (CARS) after
the November 2026 election; this tool reads Cal-Access's export until then.

Standard library only.
"""
import csv
import io
import json
import re
import sys
import unicodedata
import urllib.request
import zipfile
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPORT = "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip"
COMMITTEE_PAGE = "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id={}"
STATEMENT_PDF = "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid={}&amendid={}"
SINCE = "2023-01-01"
LINES = {"5": "contributions", "11": "expenditures", "16": "cash_end"}
MAX_REPORTS = 12  # per committee, newest first

csv.field_size_limit(10**9)


def fold(s):
    s = unicodedata.normalize("NFD", s or "")
    return re.sub(r"[^a-z\- ]", "", "".join(c for c in s if unicodedata.category(c) != "Mn").lower()).strip()


SUFFIX = re.compile(r"^(jr|sr|ii|iii|iv)\.?$", re.I)


def name_parts(name):
    words = [w for w in re.split(r"[\s,]+", name or "") if w and not SUFFIX.match(w)]
    words = [w for w in words if not re.fullmatch(r"[A-Z]\.", w)]  # middle initials
    return (fold(words[0]), fold(words[-1])) if len(words) >= 2 else None


def first_matches(a, b):
    return bool(a and b) and (a == b or (len(a) > 2 and b.startswith(a)) or (len(b) > 2 and a.startswith(b)))


def iso(d):
    """'1/22/2000 12:00:00 AM' -> '2000-01-22'."""
    d = (d or "").strip()
    if not d:
        return None
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y"):
        try:
            return datetime.strptime(d, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def rows(zf, table):
    member = next(n for n in zf.namelist() if n.upper().endswith(f"/{table}.TSV"))
    with zf.open(member) as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding="latin-1", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)
        for r in reader:
            if len(r) >= len(header):
                yield dict(zip(header, r))


def money(x):
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return None


def build(zip_path, officials):
    people = []
    for o in officials:
        p = name_parts(o.get("name", ""))
        if p and o.get("office_key"):
            people.append({"office_key": o["office_key"], "name": o["name"], "first": p[0], "last": p[1]})
    by_last = {}
    for p in people:
        by_last.setdefault(p["last"], []).append(p)

    zf = zipfile.ZipFile(zip_path)
    # 1. Form 460 cover pages naming an official as the candidate; the latest amendment of each.
    covers = {}
    for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
        if r["FORM_TYPE"] != "F460" or r["ENTITY_CD"] not in ("CAO", "CTL"):
            continue
        cands = by_last.get(fold(r["CAND_NAML"]))
        if not cands:
            continue
        thru = iso(r["THRU_DATE"])
        if not thru or thru < SINCE:
            continue
        who = next((p for p in cands if first_matches(fold((r["CAND_NAMF"] or "").split(" ")[0]), p["first"])), None)
        if not who:
            continue
        fid, amend = r["FILING_ID"], int(r["AMEND_ID"] or 0)
        prev = covers.get(fid)
        if prev and prev["amend_id"] >= amend:
            continue
        covers[fid] = {
            "office_key": who["office_key"], "filing_id": fid, "amend_id": amend, "filer_id": r["FILER_ID"],
            "committee": (r["FILER_NAML"] or "").strip(), "from": iso(r["FROM_DATE"]), "thru": thru, "filed": iso(r["RPT_DATE"]),
        }
    # 2. Their Summary Page lines 5, 11 and 16 (column A, this period).
    want = {(c["filing_id"], str(c["amend_id"])) for c in covers.values()}
    for r in rows(zf, "SMRY_CD"):
        if r["FORM_TYPE"] != "F460" or r["LINE_ITEM"] not in LINES:
            continue
        if (r["FILING_ID"], r["AMEND_ID"]) in want:
            covers[r["FILING_ID"]][LINES[r["LINE_ITEM"]]] = money(r["AMOUNT_A"])

    out = {}
    for p in people:
        mine = [c for c in covers.values() if c["office_key"] == p["office_key"]]
        committees = {}
        for c in mine:
            k = committees.setdefault(c["filer_id"], {"filer_id": c["filer_id"], "name": c["committee"], "source_url": COMMITTEE_PAGE.format(c["filer_id"]), "reports": []})
            k["name"] = k["name"] or c["committee"]
            k["reports"].append({
                "filing_id": c["filing_id"], "amend_id": c["amend_id"], "from": c["from"], "thru": c["thru"], "filed": c["filed"],
                "contributions": c.get("contributions"), "expenditures": c.get("expenditures"), "cash_end": c.get("cash_end"),
                "source_url": STATEMENT_PDF.format(c["filing_id"], c["amend_id"]),
            })
        for k in committees.values():
            k["reports"] = sorted(k["reports"], key=lambda x: (x["thru"], x["from"] or ""), reverse=True)[:MAX_REPORTS]
        out[p["office_key"]] = {"name": p["name"], "committees": sorted(committees.values(), key=lambda k: k["reports"][0]["thru"] if k["reports"] else "", reverse=True)}
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1])
    work.mkdir(parents=True, exist_ok=True)
    zip_path = Path(sys.argv[2]) if len(sys.argv) > 2 else work / "dbwebexport.zip"
    modified = None
    if not zip_path.exists():
        req = urllib.request.Request(EXPORT, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
        with urllib.request.urlopen(req) as res, open(zip_path, "wb") as f:
            modified = res.headers.get("Last-Modified")
            while chunk := res.read(1 << 20):
                f.write(chunk)
    officials = json.loads((ROOT / "data/state-executive-officials.json").read_text())["officials"]
    data = build(zip_path, officials)
    doc = {
        "_readme": "Generated by tools/build_ca_campaign.py from the Cal-Access export; don't edit by hand. Form 460 Summary Page totals (lines 5, 11, 16, this period) for committees controlled by each statewide officer, since " + SINCE + ".",
        "source": EXPORT,
        "export_modified": modified,
        "generated": date.today().isoformat(),
        "officials": data,
    }
    (ROOT / "data/ca-campaign.json").write_text(json.dumps(doc, indent=1) + "\n")
    for k, v in data.items():
        print(f"{k}: {len(v['committees'])} committee(s), {sum(len(c['reports']) for c in v['committees'])} statement(s)")


if __name__ == "__main__":
    main()
