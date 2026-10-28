#!/usr/bin/env python3
"""Local campaign money for California counties and cities that publish their
filings through NetFile, from NetFile's public Connect2 API (documented at
https://netfile.com/Connect2/api/openapi.json), never the public portal pages.

One reader for every jurisdiction: add an agency to AGENCIES with its NetFile
code (and the county it's in) and it's read the same way. Writes
data/local-money/<CODE>.json per agency:

  committees   each committee with activity since `since`: itemized monetary and
               non-monetary contributions (Form 460 Schedules A and C) and
               itemized payments (Schedule E), as totals; organizations that gave,
               by name; individuals only as a total and count, and by employer
               only where 3 or more individuals named the same employer (never a
               person's name); every filing linked; "as of" the latest filing.
  ies          independent expenditures (Form 496 Part 3 / S496 rows): spender,
               the candidate or measure the row names, amount, date, filing.
  candidates   committee -> candidate, only on a unique match: the candidate's
               last name and first name (or nickname) in the committee's name,
               the contest on the official candidate list, and no other
               candidate who fits. Unmatched stays unmatched.
  measures     committee -> measure, only on "Yes on"/"No on" plus the measure's
               letter, the letter on the county's official list, and a city
               committee only for that city's own measure.
  officials    committee -> a county official in data/county-officials.json,
               on last name plus "Supervisor" and the district, uniquely.

What NetFile's public API doesn't give (said plainly on the pages): the Form
460 summary page (total raised including unitemized, cash on hand) and whether
an independent expenditure supports or opposes; both are on each filing's PDF,
linked. Superseded (amended) transactions are left out.

    python3 tools/build_netfile.py                 # every agency in AGENCIES
    python3 tools/build_netfile.py --agency SCC
    python3 tools/build_netfile.py --find CODE     # look up an agency's NetFile number
"""
import argparse
import datetime
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "local-money"
API = "https://netfile.com/Connect2/api"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
FILING_URL = API + "/public/image/{}"  # the filing itself (PDF), public

# NetFile code -> where it is. `id` is NetFile's agency number, read from the public agency
# list by code; two agencies the list leaves out (Calaveras, San José) answer the transaction
# search by number, found with --find. `since`: the first transaction date read.
AGENCIES = {
    "SCC": {"name": "Santa Clara County", "county": "06085", "kind": "county", "since": "2025-01-01"},
    "CLVS": {"name": "Calaveras County", "county": "06009", "kind": "county", "id": 683, "since": "2021-01-01"},
    "CSJ": {"name": "City of San José", "county": "06085", "kind": "city", "city": "San José", "id": 34, "since": "2025-01-01"},
    "CSC": {"name": "City of Santa Clara", "county": "06085", "kind": "city", "city": "Santa Clara", "since": "2025-01-01"},
    "COS": {"name": "City of Sunnyvale", "county": "06085", "kind": "city", "city": "Sunnyvale", "since": "2025-01-01"},
    "CPA": {"name": "City of Palo Alto", "county": "06085", "kind": "city", "city": "Palo Alto", "since": "2025-01-01"},
    "MTV": {"name": "City of Mountain View", "county": "06085", "kind": "city", "city": "Mountain View", "since": "2025-01-01"},
    "MIL": {"name": "City of Milpitas", "county": "06085", "kind": "city", "city": "Milpitas", "since": "2025-01-01"},
    "GIL": {"name": "City of Gilroy", "county": "06085", "kind": "city", "city": "Gilroy", "since": "2025-01-01"},
    "MGH": {"name": "City of Morgan Hill", "county": "06085", "kind": "city", "city": "Morgan Hill", "since": "2025-01-01"},
    "GAT": {"name": "Town of Los Gatos", "county": "06085", "kind": "city", "city": "Los Gatos", "since": "2025-01-01"},
    "STG": {"name": "City of Saratoga", "county": "06085", "kind": "city", "city": "Saratoga", "since": "2025-01-01"},
}

# NetFile's transaction types (GET /public/campaign/list/transaction/types).
T_CONTRIB, T_NONMONETARY, T_PAYMENT, T_IE = 0, 1, 6, 19
EMPLOYER_MIN_DONORS = 3
TOP_ORGS = 10
ORG = re.compile(r"\b(inc|llc|l\.l\.c|corp|corporation|company|co\.|association|assn|union|local \d+|council|committee|pac|party|club|federation|foundation|partners|partnership|group|trust|fund|society|league|alliance|coalition|chamber|guild|lp|llp|ltd|bank|properties|enterprises|holdings|industries|services|realty)\b", re.I)
NONE_EMPLOYER = re.compile(r"^(n/?a|none|not employed|unemployed|retired|self|self[- ]employed|homemaker|student|information requested|requested)$", re.I)


