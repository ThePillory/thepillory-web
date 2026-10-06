#!/usr/bin/env python3
"""Build California campaign finance from Cal-Access.

    python3 tools/build_ca_campaign.py <work-dir> [<dbwebexport.zip>]

Downloads the Secretary of State's Cal-Access export (about 1.6 GB, so this
runs in GitHub Actions: see .github/workflows/ca-campaign.yml) and writes
<work-dir>/ca-campaign-raw.json, which tools/ca_campaign_finish.mjs turns into
data/ca-campaign.json (sorting employers and organizations into industries
with the same rules as federal funding).

Who:
  - each official in data/state-executive-officials.json (the Governor and
    the statewide offices), matched by name;
  - every candidate for the State Assembly or State Senate with a campaign
    statement since 2025, by seat ("ASM-8", "SEN-4"); the sync Worker matches
    each sitting legislator to their seat's entry by name.

For each, the campaign committees they control (a Form 460 cover page filed
by a candidate or candidate-controlled committee, entity CAO or CTL, naming
them as the candidate; for legislators, also naming their seat) and, by
two-year period (2023-2024, 2025-2026):
  - raised and spent: the sum of each statement's Summary Page lines 5 (total
    contributions received) and 11 (total expenditures made), column A;
  - contributions itemized on Schedule A (monetary contributions), latest
    amendment of each statement, memo entries left out, transfers between the
    official's own committees left out:
      individuals: only totals, and by employer (never by name, at any amount);
      organizations, businesses, committees and parties: by name;
  - independent expenditures for and against them reported on Form 496 (made
    within 90 days before an election, $1,000 or more), by spender.
Amended statements replace the statement they amend.

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
SEATS_SINCE = "2025-01-01"  # a legislative candidate is included when they filed a statement since then
CYCLES = (("2023-2024", "2023-01-01", "2024-12-31"), ("2025-2026", "2025-01-01", "2026-12-31"))
# Cal-Access office codes for the statewide offices (independent expenditures).
STATEWIDE_CODES = {"GOV", "LTG", "SOS", "CON", "TRE", "ATT", "INS", "SPI", "SPM", "SUP", "STW"}
# The race an independent expenditure was made in, as the report states it.
RACES = {"GOV": "Governor", "LTG": "Lieutenant Governor", "SOS": "Secretary of State", "CON": "Controller", "TRE": "Treasurer",
         "ATT": "Attorney General", "INS": "Insurance Commissioner", "SPI": "Superintendent of Public Instruction",
         "SPM": "Superintendent of Public Instruction", "SUP": "Superintendent of Public Instruction", "ASM": "State Assembly", "SEN": "State Senate"}
ORG_ENTITIES = {"COM": "committee", "SCC": "small contributor committee", "PTY": "political party", "OTH": "organization"}
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


def cycle_of(d):
    for name, a, b in CYCLES:
        if d and a <= d <= b:
            return name
    return None


def seat_of(r):
    """'ASM-8' from a cover's office and district, or None."""
    office = (r.get("OFFICE_CD") or r.get("JURIS_CD") or "").strip().upper()
    dist = (r.get("DIST_NO") or "").strip()
    if office in ("ASM", "SEN") and dist.isdigit() and int(dist) > 0:
        return f"{office}-{int(dist)}"
    return None


def employer_key(s):
    return re.sub(r"\s+", " ", re.sub(r"[.,]", "", (s or "").upper())).strip()


def new_person(name, first, last):
    return {"name": name, "first": first, "last": last, "filers": set(), "covers": {}}


