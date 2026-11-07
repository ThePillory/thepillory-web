#!/usr/bin/env python3
"""Company taxes from SEC EDGAR, into D1 (migration 0047): the weekly "Refresh
company taxes" workflow (.github/workflows/company-taxes.yml). See docs/taxes.md.

For every company that filed a 10-K since 2019: the values its financial
statements tag in XBRL, by fiscal year, each with the filing it comes from:

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
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
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
    """{period end: chosen fact}: the latest-filed 10-K's value (a restatement replaces the original),
    with the fiscal year as the year's own (earliest-filed) 10-K names it, and that year's start."""
    groups = {}
    for f in annual(facts):
        groups.setdefault(f["end"], []).append(f)
    out = {}
    for end, fs in groups.items():
        latest = max(fs, key=lambda f: (f.get("filed", ""), f.get("accn", "")))
        first = min(fs, key=lambda f: (f.get("filed", ""), f.get("accn", "")))
        out[end] = {"val": latest["val"], "accn": latest["accn"], "start": latest["start"], "fy": first.get("fy")}
    return out


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
    return [y for y in sorted(years.values(), key=lambda r: r["period_end"]) if any(y.get(f) is not None for f in FIELDS if f != "revenue")]


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


def jurisdictions(xml, country_name):
    """Taxes paid by one jurisdiction from a 10-K's XBRL instance: facts of PAID_ELEMENTS whose only
    dimension is IncomeTaxAuthorityAxis with a country (country:XX) or U.S. state (stpr:XX) member,
    for a period of 330 to 400 days. Aggregate members (domestic, foreign, other) and company-defined
    members are left out. [{period_end, element, jurisdiction, name, amount}]."""
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
            code = None
            name = None
            if member.startswith("country:"):
                code = member.split(":", 1)[1].upper()
                name = country_name(code)
            elif member.startswith("stpr:"):
                code = member.split(":", 1)[1].upper()
                name = STATES.get(code)
            if not name:
                continue
            key = (end, el, member)
            if key in seen:
                continue
            seen.add(key)
            out.append({"period_end": end, "element": el, "jurisdiction": member, "name": name, "amount": float(m.group(2))})
    return out


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


def instance_url(cik, accn):
    """A 10-K's XBRL instance (the *_htm.xml EDGAR extracts from inline XBRL), from the filing's index."""
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn.replace('-', '')}/"
    items = json.loads(get(base + "index.json"))["directory"]["item"]
    names = [i["name"] for i in items]
    x = next((n for n in names if n.endswith("_htm.xml")), None) or next((n for n in names if re.search(r"\d{8}\.xml$", n) and not re.search(r"_(cal|def|lab|pre)\.xml$", n)), None)
    return base + x if x else None


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


def ensure_tables(args):
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    name = "0047_company_taxes.sql"
    if not d1(args, command=f"SELECT 1 AS x FROM d1_migrations WHERE name = '{name}'"):
        d1(args, file=MIGRATIONS / name)
        d1(args, command=f"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('{name}')")
        say(f"Applied migration {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--cache", default=os.environ.get("RUNNER_TEMP", "/tmp"))
    ap.add_argument("--max-instances", type=int, default=1500, help="10-K XBRL instances read this run for jurisdictions")
    ap.add_argument("--limit", type=int, default=0, help="companies read (0: all); for trying the reader")
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
        # 10-Ks filing taxes paid by federal / state / foreign (ASU 2023-09) may also file them by jurisdiction.
        if any(y.get(f) is not None for y in ys for f in ("paid_federal", "paid_state", "paid_foreign")):
            filings[cik] = [a for a, filed, _ in tks if filed >= "2025-01-01"]
        read += 1
        if args.limit and read >= args.limit:
            break
    say(f"{len(companies)} companies with a 10-K since 2019 and tax or pretax values; {len(years)} company-years")
    for f in ("taxes_paid", "paid_federal", "paid_state", "paid_foreign", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"):
        say(f"  {f}: {sum(1 for y in years if y.get(f) is not None)} company-years tagged")

    jur, done_accns, done = [], [], set()
    if args.mode == "load":
        ensure_tables(args)
        done = {r["accn"] for r in d1(args, command="SELECT accn FROM company_tax_filings")}
    name = country_namer()
    todo = [(cik, a) for cik, accns in sorted(filings.items()) for a in accns if a not in done]
    say(f"{len(todo)} 10-Ks to read for taxes paid by jurisdiction (at most {args.max_instances} this run)")
    for cik, accn in todo[: args.max_instances // 2]:
        try:
            url = instance_url(cik, accn)
            rows = jurisdictions(get(url).decode("utf-8", "replace"), name) if url else []
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
            say(f"  CIK {cik} {accn}: not read ({getattr(e, 'code', e)})")
            continue
        for r in rows:
            jur.append({**r, "cik": cik, "accn": accn})
        done_accns.append({"accn": accn, "cik": cik, "found": len(rows)})
    say(f"{len(done_accns)} 10-Ks read; {len(jur)} jurisdiction amounts")

    sql = upsert("companies", COMPANY_COLS, ["cik"], companies)
    sql += upsert("company_tax_years", YEAR_COLS, ["cik", "period_end"], years)
    sql += upsert("company_tax_jurisdictions", JUR_COLS, ["cik", "period_end", "element", "jurisdiction"], jur)
    sql += upsert("company_tax_filings", ["accn", "cik", "found"], ["accn"], done_accns)
    say(f"{len(sql)} SQL statements")
    if args.mode == "load":
        run_sql(args, sql)
        say("Written to D1 (changed rows only)")


if __name__ == "__main__":
    main()
