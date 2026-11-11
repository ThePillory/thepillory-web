#!/usr/bin/env python3
"""Company taxes from SEC EDGAR, into D1 (migration 0047): the weekly "Refresh
company taxes" workflow (.github/workflows/company-taxes.yml). See docs/taxes.md.

For the 100 largest companies by revenue (--top; 0 for every company) that filed a
10-K since 2019: the values their financial statements tag in XBRL, by fiscal year,
each with the filing it comes from:

  taxes_paid       us-gaap:IncomeTaxesPaidNet                         Income Taxes Paid, Net
  paid_federal     IncomeTaxPaidFederalAfterRefundReceived            (ASU 2023-09, from fiscal 2025)
  paid_state       IncomeTaxPaidStateAndLocalAfterRefundReceived
  paid_foreign     IncomeTaxPaidForeignAfterRefundReceived
  current_federal  CurrentFederalTaxExpenseBenefit
  current_state    CurrentStateAndLocalTaxExpenseBenefit
  deferred         DeferredIncomeTaxExpenseBenefit
  pretax           IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest
                   (or ...MinorityInterestAndIncomeLossFromEquityMethodInvestments; pretax_tag says which)
  pretax_us        IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic
  pretax_foreign   IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign
  revenue          Revenues, RevenueFromContractWithCustomer..., SalesRevenueNet (for sorting the list)

Sources: EDGAR's nightly bulk files (submissions.zip: names, tickers, SIC,
business address, 10-K filings; companyfacts.zip: every non-dimensional XBRL
fact), and, for 10-Ks that file taxes paid by jurisdiction (IncomeTaxAuthorityAxis:
a country or a U.S. state), that 10-K's own XBRL instance, read once.

Rules: a value a filing doesn't tag stays empty, never estimated or derived.
Only the elements above (us-gaap); a company's own extension elements are left
out, because company facts don't carry them and their meaning varies. Annual
values only: a 10-K's fact for a period of 330 to 400 days. A fiscal year's value
is the latest 10-K's (a restatement replaces the original), linked to that filing.

  python3 tools/build_company_taxes.py --mode measure          # read, write nothing
  python3 tools/build_company_taxes.py --mode load             # into D1 (changed rows only)

Standard library only (pycountry for country names, installed by the workflow).
Pure parts tested in tools/test_company_taxes.py.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_trades import d1, run_sql, MIGRATIONS  # noqa: E402
from load_state_votes import lit  # noqa: E402
from d1sql import prune  # noqa: E402

UA = os.environ.get("SEC_USER_AGENT") or "ThePillory data (https://thepillory.co)"
BULK = "https://www.sec.gov/Archives/edgar/daily-index/"
SUBMISSIONS_ZIP = BULK + "bulkdata/submissions.zip"
FACTS_ZIP = BULK + "xbrl/companyfacts.zip"
SINCE = "2019-01-01"

# field -> the us-gaap elements that fill it, first one tagged wins.
FIELDS = {
    "taxes_paid": ["IncomeTaxesPaidNet"],
    "paid_federal": ["IncomeTaxPaidFederalAfterRefundReceived"],
    "paid_state": ["IncomeTaxPaidStateAndLocalAfterRefundReceived"],
    "paid_foreign": ["IncomeTaxPaidForeignAfterRefundReceived"],
    "current_federal": ["CurrentFederalTaxExpenseBenefit"],
    "current_state": ["CurrentStateAndLocalTaxExpenseBenefit"],
    "deferred": ["DeferredIncomeTaxExpenseBenefit"],
    "pretax": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
               "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "pretax_us": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic"],
    "pretax_foreign": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign"],
    # RevenuesNetOfInterestExpense: banks' total revenue, the only one many of them tag.
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense", "SalesRevenueNet"],
}
TAGGED = {"pretax", "revenue"}  # fields whose element is stored beside the value (pretax_tag, revenue_tag)
# Taxes paid by jurisdiction (a 10-K's own XBRL): the elements and the axis.
PAID_ELEMENTS = ["IncomeTaxesPaidNet", "IncomeTaxPaidFederalAfterRefundReceived", "IncomeTaxPaidStateAndLocalAfterRefundReceived", "IncomeTaxPaidForeignAfterRefundReceived"]
AXIS = "us-gaap:IncomeTaxAuthorityAxis"

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "PR": "Puerto Rico",
}


def say(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# Pure parts (tested)

STOP = {"the", "inc", "incorporated", "llc", "corp", "corporation", "co", "ltd"}


def name_key(name):
    """The exact-name key: nameKey() in functions/awards/index.js, the same rule word for word."""
    words = re.sub(r"[^a-z0-9 ]", " ", str(name or "").lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in STOP)


def days(start, end):
    return (datetime.date.fromisoformat(end) - datetime.date.fromisoformat(start)).days


def annual(facts):
    """A concept's USD facts from 10-Ks covering one fiscal year (330 to 400 days), ending in 2019 or later."""
    out = []
    for f in facts:
        if not str(f.get("form", "")).startswith("10-K") or not f.get("start") or not f.get("end") or f.get("val") is None:
            continue
        if f["end"] < SINCE or not 330 <= days(f["start"], f["end"]) <= 400:
            continue
        out.append(f)
    return out