def build(zip_path, officials):
    """Everything for data/ca-campaign.json, before industries: {"officials": {office_key: person}, "seats": {seat: [person]}}."""
    zf = zipfile.ZipFile(zip_path)

    # Statewide officials, by name.
    statewide = {}
    by_last = {}
    for o in officials:
        p = name_parts(o.get("name", ""))
        if p and o.get("office_key"):
            statewide[o["office_key"]] = new_person(o["name"], p[0], p[1])
            by_last.setdefault(p[1], []).append(statewide[o["office_key"]])

    # 1. Form 460 cover pages by candidate committees, latest amendment of each.
    #    Statewide officials: any cover naming them. Legislative candidates: by seat and name.
    seats = {}
    filer_covers = {}  # filer_id -> {filing_id: cover}
    ie_covers = {}     # F496 filing_id -> cover
    for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
        form = r["FORM_TYPE"]
        if form == "F496":
            filed = iso(r["RPT_DATE"])
            so = (r["SUP_OPP_CD"] or "").strip().upper()
            if not filed or filed < SINCE or so not in ("S", "O"):
                continue
            fid, amend = r["FILING_ID"], int(r["AMEND_ID"] or 0)
            prev = ie_covers.get(fid)
            if prev and prev["amend_id"] >= amend:
                continue
            ie_covers[fid] = {
                "filing_id": fid, "amend_id": amend, "filer_id": r["FILER_ID"], "spender": (r["FILER_NAML"] or "").strip(),
                "filed": filed, "support_oppose": "support" if so == "S" else "oppose", "seat": seat_of(r),
                "office": (r["OFFICE_CD"] or r["JURIS_CD"] or "").strip().upper(),
                "cand": fold(f'{r["CAND_NAMF"] or ""} {r["CAND_NAML"] or ""}'),
            }
            continue
        if form != "F460" or r["ENTITY_CD"] not in ("CAO", "CTL"):
            continue
        thru = iso(r["THRU_DATE"])
        if not thru or thru < SINCE:
            continue
        first, last = fold((r["CAND_NAMF"] or "").split(" ")[0]), fold(r["CAND_NAML"])
        fid, amend = r["FILING_ID"], int(r["AMEND_ID"] or 0)
        cover = {
            "filing_id": fid, "amend_id": amend, "filer_id": r["FILER_ID"], "committee": (r["FILER_NAML"] or "").strip(),
            "from": iso(r["FROM_DATE"]), "thru": thru, "filed": iso(r["RPT_DATE"]),
        }
        prev = filer_covers.setdefault(r["FILER_ID"], {}).get(fid)
        if not prev or prev["amend_id"] < amend:
            filer_covers[r["FILER_ID"]][fid] = cover
        # Who this committee belongs to.
        for p in by_last.get(last, []):
            if first_matches(first, p["first"]):
                p["filers"].add(r["FILER_ID"])
        seat = seat_of(r)
        if seat and last and thru >= SEATS_SINCE:
            people = seats.setdefault(seat, [])
            who = next((p for p in people if p["last"] == last and first_matches(first, p["first"])), None)
            if not who:
                display = " ".join(x for x in [(r["CAND_NAMF"] or "").strip(), (r["CAND_NAML"] or "").strip()] if x)
                who = new_person(display, first, last)
                people.append(who)
            who["filers"].add(r["FILER_ID"])

    everyone = list(statewide.values()) + [p for people in seats.values() for p in people]
    for p in everyone:
        for f in p["filers"]:
            for c in filer_covers.get(f, {}).values():
                p["covers"][c["filing_id"]] = c

    # 2. Summary Page lines 5, 11 and 16 (column A, this period) of those statements.
    want = {}
    for p in everyone:
        for c in p["covers"].values():
            want[(c["filing_id"], str(c["amend_id"]))] = c
    for r in rows(zf, "SMRY_CD"):
        if r["FORM_TYPE"] != "F460" or r["LINE_ITEM"] not in LINES:
            continue
        c = want.get((r["FILING_ID"], r["AMEND_ID"]))
        if c is not None:
            c[LINES[r["LINE_ITEM"]]] = money(r["AMOUNT_A"])

    # 3. Schedule A contributions on those statements. Individuals are kept only as
    #    totals and by employer; organizations by name.
    owner = {}
    for p in everyone:
        for c in p["covers"].values():
            owner.setdefault((c["filing_id"], str(c["amend_id"])), []).append(p)
    for p in everyone:
        p["money"] = {}

    def bucket(p, cyc):
        return p["money"].setdefault(cyc, {"individuals": {"total": 0.0, "count": 0}, "employers": {}, "organizations": {}, "ie": {}})

    for r in rows(zf, "RCPT_CD"):
        if r["FORM_TYPE"] != "A" or (r["MEMO_CODE"] or "").strip():
            continue
        people = owner.get((r["FILING_ID"], r["AMEND_ID"]))
        if not people:
            continue
        amount = money(r["AMOUNT"])
        cyc = cycle_of(iso(r["RCPT_DATE"]))
        if amount is None or not cyc:
            continue
        for p in people:
            if (r["CMTE_ID"] or "").strip() in p["filers"]:
                continue  # a transfer between the official's own committees
            b = bucket(p, cyc)
            if r["ENTITY_CD"] == "IND":
                # A refund is a negative row: it nets against the totals, but it isn't a contribution.
                b["individuals"]["total"] += amount
                b["individuals"]["count"] += amount > 0
                emp = employer_key(r["CTRIB_EMP"])
                e = b["employers"].setdefault(emp, {"employer": emp, "total": 0.0, "count": 0, "occupations": {}})
                e["total"] += amount
                e["count"] += amount > 0
                occ = employer_key(r["CTRIB_OCC"])
                if occ:
                    e["occupations"][occ] = e["occupations"].get(occ, 0) + 1
            else:
                name = re.sub(r"\s+", " ", " ".join(x for x in [(r["CTRIB_NAMF"] or "").strip(), (r["CTRIB_NAML"] or "").strip()] if x)).strip()
                if not name:
                    continue
                o = b["organizations"].setdefault(name.upper(), {"name": name, "kind": ORG_ENTITIES.get(r["ENTITY_CD"], "organization"), "total": 0.0, "count": 0, "filer_id": (r["CMTE_ID"] or "").strip() or None})
                o["total"] += amount
                o["count"] += amount > 0

    # 4. Independent expenditures (Form 496): the amounts, and who they were for or against.
    ie_amount = {}
    for r in rows(zf, "S496_CD"):
        c = ie_covers.get(r["FILING_ID"])
        if c and str(c["amend_id"]) == r["AMEND_ID"]:
            a = money(r["AMOUNT"])
            if a is not None:
                ie_amount[r["FILING_ID"]] = ie_amount.get(r["FILING_ID"], 0.0) + a
                d = iso(r["EXP_DATE"])
                if d:
                    c["first"] = min(c.get("first") or d, d)
                    c["last"] = max(c.get("last") or d, d)

    def named(p, words):
        return p["last"] in words and (not p["first"] or any(first_matches(w, p["first"]) for w in words) or len(words) == 1)

    def ie_target(c):
        words = set(c["cand"].split())
        if c["seat"]:
            return next((p for p in seats.get(c["seat"], []) if named(p, words)), None)
        if c["office"] in ("ASM", "SEN"):
            # No district on the report: the one candidate for that chamber with this name, if only one.
            found = [p for seat, people in seats.items() if seat.startswith(c["office"]) for p in people if named(p, words)]
            return found[0] if len(found) == 1 else None
        if c["office"] in STATEWIDE_CODES:
            for p in statewide.values():
                if p["last"] in words and (p["first"] in words or any(first_matches(w, p["first"]) for w in words)):
                    return p
        return None

    for fid, c in ie_covers.items():
        total = ie_amount.get(fid)
        p = ie_target(c)
        cyc = cycle_of(c.get("last") or c["filed"])
        if not total or not p or not cyc:
            continue
        b = bucket(p, cyc)
        key = (c["filer_id"], c["support_oppose"], c["office"])
        x = b["ie"].setdefault(key, {"spender": c["spender"], "filer_id": c["filer_id"], "support_oppose": c["support_oppose"], "race": RACES.get(c["office"]), "total": 0.0, "filings": 0, "first": None, "last": None, "source_url": COMMITTEE_PAGE.format(c["filer_id"])})
        x["total"] += total
        x["filings"] += 1
        for k, f in (("first", min), ("last", max)):
            v = c.get(k) or c["filed"]
            x[k] = f(x[k], v) if x[k] else v

    # 5. Out: committees with their statements, and money by period.
    def out(p):
        committees = {}
        for c in p["covers"].values():
            k = committees.setdefault(c["filer_id"], {"filer_id": c["filer_id"], "name": c["committee"], "source_url": COMMITTEE_PAGE.format(c["filer_id"]), "reports": []})
            k["name"] = k["name"] or c["committee"]
            k["reports"].append({
                "filing_id": c["filing_id"], "amend_id": c["amend_id"], "from": c["from"], "thru": c["thru"], "filed": c["filed"],
                "contributions": c.get("contributions"), "expenditures": c.get("expenditures"), "cash_end": c.get("cash_end"),
                "source_url": STATEMENT_PDF.format(c["filing_id"], c["amend_id"]),
            })
        cycles = {}
        for name, a, b in CYCLES:
            reps = [c for c in p["covers"].values() if a <= c["thru"] <= b]
            m = p["money"].get(name, {"individuals": {"total": 0.0, "count": 0}, "employers": {}, "organizations": {}, "ie": {}})
            if not reps and not m["ie"]:
                continue
            cycles[name] = {
                "raised": round(sum(c.get("contributions") or 0 for c in reps), 2),
                "spent": round(sum(c.get("expenditures") or 0 for c in reps), 2),
                "statements": len(reps),
                # Net of refunds; never below zero (a refund of money given in an earlier period).
                "individuals": {"total": max(0.0, round(m["individuals"]["total"], 2)), "count": m["individuals"]["count"]},
                "employers": sorted(
                    ({"employer": e["employer"], "total": round(e["total"], 2), "count": e["count"],
                      "occupation": max(e["occupations"], key=e["occupations"].get) if e["occupations"] else None} for e in m["employers"].values() if e["total"] > 0 and e["count"]),
                    key=lambda e: -e["total"]),
                "organizations": sorted(({**o, "total": round(o["total"], 2)} for o in m["organizations"].values() if o["total"] > 0 and o["count"]), key=lambda o: -o["total"]),
                "ie": sorted(({**x, "total": round(x["total"], 2)} for x in m["ie"].values()), key=lambda x: -x["total"]),
            }
        for k in committees.values():
            k["reports"] = sorted(k["reports"], key=lambda x: (x["thru"], x["from"] or ""), reverse=True)[:MAX_REPORTS]
        return {
            "name": p["name"],
            "committees": sorted(committees.values(), key=lambda k: k["reports"][0]["thru"] if k["reports"] else "", reverse=True),
            "cycles": cycles,
        }

    return {
        "officials": {k: out(p) for k, p in statewide.items()},
        "seats": {seat: [out(p) for p in people] for seat, people in sorted(seats.items())},
    }


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
    doc = {"source": EXPORT, "export_modified": modified, "generated": date.today().isoformat(), "since": SINCE, **data}
    (work / "ca-campaign-raw.json").write_text(json.dumps(doc))
    for k, v in data["officials"].items():
        print(f"{k}: {len(v['committees'])} committee(s), {sum(len(c['reports']) for c in v['committees'])} statement(s), periods {sorted(v['cycles'])}")
    print(f"legislative seats: {len(data['seats'])}, candidates: {sum(len(v) for v in data['seats'].values())}")
    for seat in ("ASM-8", "SEN-4"):
        for p in data["seats"].get(seat, []):
            print(f"  {seat} {p['name']}: {len(p['committees'])} committee(s), periods {sorted(p['cycles'])}")


if __name__ == "__main__":
    main()
