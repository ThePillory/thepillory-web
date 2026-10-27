#!/usr/bin/env python3
"""Who's behind each side of California's statewide ballot measures, from Cal-Access.

    python3 tools/build_measure_money.py <work-dir> [<dbwebexport.zip>]

Reads the Secretary of State's Cal-Access export (the same file
tools/build_ca_campaign.py downloads into <work-dir>, in the weekly "Refresh
California campaign data" workflow) and writes
data/elections/measure-money-2026-11-03.json:

  measures.<number>.committees: every committee formed for the measure: a
      ballot measure committee (entity BMC) whose campaign statements (Form
      460) since NUMBERS_FROM name the proposition by number, statewide, with a
      side (support or oppose), on the cover page or its list of measures. A
      committee that names both sides of one measure is left out. A committee
      formed for several measures lists them; its totals cover all of them.
      For each, by its statements since 2025 (latest amendment of each):
        raised and spent: Summary Page lines 5 and 11, column A, summed;
        cash on hand: line 16 of the latest statement;
        Schedule A contributions (memo entries left out):
          individuals: only a total and a count, never a name, at any amount;
          organizations, businesses, committees and parties: by name, with the
          latest statement each appears on.
  measures.<number>.spending: independent expenditures (Form 496, since
      NUMBERS_FROM) for or against the measure by anyone else, by spender.
      People spending their own money are counted, never named.
  orgs: by normalized organization name (the same rule as orgKey() in
      workers/sync/src/funding/darkmoney.js): each committee for a 2026
      measure it gave to, and its own independent spending on each measure.

Nothing here says why anyone took a side: money and positions are listed as
facts, with their filings. Standard library only.
"""
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_ca_campaign import rows, iso, money, EXPORT, COMMITTEE_PAGE, STATEMENT_PDF, ORG_ENTITIES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ELECTION = "2026-11-03"
OUT = ROOT / f"data/elections/measure-money-{ELECTION}.json"
# The Secretary of State numbered November 2026's propositions in late June 2026; a
# statement covering a period ending before then can't name them by number.
NUMBERS_FROM = "2026-06-25"
STATEMENTS_SINCE = "2025-01-01"
MEASURES_PAGE = "https://cal-access.sos.ca.gov/Campaign/Measures/"
TOP_ORGS = 10
LINES = {"5": "contributions", "11": "expenditures", "16": "cash_end"}
STATEWIDE = re.compile(r"^(?:|STATE|STATEWIDE|CALIFORNIA|STATE OF CALIFORNIA|STATE OF CA|CA)$")
SIDE = {"S": "support", "O": "oppose"}


def number(s):
    """'4', 'Prop 4', 'PROPOSITION 004' -> '4'; anything else -> None."""
    m = re.fullmatch(r"\s*(?:PROP(?:OSITION|\.)?\s*)?0*(\d{1,3})\s*", (s or "").upper())
    return m.group(1) if m else None


def org_key(name):
    words = re.sub(r"[^A-Z0-9 ]+", " ", (name or "").upper().replace("&", " AND ")).split()
    return " ".join(w for w in words if w not in {"INC", "INCORPORATED", "CORP", "CORPORATION", "THE", "CO", "LTD", "LLC"})