def by_year(facts):
    """{period end: chosen fact}: the latest-filed 10-K's value (a restatement replaces the original), with that
    year's start and its fiscal year as named by the 10-K filed for that year (the filing whose own year it is:
    the latest period among its facts). "fy" is None when that filing isn't among the facts: company_years()
    names it from the company's other years."""
    groups = {}
    own_end = {}
    for f in annual(facts):
        groups.setdefault(f["end"], []).append(f)
        own_end[f["accn"]] = max(own_end.get(f["accn"], ""), f["end"])
    out = {}
    for end, fs in groups.items():
        latest = max(fs, key=lambda f: (f.get("filed", ""), f.get("accn", "")))
        own = [f for f in fs if own_end[f["accn"]] == end and f.get("fy")]
        fy = min(own, key=lambda f: (f.get("filed", ""), f.get("accn", "")))["fy"] if own else None
        out[end] = {"val": latest["val"], "accn": latest["accn"], "start": latest["start"], "fy": fy}
    return out


def name_years(years):
    """Years whose own 10-K isn't among the facts get their fiscal year from the company's naming rule, read off
    the years that have one (fiscal year minus the year the period ends: 0, or -1 for a year ending in January)."""
    offs = [y["fy"] - int(y["period_end"][:4]) for y in years if y.get("fy")]
    off = max(set(offs), key=offs.count) if offs else 0
    for y in years:
        if not y.get("fy"):
            y["fy"] = int(y["period_end"][:4]) + off
    return years


def company_years(facts):
    """Every fiscal year's row from a company's us-gaap facts ({element: {"units": {"USD": [...]}}})."""
    years = {}
    for field, elements in FIELDS.items():
        for el in elements:
            usd = ((facts.get(el) or {}).get("units") or {}).get("USD")
            if not usd:
                continue
            for end, v in by_year(usd).items():
                row = years.setdefault(end, {"period_end": end, "period_start": v["start"], "fy": v["fy"], "src": {}})
                if row.get(field) is not None:
                    continue  # an earlier element in the list already filled it for this year
                row[field] = v["val"]
                row["src"][field] = v["accn"]
                if field in TAGGED:
                    row[field + "_tag"] = el
                if row.get("fy") is None and v["fy"]:
                    row["fy"] = v["fy"]
    # A year with nothing but revenue isn't a tax year.
    return name_years([y for y in sorted(years.values(), key=lambda r: r["period_end"]) if any(y.get(f) is not None for f in FIELDS if f != "revenue")])


def largest(companies, n, today=None):
    """The n companies with the largest latest revenue, among those still filing (a fiscal year that ended in
    the last two years); a company whose revenue isn't tagged isn't among them."""
    today = today or datetime.date.today()
    cutoff = (today - datetime.timedelta(days=730)).isoformat()
    live = (c for c in companies if c.get("revenue") is not None and (c.get("latest_end") or "") >= cutoff)
    return sorted(live, key=lambda c: (-c["revenue"], c["cik"]))[:n]


def latest(years):
    """The newest year with taxes paid or pretax income: what the list and the organization line show."""
    for y in reversed(years):
        if y.get("taxes_paid") is not None or y.get("pretax") is not None:
            return y
    return None