def call(method, path, body=None, query=None, tries=4):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    for n in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=180) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 (retried, then raised)
            if n == tries - 1:
                raise
            time.sleep(2 ** n * 2)


def agency_number(code):
    """NetFile's number for an agency code, from its public list."""
    for a in call("GET", "/public/campaign/agencies", query={"IncludeTestAgencies": "true"})["agencies"]:
        if a["shortcut"] == code:
            return a["id"]
    return None


def find_agency(code, top=800):
    """An agency the public list leaves out: the number whose transactions' filer IDs carry the code."""
    listed = {a["id"] for a in call("GET", "/public/campaign/agencies", query={"IncludeTestAgencies": "true"})["agencies"]}
    for i in range(top):
        if i in listed:
            continue
        d = call("POST", "/public/campaign/search/transaction/query", body={"Agency": i, "PageSize": 1, "CurrentPageIndex": 0})
        r = (d.get("results") or [None])[0]
        if r and re.match(rf"^(CAMPAIGN_)?{re.escape(code)}-", r["filerLocalId"]):
            return i
    return None


def transactions(agency_id, since):
    """Every current (not superseded) transaction since `since`, in pages of 1,000."""
    out, page = [], 0
    while True:
        d = call("POST", "/public/campaign/search/transaction/query", body={
            "Agency": agency_id, "DateStart": since, "ShowSuperceded": False, "PageSize": 1000, "CurrentPageIndex": page, "SortOrder": 0})
        out += d.get("results") or []
        page += 1
        if page >= (d.get("totalMatchingPages") or 0):
            return out
        time.sleep(0.5)


def filing_info(filing_id):
    try:
        return call("GET", f"/public/filing/info/{filing_id}")
    except Exception:  # noqa: BLE001 (a filing that won't describe itself keeps its link)
        return None


def norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower().replace("é", "e").replace("á", "a").replace("í", "i").replace("ó", "o").replace("ú", "u").replace("ñ", "n")).split()


def is_org(t):
    """An organization may be named; a person never is. Unsure counts as a person."""
    if t.get("transactionFppcId"):
        return True  # a committee
    if (t.get("occupation") or "").strip() or (t.get("employer") or "").strip():
        return False
    return bool(ORG.search(t.get("name") or ""))


def committees(rows):
    by = {}
    for t in rows:
        c = by.setdefault(t["filerLocalId"], {"local_id": t["filerLocalId"], "fppc_id": t.get("filerFppcId") or None, "name": t["filerName"],
                                              "contributions": 0.0, "nonmonetary": 0.0, "payments": 0.0, "first": None, "last": None,
                                              "_orgs": {}, "_ind": {"total": 0.0, "count": 0}, "_emp": {}, "_filings": set()})
        c["_filings"].add(t["filingId"])
        d = (t.get("date") or "")[:10]
        if d:
            c["first"] = min(c["first"] or d, d)
            c["last"] = max(c["last"] or d, d)
        amt = float(t.get("amount") or 0)
        tt = t.get("transactionType")
        if tt in (T_CONTRIB, T_NONMONETARY):
            c["contributions" if tt == T_CONTRIB else "nonmonetary"] += amt
            if is_org(t):
                key = " ".join(norm(t["name"])).upper()
                o = c["_orgs"].setdefault(key, {"name": t["name"].strip(), "total": 0.0, "count": 0})
                o["total"] += amt
                o["count"] += 1
            else:
                c["_ind"]["total"] += amt
                c["_ind"]["count"] += 1
                emp = (t.get("employer") or "").strip()
                if emp and not NONE_EMPLOYER.match(emp):
                    e = c["_emp"].setdefault(emp.upper(), {"employer": emp, "total": 0.0, "donors": set()})
                    e["total"] += amt
                    # A donor is told apart only in memory, to count distinct donors; never kept.
                    e["donors"].add((" ".join(norm(t["name"])), (t.get("zip") or "")[:5]))
        elif tt == T_PAYMENT:
            c["payments"] += amt
    return by