def measure_pages():
    """{number: Cal-Access page} from the Propositions & Ballot Measures index (the detail pages are for readers)."""
    try:
        req = urllib.request.Request(MEASURES_PAGE, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001 - the pages are links only; the data comes from the export
        print(f"Cal-Access measures index not read ({err}); measure pages left unlinked")
        return {}
    return {str(int(n)): MEASURES_PAGE + href.replace("&amp;", "&") for href, n in re.findall(r"href='(Detail\.aspx\?id=\d+&(?:amp;)?session=\d+)'>PROPOSITION (\d+)", html)}


def build(zip_path):
    election = json.loads((ROOT / f"data/elections/{ELECTION}.json").read_text())
    props = {str(m["number"]) for m in election["measures"] if m.get("scope") == "statewide"}
    zf = zipfile.ZipFile(zip_path)

    # 1. Campaign statements: ballot measure committees' Form 460 covers (latest amendment
    #    of each, since 2025) and the measures they name; Form 496 independent expenditures.
    covers = {}       # filer_id -> {filing_id: cover}
    sides = {}        # (filer_id, number) -> set of sides
    recent = {}       # filing_id -> filer_id, for the covers that can name a number
    ie_covers = {}    # filing_id -> cover
    for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
        form, ent = r["FORM_TYPE"], (r["ENTITY_CD"] or "").strip()
        thru = iso(r["THRU_DATE"]) or iso(r["RPT_DATE"]) or ""
        n = number(r.get("BAL_NUM"))
        side = SIDE.get((r.get("SUP_OPP_CD") or "").strip().upper())
        juris_ok = bool(STATEWIDE.match((r.get("BAL_JURIS") or "").strip().upper()))
        if form == "F496":
            if thru < NUMBERS_FROM or n not in props or not side or not juris_ok:
                continue
            fid, amend = r["FILING_ID"], int(r["AMEND_ID"] or 0)
            prev = ie_covers.get(fid)
            if prev and prev["amend_id"] >= amend:
                continue
            ie_covers[fid] = {
                "filing_id": fid, "amend_id": amend, "filer_id": r["FILER_ID"], "number": n, "side": side,
                "spender": (r["FILER_NAML"] or "").strip(),
                # Someone spending their own money files under a first and last name: counted, never named.
                "person": bool((r.get("FILER_NAMF") or "").strip()) and ent in ("IND", "MDI"),
                "filed": iso(r["RPT_DATE"]),
            }
            continue
        if form != "F460" or ent != "BMC" or thru < STATEMENTS_SINCE:
            continue
        fid, amend = r["FILING_ID"], int(r["AMEND_ID"] or 0)
        cover = {"filing_id": fid, "amend_id": amend, "committee": (r["FILER_NAML"] or "").strip(),
                 "from": iso(r["FROM_DATE"]), "thru": thru, "filed": iso(r["RPT_DATE"])}
        prev = covers.setdefault(r["FILER_ID"], {}).get(fid)
        if not prev or prev["amend_id"] < amend:
            covers[r["FILER_ID"]][fid] = cover
        if thru >= NUMBERS_FROM:
            recent[fid] = r["FILER_ID"]
            if n in props and side and juris_ok:
                sides.setdefault((r["FILER_ID"], n), set()).add(side)
    # The other measures a statement lists (CVR2, entity BNM).
    for r in rows(zf, "CVR2_CAMPAIGN_DISCLOSURE_CD"):
        filer = recent.get(r["FILING_ID"])
        if not filer or (r.get("ENTITY_CD") or "").strip() != "BNM":
            continue
        n = number(r.get("BAL_NUM"))
        side = SIDE.get((r.get("SUP_OPP_CD") or "").strip().upper())
        if n in props and side and STATEWIDE.match((r.get("BAL_JURIS") or "").strip().upper()):
            sides.setdefault((filer, n), set()).add(side)

    formed = {}  # filer_id -> {number: side}
    for (filer, n), s in sides.items():
        if len(s) == 1:
            formed.setdefault(filer, {})[n] = next(iter(s))
        else:
            print(f"left out: committee {filer} names both sides of Proposition {n}")

    # 2. Summary Page totals of those committees' statements.
    want = {}
    for filer in formed:
        for c in covers.get(filer, {}).values():
            want[(c["filing_id"], str(c["amend_id"]))] = c
    for r in rows(zf, "SMRY_CD"):
        if r["FORM_TYPE"] == "F460" and r["LINE_ITEM"] in LINES:
            c = want.get((r["FILING_ID"], r["AMEND_ID"]))
            if c is not None:
                c[LINES[r["LINE_ITEM"]]] = money(r["AMOUNT_A"])

    # 3. Schedule A contributions on those statements.
    owner = {}
    for filer in formed:
        for c in covers.get(filer, {}).values():
            owner[(c["filing_id"], str(c["amend_id"]))] = (filer, c)
    gifts = {f: {"individuals": {"total": 0.0, "count": 0}, "organizations": {}} for f in formed}
    for r in rows(zf, "RCPT_CD"):
        if r["FORM_TYPE"] != "A" or (r["MEMO_CODE"] or "").strip():
            continue
        hit = owner.get((r["FILING_ID"], r["AMEND_ID"]))
        amount = money(r["AMOUNT"])
        if not hit or amount is None:
            continue
        filer, c = hit
        g = gifts[filer]
        if r["ENTITY_CD"] == "IND":
            g["individuals"]["total"] += amount
            g["individuals"]["count"] += amount > 0
            continue
        name = re.sub(r"\s+", " ", " ".join(x for x in [(r["CTRIB_NAMF"] or "").strip(), (r["CTRIB_NAML"] or "").strip()] if x)).strip()
        if not name:
            continue
        o = g["organizations"].setdefault(name.upper(), {"name": name, "kind": ORG_ENTITIES.get(r["ENTITY_CD"], "organization"), "total": 0.0, "count": 0, "latest": None})
        o["total"] += amount
        o["count"] += amount > 0
        if not o["latest"] or (c["thru"], c["filing_id"]) > (o["latest"]["thru"], o["latest"]["filing_id"]):
            o["latest"] = c

    # 4. Independent expenditures: amounts and dates.
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

    # 5. Out.
    pages = measure_pages()
    measures = {n: {"cal_access_url": pages.get(n), "committees": [], "spending": []} for n in sorted(props, key=int)}
    orgs = {}
    for filer, for_props in formed.items():
        reps = sorted(covers.get(filer, {}).values(), key=lambda c: (c["thru"], c["filed"] or ""), reverse=True)
        if not reps:
            continue
        latest = reps[0]
        g = gifts[filer]
        top = sorted((o for o in g["organizations"].values() if o["total"] > 0 and o["count"]), key=lambda o: -o["total"])
        committee = {
            "filer_id": filer, "name": latest["committee"],
            "props": [{"number": n, "side": s} for n, s in sorted(for_props.items(), key=lambda x: int(x[0]))],
            "raised": round(sum(c.get("contributions") or 0 for c in reps), 2),
            "spent": round(sum(c.get("expenditures") or 0 for c in reps), 2),
            "cash_end": latest.get("cash_end"),
            "statements": len(reps), "through": latest["thru"], "filed": latest["filed"],
            "source_url": COMMITTEE_PAGE.format(filer),
            "statement_url": STATEMENT_PDF.format(latest["filing_id"], latest["amend_id"]),
            # Net of refunds; never below zero.
            "individuals": {"total": max(0.0, round(g["individuals"]["total"], 2)), "count": g["individuals"]["count"]},
            "organizations": [{"name": o["name"], "kind": o["kind"], "total": round(o["total"], 2), "count": o["count"],
                               "statement_url": STATEMENT_PDF.format(o["latest"]["filing_id"], o["latest"]["amend_id"])} for o in top[:TOP_ORGS]],
            "organizations_count": len(top),
        }
        for n, s in for_props.items():
            measures[n]["committees"].append({**committee, "side": s})
        for o in top:
            orgs.setdefault(org_key(o["name"]), {"name": o["name"], "gave": [], "spent": []})["gave"].append(
                {"committee": committee["name"], "filer_id": filer, "props": committee["props"], "total": round(o["total"], 2), "source_url": committee["statement_url"]})
    for n in measures:
        measures[n]["committees"].sort(key=lambda c: (c["side"] != "support", -c["raised"]))
    spend = {}
    for fid, c in ie_covers.items():
        total = ie_amount.get(fid)
        if not total or formed.get(c["filer_id"], {}).get(c["number"]):
            continue  # nothing reported, or a committee already listed as formed for this measure
        key = (c["number"], c["side"], "person" if c["person"] else c["filer_id"])
        x = spend.setdefault(key, {"side": c["side"], "spender": None if c["person"] else c["spender"], "person": c["person"],
                                   "filer_id": None if c["person"] else c["filer_id"], "spenders": set(), "total": 0.0, "filings": 0,
                                   "first": None, "last": None})
        x["total"] += total
        x["filings"] += 1
        x["spenders"].add(c["filer_id"])
        for k, f in (("first", min), ("last", max)):
            v = c.get(k) or c["filed"]
            if v:
                x[k] = f(x[k], v) if x[k] else v
    for (n, side, _), x in spend.items():
        row = {"side": side, "spender": x["spender"], "person": x["person"], "people": len(x["spenders"]) if x["person"] else None,
               "total": round(x["total"], 2), "filings": x["filings"], "first": x["first"], "last": x["last"],
               "source_url": COMMITTEE_PAGE.format(x["filer_id"]) if x["filer_id"] else None}
        measures[n]["spending"].append(row)
        if not x["person"]:
            orgs.setdefault(org_key(x["spender"]), {"name": x["spender"], "gave": [], "spent": []})["spent"].append(
                {"number": n, "side": side, "total": row["total"], "source_url": row["source_url"]})
    for n in measures:
        measures[n]["spending"].sort(key=lambda x: (x["side"] != "support", -x["total"]))
    return {"measures": measures, "orgs": orgs}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1])
    zip_path = Path(sys.argv[2]) if len(sys.argv) > 2 else work / "dbwebexport.zip"
    if not zip_path.exists():
        work.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(EXPORT, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
        with urllib.request.urlopen(req) as res, open(zip_path, "wb") as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
    data = build(zip_path)
    doc = {
        "_readme": "Committees formed for each of California's November 3, 2026 statewide propositions, their money, and independent spending on each, from the Cal-Access export. Built by tools/build_measure_money.py; never edit by hand.",
        "source": EXPORT, "election": ELECTION, "generated": date.today().isoformat(), "numbers_from": NUMBERS_FROM, **data,
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    for n, m in data["measures"].items():
        print(f"Proposition {n}: {len(m['committees'])} committee(s) {[(c['name'][:50], c['side'], c['raised']) for c in m['committees']]}, {len(m['spending'])} other spender(s)")
    print(f"organizations indexed: {len(data['orgs'])}")


if __name__ == "__main__":
    main()