def business_state(sub):
    a = ((sub.get("addresses") or {}).get("business") or {})
    st = (a.get("stateOrCountry") or "").upper()
    return st if st in STATES else None


def breakdown_filings(sub, since="2024-12-01"):
    """Original 10-Ks for fiscal years ending on or after `since`: the years taxes paid by place can be filed."""
    r = (sub.get("filings") or {}).get("recent") or {}
    return {a for form, a, rep in zip(r.get("form", []), r.get("accessionNumber", []), r.get("reportDate", [])) if form == "10-K" and (rep or "") >= since}


def ten_ks(sub):
    """[(accn, filed, report date)] of a company's 10-Ks since 2019, from its submissions file."""
    r = (sub.get("filings") or {}).get("recent") or {}
    out = []
    for form, accn, filed, rep in zip(r.get("form", []), r.get("accessionNumber", []), r.get("filingDate", []), r.get("reportDate", [])):
        if form in ("10-K", "10-K/A") and filed >= SINCE:
            out.append((accn, filed, rep))
    return out


CONTEXT = re.compile(r"<(?:xbrli:)?context\b[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</(?:xbrli:)?context>", re.S)
MEMBER = re.compile(r"<xbrldi:explicitMember\b[^>]*\bdimension=\"([^\"]+)\"[^>]*>\s*([^<\s]+)\s*<", re.S)
DATES = re.compile(r"<(?:xbrli:)?(startDate|endDate)>\s*([0-9-]{10})\s*<")


READER = 2  # bump when the reader below changes: filings read by an older reader are read again
# Standard members of IncomeTaxAuthorityAxis: which group of the breakdown each is, and its name.
STANDARD_MEMBERS = {
    "us-gaap:DomesticCountryMember": ("federal", "U.S. government"),
    "us-gaap:FederalMember": ("federal", "U.S. government"),
    "us-gaap:StateAndLocalJurisdictionMember": ("state", "States"),
    "us-gaap:ForeignCountryMember": ("foreign", "Other countries"),
    "us-gaap:ForeignTaxJurisdictionOtherMember": ("foreign", "Other countries"),
}
GROUP_OF_ELEMENT = {
    "IncomeTaxPaidFederalAfterRefundReceived": "federal",
    "IncomeTaxPaidStateAndLocalAfterRefundReceived": "state",
    "IncomeTaxPaidForeignAfterRefundReceived": "foreign",
}


def words(local):
    """A member's own name when the filing gives no label: OtherStatesMember -> "Other states"."""
    w = re.sub(r"Member$", "", local)
    w = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", w).strip()
    return w[:1].upper() + w[1:].lower() if w else local


def member_labels(lab_xml):
    """{member qname: label} from a filing's label linkbase: the terse label, else the standard label
    without " [Member]". Only members (names ending in Member)."""
    attrs = lambda tag: dict(re.findall(r'([\w:]+)="([^"]*)"', tag))
    locs = {}
    for m in re.finditer(r"<(?:link:)?loc\b([^>]*)/?>", lab_xml):
        a = attrs(m.group(1))
        frag = (a.get("xlink:href") or "").rsplit("#", 1)[-1]
        if frag.endswith("Member") and "_" in frag:
            locs[a.get("xlink:label")] = frag.replace("_", ":", 1)
    arcs = {}
    for m in re.finditer(r"<(?:link:)?labelArc\b([^>]*)/?>", lab_xml):
        a = attrs(m.group(1))
        if a.get("xlink:from") in locs:
            arcs.setdefault(a.get("xlink:to"), []).append(locs[a["xlink:from"]])
    found = {}
    for m in re.finditer(r"<(?:link:)?label\b([^>]*)>([^<]*)</(?:link:)?label>", lab_xml):
        a = attrs(m.group(1))
        role = (a.get("xlink:role") or "").rsplit("/", 1)[-1]
        text = re.sub(r"\s*\[Member\]$", "", m.group(2).strip())
        for q in arcs.get(a.get("xlink:label"), []):
            rank = {"terseLabel": 0, "label": 1}.get(role)
            if rank is not None and text and (q not in found or rank < found[q][0]):
                found[q] = (rank, text)
    return {q: t for q, (_, t) in found.items()}