def finish(c, info):
    """The committee as written: totals, organizations by name, individuals as totals, employers with 3+ donors."""
    orgs = sorted(c["_orgs"].values(), key=lambda o: -o["total"])
    emps = [{"employer": e["employer"], "total": round(e["total"], 2), "donors": len(e["donors"])} for e in c["_emp"].values() if len(e["donors"]) >= EMPLOYER_MIN_DONORS]
    filings = []
    for fid in sorted(c["_filings"], key=lambda x: int(x) if str(x).isdigit() else 0, reverse=True):
        i = info.get(fid) or {}
        filings.append({"id": fid, "url": FILING_URL.format(fid), "filed": (i.get("filingDate") or "")[:10] or None,
                        "from": (i.get("dateStart") or "")[:10] or None, "through": (i.get("dateEnd") or "")[:10] or None})
    return {
        "local_id": c["local_id"], "fppc_id": c["fppc_id"], "name": c["name"],
        "contributions": round(c["contributions"], 2), "nonmonetary": round(c["nonmonetary"], 2), "payments": round(c["payments"], 2),
        "first": c["first"], "last": c["last"],
        "individuals": {"total": round(c["_ind"]["total"], 2), "count": c["_ind"]["count"]},
        "organizations": [{"name": o["name"], "total": round(o["total"], 2), "count": o["count"]} for o in orgs[:TOP_ORGS]],
        "organizations_count": len(orgs),
        "employers": sorted(emps, key=lambda e: -e["total"])[:TOP_ORGS],
        "filings": filings,
        "as_of": filings[0]["filed"] if filings and filings[0]["filed"] else c["last"],
    }


# ---------------------------------------------------------------------------
# Matching: unique or nothing.

def contests_for(cfg):
    e = json.loads((ROOT / "data" / "elections" / "2026-11-03.json").read_text())
    local = [c for c in e["contests"] if c.get("county") == cfg["county"]]
    if cfg["kind"] == "city":
        city = norm(cfg["city"])
        local = [c for c in local if all(w in norm(c["office"]) for w in city)]
    else:
        local = [c for c in local if not re.search(r"\b(city|town) of\b|\bmayor\b", c["office"], re.I)]
    measures = [m for m in e["measures"] if m.get("county") == cfg["county"]]
    return local, measures


OFFICE_WORDS = {"school", "board", "trustee", "council", "mayor", "water", "college", "ccd", "usd", "sd", "hsd", "supervisor", "director", "sanitary", "education", "district"}


def name_parts(name):
    nick = [w for m in re.findall(r"[\"“']([^\"”']+)[\"”']", name) for w in norm(m)]
    words = [w for w in norm(re.sub(r"[\"“'][^\"”']+[\"”']", " ", name)) if w not in {"jr", "sr", "ii", "iii", "iv"} and len(w) > 1]
    return (words[0] if words else ""), (words[-1] if words else ""), nick


def candidate_matches(com_name, contests):
    """The candidates this committee's name points to: last name, plus first name/nickname or an office word of their contest."""
    words = set(norm(com_name))
    hits = []
    for c in contests:
        office = set(norm(c["office"])) & OFFICE_WORDS
        for cand in c["candidates"]:
            first, last, nick = name_parts(cand["name"])
            if not last or last not in words:
                continue
            if first in words or any(n in words for n in nick) or (office & words):
                hits.append((c, cand))
    return hits


def match_candidates(coms, contests):
    out, by_cand = {}, {}
    for lid, c in coms.items():
        if re.search(r"\b(yes|no)\s+on\b", c["name"], re.I):
            continue
        hits = candidate_matches(c["name"], contests)
        if len(hits) == 1:
            contest, cand = hits[0]
            by_cand.setdefault((contest["id"], cand["name"]), []).append(lid)
    for (cid, cname), lids in by_cand.items():
        if len(lids) == 1:  # one committee per candidate, or none
            out[lids[0]] = {"contest": cid, "candidate": cname}
    return out


def match_measures(coms, measures, cfg):
    out = {}
    letters = {m["number"].upper(): m for m in measures}
    for lid, c in coms.items():
        m = re.search(r"\b(yes|no)\s+on\s+(?:measure\s+)?([a-z]{1,3})\b", c["name"], re.I)
        if not m or m.group(2).upper() not in letters:
            continue
        meas = letters[m.group(2).upper()]
        if cfg["kind"] == "city" and not all(w in norm(meas.get("jurisdiction") or "") for w in norm(cfg["city"])):
            continue  # a city committee only for its own city's measure
        out[lid] = {"measure": meas["id"], "side": "support" if m.group(1).lower() == "yes" else "oppose"}
    return out