def custom_members(xml):
    """The company-defined members on IncomeTaxAuthorityAxis (the ones that need the label linkbase)."""
    out = set()
    for dim, mem in MEMBER.findall(xml):
        if dim == AXIS and not mem.split(":", 1)[0] in ("country", "stpr", "us-gaap", "srt"):
            out.add(mem)
    return out


def jurisdictions(xml, country_name, labels=None):
    """Taxes paid by place from a 10-K's XBRL instance: every fact of PAID_ELEMENTS whose only dimension is
    IncomeTaxAuthorityAxis, for a period of 330 to 400 days, whatever the member: a country (country:XX), a
    U.S. state (stpr:XX), the standard totals and "other" members (STANDARD_MEMBERS), and the company's own
    members, named by the filing's label (labels: member_labels()). Nothing summed or derived here.
    [{period_end, element, jurisdiction, name, amount}]."""
    labels = labels or {}
    ctx = {}
    for cid, body in CONTEXT.findall(xml):
        mem = MEMBER.findall(body)
        d = dict(DATES.findall(body))
        if len(mem) != 1 or mem[0][0] != AXIS or "startDate" not in d or "endDate" not in d:
            continue
        if not 330 <= days(d["startDate"], d["endDate"]) <= 400:
            continue
        ctx[cid] = (mem[0][1], d["endDate"])
    out, seen = [], set()
    for el in PAID_ELEMENTS:
        for m in re.finditer(rf"<us-gaap:{el}\b([^>]*)>\s*([-0-9.]+)\s*<", xml):
            ref = re.search(r'contextRef="([^"]+)"', m.group(1))
            if not ref or ref.group(1) not in ctx:
                continue
            member, end = ctx[ref.group(1)]
            prefix, local = member.split(":", 1) if ":" in member else ("", member)
            if prefix == "country":
                name = country_name(local.upper()) or local.upper()
            elif prefix == "stpr":
                name = STATES.get(local.upper()) or local.upper()
            elif member in STANDARD_MEMBERS:
                name = STANDARD_MEMBERS[member][1]
            else:
                name = labels.get(member) or words(local)
            key = (end, el, member)
            if key in seen:
                continue
            seen.add(key)
            out.append({"period_end": end, "element": el, "jurisdiction": member, "name": name, "amount": float(m.group(2))})
    return out


def group(row):
    """Which part of the breakdown a jurisdiction row belongs to: federal, state, foreign, or None (unknown)."""
    j = row["jurisdiction"]
    if j.startswith("stpr:"):
        return "state"
    if j.startswith("country:"):
        return "federal" if j == "country:US" else "foreign"
    if j in STANDARD_MEMBERS:
        return STANDARD_MEMBERS[j][0]
    return GROUP_OF_ELEMENT.get(row["element"])


TOTAL_MEMBERS = {"federal": {"us-gaap:DomesticCountryMember", "us-gaap:FederalMember", "country:US"},
                 "state": {"us-gaap:StateAndLocalJurisdictionMember"}, "foreign": {"us-gaap:ForeignCountryMember"}}


def breakdown(year, rows):
    """The same sums the company page shows (taxesTree() in functions/_lib/taxes.js), to report a year whose
    parts don't add up to its total. -> {total, parts: {federal, state, foreign}, gap} (None when unknown)."""
    rows = [r for r in rows if r["period_end"] == year["period_end"]]
    field = {"federal": "paid_federal", "state": "paid_state", "foreign": "paid_foreign"}
    parts = {}
    for g in ("federal", "state", "foreign"):
        tagged = year.get(field[g])
        if tagged is None:
            tot = [r for r in rows if r["jurisdiction"] in TOTAL_MEMBERS[g] and group(r) == g]
            tagged = tot[0]["amount"] if tot else None
        places = {}
        for r in rows:  # one amount per place: the group's own element over the total's
            if group(r) == g and r["jurisdiction"] not in TOTAL_MEMBERS[g]:
                if r["jurisdiction"] not in places or r["element"] != "IncomeTaxesPaidNet":
                    places[r["jurisdiction"]] = r["amount"]
        parts[g] = tagged if tagged is not None else (sum(places.values()) if places else None)
    total = year.get("taxes_paid")
    known = [v for v in parts.values() if v is not None]
    gap = None if total is None or not known else round(total - sum(known), 2)
    return {"total": total, "parts": parts, "gap": gap}


def upsert(table, cols, keys, rows, per=50):
    """Multi-row upserts that write a row only when one of its values changed (D1 bills every row written)."""
    out = []
    upd = [c for c in cols if c not in keys]
    tail = (f" ON CONFLICT ({', '.join(keys)}) DO UPDATE SET {', '.join(f'{c} = excluded.{c}' for c in upd)}"
            f" WHERE {' OR '.join(f'{table}.{c} IS NOT excluded.{c}' for c in upd)};") if upd else " ON CONFLICT DO NOTHING;"
    for i in range(0, len(rows), per):
        vals = ",\n".join("(" + ", ".join(lit(r.get(c)) for c in cols) + ")" for r in rows[i:i + per])
        out.append(f"INSERT INTO {table} ({', '.join(cols)}) VALUES\n{vals}{tail}")
    return out


COMPANY_COLS = ["cik", "name", "name_key", "tickers", "sic", "sic_desc", "state", "fy_end", "latest_end", "latest_fy", "revenue", "pretax", "taxes_paid", "source_url"]
YEAR_COLS = ["cik", "period_end", "period_start", "fy", "taxes_paid", "paid_federal", "paid_state", "paid_foreign", "current_federal",
             "current_state", "deferred", "pretax", "pretax_tag", "pretax_us", "pretax_foreign", "revenue", "revenue_tag", "src"]
JUR_COLS = ["cik", "period_end", "element", "jurisdiction", "name", "amount", "accn"]
ORG_COLS = ["cik", "kind", "org_name", "how", "summary"]


def company_row(cik, sub, years):
    top = latest(years) or {}
    return {
        "cik": cik, "name": sub.get("name") or "", "name_key": name_key(sub.get("name")),
        "tickers": ",".join(sub.get("tickers") or []) or None, "sic": sub.get("sic") or None, "sic_desc": sub.get("sicDescription") or None,
        "state": business_state(sub), "fy_end": sub.get("fiscalYearEnd") or None,
        "latest_end": top.get("period_end"), "latest_fy": top.get("fy"), "revenue": top.get("revenue"), "pretax": top.get("pretax"),
        "taxes_paid": top.get("taxes_paid"),
        "source_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik:010d}&type=10-K",
    }


def year_rows(cik, years):
    return [{**y, "cik": cik, "src": json.dumps(y["src"], sort_keys=True)} for y in years]


ORG_QUERIES = {
    # kind: SQL giving name, year, n (records), total, source_url. Grouped so a page never has to.
    "pac": "SELECT name, cycle AS year, SUM(count) AS n, SUM(total) AS total, MIN(source_url) AS source_url FROM funding_pacs GROUP BY name, cycle",
    "lobbying": "SELECT client_name AS name, filing_year AS year, COUNT(*) AS n, SUM(amount) AS total, MAX(source_url) AS source_url FROM lobbying_filings GROUP BY client_name, filing_year",
    "ld203": "SELECT f.registrant_name AS name, f.filing_year AS year, COUNT(DISTINCT f.filing_uuid) AS n, SUM(c.amount) AS total, MAX(f.source_url) AS source_url "
             "FROM lobby_contrib_filings f JOIN lobby_contributions c ON c.filing_uuid = f.filing_uuid WHERE f.filer_type = 'organization' GROUP BY f.registrant_name, f.filing_year",
    "ca-lobbying": "SELECT employer_name AS name, substr(period_end, 1, 4) AS year, COUNT(*) AS n, SUM(amount) AS total, MAX(source_url) AS source_url FROM ca_lobby_reports GROUP BY employer_name, substr(period_end, 1, 4)",
}


def summarize(rows):
    """One organization's rows (by year) as {total, count, first, last, source_url, by_year}."""
    years = sorted({str(r["year"]) for r in rows if r.get("year") is not None})
    by_year = {}
    for r in rows:
        y = str(r.get("year"))
        by_year[y] = by_year.get(y, 0) + (r.get("total") or 0)
    return {"total": sum(r.get("total") or 0 for r in rows), "count": sum(r.get("n") or 0 for r in rows),
            "first": years[0] if years else None, "last": years[-1] if years else None,
            "source_url": next((r["source_url"] for r in sorted(rows, key=lambda r: str(r.get("year")), reverse=True) if r.get("source_url")), None),
            "by_year": by_year}