def match_officials(coms, cfg):
    """County officials (data/county-officials.json, Calaveras's supervisors): last name + Supervisor + district, uniquely."""
    if cfg["county"] != "06009":
        return {}
    officials = json.loads((ROOT / "data" / "county-officials.json").read_text())["officials"]
    out = {}
    for o in officials:
        if not o.get("name"):
            continue
        _, last, _ = name_parts(o["name"])
        dist = str(o.get("district") or "")
        hits = [lid for lid, c in coms.items() if last in norm(c["name"]) and re.search(r"supervisor", c["name"], re.I)
                and (not dist or re.search(rf"\b(d|district)\s*{dist}\b", c["name"], re.I))]
        if len(hits) >= 1 and len({coms[h]["name"].split(" for ")[0] for h in hits}) == 1:
            out[o["name"]] = sorted(hits, key=lambda h: coms[h]["last"] or "", reverse=True)
    return out


def ies(rows, contests):
    out = []
    names = {}
    for c in contests:
        for cand in c["candidates"]:
            names.setdefault(" ".join(norm(cand["name"])), []).append((c["id"], cand["name"]))
    for t in rows:
        if t.get("transactionType") != T_IE:
            continue
        target = (t.get("candidate") or "").strip()
        hit = names.get(" ".join(norm(target)), [])
        out.append({"spender": t["filerName"], "spender_id": t["filerLocalId"], "target": target or None,
                    "contest": hit[0][0] if len(hit) == 1 else None, "candidate": hit[0][1] if len(hit) == 1 else None,
                    "amount": float(t.get("amount") or 0), "date": (t.get("date") or "")[:10], "filing": t["filingId"], "url": FILING_URL.format(t["filingId"])})
    return out


def build(code, cfg):
    aid = cfg.get("id") or agency_number(code)
    if aid is None:
        raise SystemExit(f"{code}: not in NetFile's public agency list; find its number with --find {code}")
    rows = transactions(aid, cfg["since"])
    coms = committees(rows)
    latest = {}
    for lid, c in coms.items():
        if c["_filings"]:
            latest[lid] = max(c["_filings"], key=lambda x: int(x) if str(x).isdigit() else 0)
    info = {}
    for fid in set(latest.values()):
        info[fid] = filing_info(fid)
        time.sleep(0.2)
    done = {lid: finish(c, info) for lid, c in coms.items()}
    contests, measures = contests_for(cfg)
    doc = {
        "_readme": "Generated by tools/build_netfile.py from NetFile's public API; don't edit by hand. Individuals are never named.",
        "agency": code, "agency_id": aid, "name": cfg["name"], "county": cfg["county"],
        "since": cfg["since"], "generated": datetime.date.today().isoformat(),
        "source": f"NetFile public campaign filings, {cfg['name']}",
        "source_url": f"https://public.netfile.com/pub2/?aid={code}",
        "transactions": len(rows),
        "committees": done,
        "candidates": match_candidates(coms, contests),
        "measures": match_measures(coms, measures, cfg),
        "officials": match_officials(coms, cfg),
        "ies": ies(rows, contests),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{code}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"{code}: {len(rows)} transactions, {len(done)} committees, {len(doc['candidates'])} matched to candidates, "
          f"{len(doc['measures'])} to measures, {len(doc['officials'])} officials, {len(doc['ies'])} independent expenditures")
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--agency", action="append", choices=sorted(AGENCIES))
    ap.add_argument("--find", help="look up an agency's NetFile number by its code")
    args = ap.parse_args()
    if args.find:
        print(args.find, agency_number(args.find) or find_agency(args.find))
        return
    failed = []
    for code in args.agency or AGENCIES:
        try:
            build(code, AGENCIES[code])
        except Exception as e:  # noqa: BLE001 (one agency down keeps its earlier file)
            print(f"{code}: not written: {type(e).__name__}: {e}", file=sys.stderr)
            failed.append(code)
    if failed:
        sys.exit(f"Not written: {', '.join(failed)}")


if __name__ == "__main__":
    main()