def match_orgs(companies, found, confirmed):
    """Organizations matched to one company: by exact name key when exactly one company has it, or by a
    person's confirmed link (org key -> CIK). found: {kind: [rows with name]}. -> company_orgs rows."""
    by_key = {}
    for c in companies:
        by_key.setdefault(c["name_key"], []).append(c["cik"])
    out = []
    for kind, rows in found.items():
        groups = {}
        for r in rows:
            groups.setdefault(r["name"], []).append(r)
        for name, rs in groups.items():
            key = name_key(name)
            if not key:
                continue
            if key in confirmed:
                cik, how = confirmed[key], "confirmed"
            elif len(by_key.get(key, [])) == 1:
                cik, how = by_key[key][0], "name"
            else:
                continue
            out.append({"cik": cik, "kind": kind, "org_name": name, "how": how, "summary": json.dumps(summarize(rs), sort_keys=True)})
    return out


def measure_money(path):
    """California's 2026 ballot measure money by organization (data/elections/measure-money-*.json), as rows."""
    try:
        d = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return []
    rows = []
    for o in (d.get("orgs") or {}).values():
        gave = sum(g.get("total") or 0 for g in o.get("gave") or [])
        spent = sum(x.get("total") or 0 for x in o.get("spent") or [])
        src = next((g.get("source_url") for g in (o.get("gave") or []) + (o.get("spent") or []) if g.get("source_url")), None)
        rows.append({"name": o.get("name") or "", "year": 2026, "n": len(o.get("gave") or []) + len(o.get("spent") or []), "total": gave + spent, "source_url": src})
    return rows


# ---------------------------------------------------------------------------
# Fetching


_last = [0.0]


def get(url, timeout=120):
    """EDGAR asks for at most 10 requests a second and a contact in the User-Agent."""
    wait = 0.15 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    for pause in (5, 30, None):
        try:
            _last[0] = time.time()
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"}), timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            if pause is None or (isinstance(e, urllib.error.HTTPError) and e.code in (403, 404)):
                raise
            time.sleep(pause)


def download(url, path):
    if path.exists() and time.time() - path.stat().st_mtime < 20 * 3600:
        return path
    say(f"Downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 22)
            if not chunk:
                break
            f.write(chunk)
    return path


def filing_files(cik, accn):
    """A 10-K's XBRL instance (the *_htm.xml EDGAR extracts from inline XBRL) and its label linkbase,
    from the filing's index. -> (instance url or None, label url or None)."""
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn.replace('-', '')}/"
    items = json.loads(get(base + "index.json"))["directory"]["item"]
    names = [i["name"] for i in items]
    x = next((n for n in names if n.endswith("_htm.xml")), None) or next((n for n in names if re.search(r"\d{8}\.xml$", n) and not re.search(r"_(cal|def|lab|pre)\.xml$", n)), None)
    lab = next((n for n in names if n.endswith("_lab.xml")), None)
    return (base + x if x else None), (base + lab if lab else None)


def instance_url(cik, accn):
    return filing_files(cik, accn)[0]


def country_namer():
    try:
        import pycountry
    except ImportError:
        return lambda code: None

    def name(code):
        c = pycountry.countries.get(alpha_2=code)
        return getattr(c, "common_name", None) or (c.name if c else None)
    return name


# ---------------------------------------------------------------------------


def report_breakdowns(args, companies, years, jur):
    """Each company's latest year with a breakdown, and whether its parts add up to its total taxes paid:
    the rows read this run plus, in load mode, the ones already in D1."""
    rows = {(r["cik"], r["period_end"], r["element"], r["jurisdiction"]): r for r in jur}
    if args.mode == "load":
        for r in d1(args, command="SELECT cik, period_end, element, jurisdiction, name, amount FROM company_tax_jurisdictions"):
            rows.setdefault((r["cik"], r["period_end"], r["element"], r["jurisdiction"]), r)
    names = {c["cik"]: c["name"] for c in companies}
    ok, off, none = [], [], 0
    for c in companies:
        ys = [y for y in years if y["cik"] == c["cik"] and y.get("taxes_paid") is not None]
        mine = [r for r in rows.values() if r["cik"] == c["cik"]]
        y = next((y for y in reversed(ys) if y.get("paid_federal") is not None or y.get("paid_state") is not None or y.get("paid_foreign") is not None
                  or any(r["period_end"] == y["period_end"] for r in mine)), None)
        if not y:
            none += 1
            continue
        b = breakdown(y, mine)
        (ok if b["gap"] == 0 else off).append((c["cik"], names[c["cik"]], y["period_end"], b))
    say(f"Taxes paid by place: {len(ok)} companies add up, {len(off)} don't, {none} file no breakdown")
    for cik, name, end, b in off:
        p = b["parts"]
        say(f"  doesn't add up: {name} (CIK {cik}) {end}: total {b['total']}, federal {p['federal']}, state {p['state']}, foreign {p['foreign']}, gap {b['gap']}")


def ensure_tables(args):
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    for name in ("0047_company_taxes.sql", "0049_company_tax_reader.sql"):
        if not d1(args, command=f"SELECT 1 AS x FROM d1_migrations WHERE name = '{name}'"):
            d1(args, file=MIGRATIONS / name)
            d1(args, command=f"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('{name}')")
            say(f"Applied migration {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--cache", default=os.environ.get("RUNNER_TEMP", "/tmp"))
    ap.add_argument("--max-instances", type=int, default=6000, help="10-K XBRL instances read this run for jurisdictions")
    ap.add_argument("--limit", type=int, default=0, help="companies read (0: all); for trying the reader")
    ap.add_argument("--top", type=int, default=100, help="keep the N largest companies by their latest revenue (0: every company)")
    args = ap.parse_args()
    cache = Path(args.cache)
    subs_zip = zipfile.ZipFile(download(SUBMISSIONS_ZIP, cache / "submissions.zip"))
    facts_zip = zipfile.ZipFile(download(FACTS_ZIP, cache / "companyfacts.zip"))
    facts_names = set(facts_zip.namelist())

    companies, years, filings = [], [], {}
    read = 0
    for n in subs_zip.namelist():
        if not re.fullmatch(r"CIK\d{10}\.json", n) or n not in facts_names:
            continue
        sub = json.loads(subs_zip.read(n))
        tks = ten_ks(sub)
        if not tks:
            continue
        cik = int(n[3:13])
        facts = json.loads(facts_zip.read(n)).get("facts", {}).get("us-gaap", {})
        ys = company_years(facts)
        if not ys:
            continue
        companies.append(company_row(cik, sub, ys))
        years += year_rows(cik, ys)
        # Taxes paid by place (ASU 2023-09): the 10-Ks that tag federal / state / foreign taxes paid, and every
        # original 10-K for a year ending since December 2024 (a breakdown can be filed only by place, with no
        # undimensioned total), each read once by the current READER.
        accns = sorted({y["src"][f] for y in ys for f in ("paid_federal", "paid_state", "paid_foreign") if y["src"].get(f)} | breakdown_filings(sub))
        if accns:
            filings[cik] = accns
        read += 1
        if args.limit and read >= args.limit:
            break
    say(f"{len(companies)} companies with a 10-K since 2019 and tax or pretax values; {len(years)} company-years")
    if args.top:
        # The N largest by revenue in their latest fiscal year with figures (never by taxes paid or any rate).
        keep = {c["cik"] for c in largest(companies, args.top)}
        companies = [c for c in companies if c["cik"] in keep]
        years = [y for y in years if y["cik"] in keep]
        filings = {cik: a for cik, a in filings.items() if cik in keep}
        say(f"Kept the {len(companies)} largest by revenue; {len(years)} company-years")
        say("  " + "; ".join(f"{c['name']} ({c['latest_fy']})" for c in largest(companies, len(companies))))
    for f in ("taxes_paid", "paid_federal", "paid_state", "paid_foreign", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"):
        say(f"  {f}: {sum(1 for y in years if y.get(f) is not None)} company-years tagged")

    jur, done_accns, done = [], [], set()
    if args.mode == "load":
        ensure_tables(args)
        done = {r["accn"] for r in d1(args, command=f"SELECT accn FROM company_tax_filings WHERE reader >= {READER}")}
    name = country_namer()
    todo = [(cik, a) for cik, accns in sorted(filings.items()) for a in accns if a not in done]
    say(f"{len(todo)} 10-Ks to read for taxes paid by jurisdiction (at most {args.max_instances} this run)")
    for cik, accn in todo[: args.max_instances // 2]:
        try:
            url, lab = filing_files(cik, accn)
            xml = get(url).decode("utf-8", "replace") if url else ""
            labels = member_labels(get(lab).decode("utf-8", "replace")) if lab and custom_members(xml) else {}
            rows = jurisdictions(xml, name, labels) if xml else []
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
            say(f"  CIK {cik} {accn}: not read ({getattr(e, 'code', e)})")
            continue
        for r in rows:
            jur.append({**r, "cik": cik, "accn": accn})
        done_accns.append({"accn": accn, "cik": cik, "found": len(rows), "reader": READER})
    say(f"{len(done_accns)} 10-Ks read; {len(jur)} jurisdiction amounts")

    # What ThePillory already has for the same organizations (D1 and the measure money file).
    orgs = []
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        found = {}
        for kind, q in ORG_QUERIES.items():
            try:
                found[kind] = d1(args, command=q)
            except SystemExit as e:
                say(f"  {kind}: not read ({str(e)[:200]})")
        found["ca-measures"] = measure_money(next(iter(sorted((Path(__file__).resolve().parent.parent / "data" / "elections").glob("measure-money-*.json"), reverse=True)), ""))
        try:
            confirmed = {r["org_key"]: r["cik"] for r in d1(args, command="SELECT org_key, cik FROM company_org_links")}
        except SystemExit:
            confirmed = {}
        orgs = match_orgs(companies, found, confirmed)
        for kind in found:
            say(f"  {kind}: {sum(1 for o in orgs if o['kind'] == kind)} organizations matched to one company")

    sql = upsert("companies", COMPANY_COLS, ["cik"], companies)
    sql += upsert("company_tax_years", YEAR_COLS, ["cik", "period_end"], years)
    sql += upsert("company_tax_jurisdictions", JUR_COLS, ["cik", "period_end", "element", "jurisdiction"], jur)
    sql += upsert("company_tax_filings", ["accn", "cik", "found", "reader"], ["accn"], done_accns)
    # A filing read again: its rows the reader no longer finds are removed (after the upserts, so a row that
    # moved to a newer filing keeps it).
    for f in done_accns:
        keep = [(r["period_end"], r["element"], r["jurisdiction"]) for r in jur if r["accn"] == f["accn"]]
        sql += prune("company_tax_jurisdictions", {"cik": f["cik"], "accn": f["accn"]}, ["period_end", "element", "jurisdiction"], keep)
    if orgs:
        sql += upsert("company_orgs", ORG_COLS, ["cik", "kind", "org_name"], orgs)
        if args.mode == "load":
            # A match that no longer holds (a name changed, a second company took the same name) is removed.
            now = {(o["cik"], o["kind"], o["org_name"]) for o in orgs}
            for r in d1(args, command="SELECT cik, kind, org_name FROM company_orgs"):
                if (r["cik"], r["kind"], r["org_name"]) not in now:
                    sql.append(f"DELETE FROM company_orgs WHERE cik = {lit(r['cik'])} AND kind = {lit(r['kind'])} AND org_name = {lit(r['org_name'])};")
    if args.top and args.mode == "load" and companies:
        # Companies that dropped out of the N are removed with their years, jurisdictions and matches.
        keep = ", ".join(str(c["cik"]) for c in companies)
        for t in ("company_tax_years", "company_tax_jurisdictions", "company_orgs", "companies"):
            sql.append(f"DELETE FROM {t} WHERE cik NOT IN ({keep});")
    report_breakdowns(args, companies, years, jur)
    say(f"{len(sql)} SQL statements")
    if args.mode == "load":
        run_sql(args, sql)
        say("Written to D1 (changed rows only)")


if __name__ == "__main__":
    main()
