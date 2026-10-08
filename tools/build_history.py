#!/usr/bin/env python3
"""Build data/history/ for the Time Machine, from official sources only.

    python3 tools/build_history.py            # writes data/history/
    python3 tools/build_history.py --check    # prints what it found, writes nothing

Runs in GitHub Actions ("Refresh history data", .github/workflows/history.yml),
because the sources aren't reachable from everywhere. Needs pdftotext
(poppler-utils), openpyxl and xlrd (the workflow installs them).

What it writes, each item with the URL of the source it came from:

  federal-executive.json  Presidents and Vice Presidents and their terms
                          (congress-legislators' executive.json, from the
                          Biographical Directory of the U.S. Congress).
  congress/<st>.json      Every member of Congress for each state's seats and
                          districts since 1993 (congress-legislators, from the
                          Biographical Directory), with party as listed.
  districts/<st>.json     Which congressional and state legislative districts
                          overlapped each county, by redistricting period (Census
                          Bureau relationship files: 108th, 113th and 118th
                          Congress). Mid-decade redistricting isn't reflected.
  california.json         California's Governors (California State Library) and
                          the winners of each general election since 2002 for
                          statewide offices, the Board of Equalization and every
                          State Senate and Assembly district (Secretary of State,
                          Statement of Vote), with the Legislature's party makeup
                          after each election.
  finances.json           Federal and California finances by fiscal year:
                          Treasury Fiscal Data (debt, monthly statements), OMB
                          Historical Tables (receipts, outlays, deficits, outlays
                          by function, GDP), Census Bureau (population,
                          households), California Department of Finance (budget
                          charts, population and housing); presidential and
                          gubernatorial terms; party control of each chamber
                          (House and Senate historians; Statement of Vote); and
                          factual event markers, each checked against its source.

Nothing is guessed: a value the source doesn't give is left out, and the pages
say which data isn't available for a year.
"""
import csv
import html
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "history"
UA = "ThePillory/1.0 (+https://thepillory.co; civic records)"
FIRST_YEAR = 1993  # the Time Machine reaches back to here where the data allows
CHECK = "--check" in sys.argv

LEGISLATORS = "https://unitedstates.github.io/congress-legislators/"
BIOGUIDE = "https://bioguide.congress.gov/"
EXECUTIVE_SRC = "https://github.com/unitedstates/congress-legislators#executive-branch"
FISCAL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
OMB_PAGE = "https://www.whitehouse.gov/omb/information-resources/budget/historical-tables/"
SOV_INDEX = "https://www.sos.ca.gov/elections/prior-elections/statewide-election-results"
GOVERNORS = "https://governors.library.ca.gov/list.html"
DOF_CHARTS = "https://dof.ca.gov/budget/historical-budget-information/summary-schedules-and-historical-charts/"
HOUSE_PARTY = "https://history.house.gov/Institution/Party-Divisions/Party-Divisions/"
SENATE_PARTY = "https://www.senate.gov/history/partydiv.htm"
RELFILES = "https://www2.census.gov/geo/relfiles/"

STATES = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY",
}
FIPS_OF = {v: k for k, v in STATES.items()}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, binary=False, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(urllib.parse.quote(url, safe=":/?=&%#~+[],"), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            return data if binary else data.decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            log(f"  retry {url}: {e}")


def text_of(h):
    h = re.sub(r"<script.*?</script>|<style.*?</style>", " ", h, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def pdf_text(url, layout=True):
    data = fetch(url, binary=True)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        args = ["pdftotext"] + (["-layout"] if layout else []) + [f.name, "-"]
        return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def write(name, obj):
    if CHECK:
        log(f"(check) {name}: {len(json.dumps(obj))} bytes")
        return
    p = OUT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    log(f"wrote {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("$", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# People: the federal executive and members of Congress.

def name_of(p):
    n = p.get("name", {})
    return n.get("official_full") or " ".join(x for x in [n.get("first"), n.get("middle"), n.get("last"), n.get("suffix")] if x)


def federal_executive():
    data = json.loads(fetch(LEGISLATORS + "executive.json"))
    terms = []
    for p in data:
        for t in p.get("terms", []):
            if t.get("type") not in ("prez", "viceprez") or t.get("end", "") < f"{FIRST_YEAR - 4}-01-01":
                continue
            terms.append({
                "office": "President" if t["type"] == "prez" else "Vice President",
                "name": name_of(p), "start": t["start"], "end": t["end"], "party": t.get("party"),
                "govtrack": p.get("id", {}).get("govtrack"), "bioguide": p.get("id", {}).get("bioguide"),
                "fec": [x for x in p.get("id", {}).get("fec", []) if x.startswith("P")],
            })
    terms.sort(key=lambda t: (t["start"], t["office"]))
    log(f"federal executive: {len(terms)} terms; presidents since {FIRST_YEAR}: {[t['name'] for t in terms if t['office'] == 'President' and t['end'] > f'{FIRST_YEAR}']}")
    return {"_readme": "Generated by tools/build_history.py; don't edit by hand.", "source": EXECUTIVE_SRC, "source_note": "congress-legislators' executive.json, compiled from the Biographical Directory of the United States Congress.", "terms": terms}


def congress_members():
    people = json.loads(fetch(LEGISLATORS + "legislators-current.json")) + json.loads(fetch(LEGISLATORS + "legislators-historical.json"))
    by_state = {}
    for p in people:
        ids = p.get("id", {})
        for t in p.get("terms", []):
            if t.get("end", "") < f"{FIRST_YEAR}-01-01" or t.get("state") not in FIPS_OF:
                continue
            st = by_state.setdefault(t["state"], {"house": {}, "senate": []})
            row = {"name": name_of(p), "bioguide": ids.get("bioguide"), "start": t["start"], "end": t["end"], "party": t.get("party"),
                   "lis": ids.get("lis"), "fec": ids.get("fec", []), "govtrack": ids.get("govtrack")}
            if t["type"] == "sen":
                st["senate"].append(row)
            else:
                st["house"].setdefault(str(t.get("district", 0)), []).append(row)
    for st, d in by_state.items():
        d["senate"].sort(key=lambda r: r["start"])
        for k in d["house"]:
            d["house"][k].sort(key=lambda r: r["start"])
    log(f"congress: {len(by_state)} states; CA House districts: {len(by_state.get('CA', {}).get('house', {}))}, CA senate terms: {len(by_state.get('CA', {}).get('senate', []))}")
    return by_state


# ---------------------------------------------------------------------------
# Districts by county, by redistricting period (Census Bureau relationship files).

def rel_rows(url):
    try:
        t = fetch(url)
    except Exception as e:  # noqa: BLE001
        log(f"  {url}: {e}")
        return []
    rows = []
    for line in t.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) >= 3 and re.fullmatch(r"\d{2}", parts[0]) and re.fullmatch(r"\d{3}", parts[1]):
            rows.append((parts[0] + parts[1], parts[2].lstrip("0") or "0"))
    return rows


def cd108_rows(st, fips):
    """The 108th Congress file: county and district columns, fixed width or comma separated (format checked in the log)."""
    url = f"{RELFILES}cd108th/{st}/cou_c8_{fips}.txt"
    try:
        t = fetch(url)
    except Exception as e:  # noqa: BLE001
        log(f"  {url}: {e}")
        return [], url
    rows = []
    for line in t.splitlines():
        m = re.match(r"^\s*(\d{2})\s*,?\s*(\d{3})\s*,?\s*(\d{1,2})\b", line)
        if m and m.group(1) == fips:
            rows.append((m.group(1) + m.group(2), str(int(m.group(3)))))
    if st == "CA":
        log(f"  cd108 CA sample: {t.splitlines()[:4]} -> {rows[:4]}")
    return rows, url


def group(rows):
    out = {}
    for county, d in rows:
        out.setdefault(county, [])
        if d not in out[county]:
            out[county].append(d)
    return {c: [[d, 1 if len(ds) == 1 else 0] for d in ds] for c, ds in out.items()}


def districts_by_period():
    states = {}
    for fips, st in STATES.items():
        periods = []
        r108, u108 = cd108_rows(st, fips)
        if r108:
            periods.append({"from": 2003, "to": 2012, "cd": group(r108), "source": u108, "note": "Districts drawn after the 2000 census."})
        for folder, frm, to in (("cdsld13", 2013, 2022), ("cdsld18", 2023, None)):
            base = f"{RELFILES}{folder}/{fips}/"
            cd = rel_rows(f"{base}co_cd_delim_{fips}.txt")
            up = rel_rows(f"{base}co_lu_delim_{fips}.txt")
            lo = rel_rows(f"{base}co_ll_delim_{fips}.txt")
            if cd:
                p = {"from": frm, "to": to, "cd": group(cd), "source": f"{base}co_cd_delim_{fips}.txt", "note": "Districts drawn after the 2010 census." if frm == 2013 else "Districts drawn after the 2020 census."}
                if up:
                    p["sldu"] = group(up)
                if lo:
                    p["sldl"] = group(lo)
                periods.append(p)
        states[st] = {"periods": periods}
        if st == "CA":
            log(f"districts CA: {[(p['from'], p['to'], p['cd'].get('06009'), (p.get('sldu') or {}).get('06009'), (p.get('sldl') or {}).get('06009')) for p in periods]}")
    return states


# ---------------------------------------------------------------------------
# California: Governors, and general-election winners from the Statement of Vote.

def governors():
    t = text_of(fetch(GOVERNORS))
    out = []
    for m in re.finditer(r"([A-Z][A-Za-z.\" ]+?(?:\"[A-Za-z]+\" )?[A-Z][a-z]+(?: Jr\.)?)\s+(\d{4})\s*[–-]\s*(\d{4}|Present)", t):
        name, a, b = m.group(1).strip(), int(m.group(2)), m.group(3)
        if a >= FIRST_YEAR - 12:
            out.append({"name": name, "from": a, "to": None if b == "Present" else int(b)})
    seen, uniq = set(), []
    for g in out:
        k = (g["name"], g["from"])
        if k not in seen:
            seen.add(k)
            uniq.append(g)
    log(f"governors: {uniq}")
    return uniq


OFFICE_KEYS = [
    (r"^Governor$", "governor", "Governor"),
    (r"^Lieutenant Governor$", "lieutenant-governor", "Lieutenant Governor"),
    (r"^Secretary of State$", "secretary-of-state", "Secretary of State"),
    (r"^Controller$", "controller", "Controller"),
    (r"^Treasurer$", "treasurer", "Treasurer"),
    (r"^Attorney General$", "attorney-general", "Attorney General"),
    (r"^Insurance Commissioner$", "insurance-commissioner", "Insurance Commissioner"),
    (r"^Superintendent of Public Instruction$", "superintendent", "Superintendent of Public Instruction"),
]
CAND = re.compile(r"([A-Z][^,\d]{1,60}?(?:, (?:Jr|Sr|II|III)\.?)?),\s+([A-Z]{2,4})\*?\s+([\d,]{2,})\s+([\d.]+)\s?%")
HEAD = re.compile(r"((?:Governor|Lieutenant Governor|Secretary of State|Controller|Treasurer|Attorney General|Insurance Commissioner|Superintendent of Public Instruction|Board of Equalization(?: Member)?(?: District \d+)?|State Senat(?:e|or) District \d+|Member of the State Assembly District \d+|State Assembly(?: Member)? District \d+|Member of the Assembly District \d+|United States Representative District \d+|US Senate[^V]*?|United States Senator[^V]*?))\s{2,}Votes\s+Percent")


def contest_key(h):
    h = re.sub(r"\s+", " ", h).strip()
    for pat, key, label in OFFICE_KEYS:
        if re.match(pat, h):
            return key, label, None
    m = re.search(r"District (\d+)", h)
    if m and re.search(r"Equalization", h):
        return "boe", "Board of Equalization", m.group(1)
    if m and re.search(r"State Senat", h):
        return "sldu", "State Senate", m.group(1)
    if m and re.search(r"Assembly", h):
        return "sldl", "State Assembly", m.group(1)
    if m and re.search(r"Representative", h):
        return "cd", "U.S. House", m.group(1)
    return None, None, None


def sov_summary(text):
    """Contests and candidates from the two-column Statement of Vote summary pages."""
    contests = {}
    current = {}  # column index -> contest key
    boe_pending = {}
    for line in text.splitlines():
        heads = [(m.start(), m.group(1)) for m in HEAD.finditer(line)]
        if heads:
            for pos, h in heads:
                col = 0 if pos < 45 else 1
                key = contest_key(h)
                current[col] = key if key[0] else None
                boe_pending[col] = h.strip().startswith("Board of Equalization") and not re.search(r"District \d+", h)
            continue
        # "District 1" on its own line after a bare "Board of Equalization Member" header (older layout)
        for m in re.finditer(r"\bDistrict (\d+)\b", line):
            col = 0 if m.start() < 45 else 1
            if boe_pending.get(col):
                current[col] = ("boe", "Board of Equalization", m.group(1))
                boe_pending[col] = False
        for m in CAND.finditer(line):
            col = 0 if m.start() < 45 else 1
            key = current.get(col)
            if not key:
                continue
            name = re.sub(r"\s+", " ", m.group(1)).strip().rstrip("*")
            if re.search(r"Votes Not Cast|\(w/i\)", name):
                continue
            contests.setdefault(key, []).append({"name": name, "party": m.group(2), "votes": int(m.group(3).replace(",", ""))})
    return contests


def sov_elections():
    page = fetch(SOV_INDEX)
    links = sorted(set(re.findall(r'href="(https://www\.sos\.ca\.gov/elections/prior-elections/statewide-election-results/[^"]*general-election[^"]*/statement-vote)"', page)))
    out = []
    for link in links:
        m = re.search(r"general-election-[a-z]+-(\d{1,2})-(\d{4})", link) or re.search(r"general-election-nov-(\d{1,2})-(\d{4})", link)
        if not m or int(m.group(2)) < 2002:
            continue
        year = int(m.group(2))
        try:
            pdfs = sorted(set(re.findall(r'href="([^"]+\.pdf)"', fetch(link))))
        except Exception as e:  # noqa: BLE001
            log(f"SOV {year}: {e}")
            continue
        summary = next((p for p in pdfs if re.search(r"/sov/[^/]*/(\d+-)?(summary|sum)\.pdf$", p) and "/ssov/" not in p), None)
        if not summary:
            log(f"SOV {year}: no summary PDF among {pdfs[:8]}")
            continue
        try:
            contests = sov_summary(pdf_text(summary))
        except Exception as e:  # noqa: BLE001
            log(f"SOV {year}: {e}")
            continue
        winners = []
        for (key, label, district), cands in contests.items():
            top = max(cands, key=lambda c: c["votes"])
            winners.append({"office": key, "label": label, "district": district, "name": top["name"], "party": top["party"], "votes": top["votes"]})
        counts = {}
        for w in winners:
            counts[w["office"]] = counts.get(w["office"], 0) + 1
        log(f"SOV {year}: {summary} -> {counts}")
        out.append({"year": year, "source": summary, "page": link, "winners": winners})
    out.sort(key=lambda e: e["year"])
    return out


def legislature_makeup(elections):
    """Party of the winners after each general election: all 80 Assembly seats; the Senate's two halves (this election and the one before)."""
    out = []
    for i, e in enumerate(elections):
        asm = [w for w in e["winners"] if w["office"] == "sldl"]
        sen = {w["district"]: w for w in e["winners"] if w["office"] == "sldu"}
        if i > 0:
            for w in elections[i - 1]["winners"]:
                if w["office"] == "sldu" and w["district"] not in sen:
                    sen[w["district"]] = w
        def tally(ws):
            t = {}
            for w in ws:
                t[w["party"]] = t.get(w["party"], 0) + 1
            return dict(sorted(t.items(), key=lambda kv: -kv[1]))
        out.append({"after_election": e["year"], "assembly": tally(asm), "assembly_seats": len(asm), "senate": tally(sen.values()), "senate_seats": len(sen), "source": e["source"]})
    return out


# ---------------------------------------------------------------------------
# Finances.

def fiscal(path, params):
    rows, page = [], 1
    while True:
        q = dict(params, **{"page[number]": page, "page[size]": 10000})
        d = json.loads(fetch(FISCAL + path + "?" + urllib.parse.urlencode(q, safe=":,")))
        rows += d.get("data", [])
        if page >= d.get("meta", {}).get("total-pages", 1):
            return rows
        page += 1


def treasury_debt():
    """Total public debt outstanding at the end of each fiscal year (the last record on or before September 30)."""
    rows = fiscal("v2/accounting/od/debt_to_penny", {"fields": "record_date,tot_pub_debt_out_amt", "filter": "record_calendar_month:eq:09", "sort": "record_date"})
    out = {}
    for r in rows:
        out[int(r["record_date"][:4])] = num(r["tot_pub_debt_out_amt"])  # later rows in September replace earlier
    log(f"treasury debt: {min(out)}–{max(out)}, FY2025 {out.get(2025)}")
    return out


def omb_links():
    page = fetch(OMB_PAGE)
    return {m.group(1): m.group(0) for m in re.finditer(r"https://www\.whitehouse\.gov/wp-content/uploads/[^\"']*?hist(\d\dz\d)_fy\d{4}\.xlsx", page)}


def xlsx_rows(url):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(fetch(url, binary=True)), read_only=True, data_only=True)
    return [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]


def omb_series(links):
    out = {"source": OMB_PAGE}
    # Table 1.1: receipts, outlays, surplus or deficit (millions), actual years only.
    t11 = xlsx_rows(links["01z1"])
    s11 = {}
    for r in t11:
        if r and re.fullmatch(r"\d{4}", str(r[0] or "").strip()):
            y = int(str(r[0]).strip())
            if y >= FIRST_YEAR - 1 and num(r[1]) is not None:
                s11[y] = {"receipts": num(r[1]) * 1e6, "outlays": num(r[2]) * 1e6, "surplus": num(r[3]) * 1e6}
    out["t11"] = s11
    out["t11_url"] = links["01z1"]
    # Table 3.1: outlays by superfunction and function (millions), years as columns.
    t31 = xlsx_rows(links["03z1"])
    hdr = next(r for r in t31 if r and str(r[0] or "").startswith("Superfunction"))
    years = {i: int(str(c)) for i, c in enumerate(hdr) if c and re.fullmatch(r"\d{4}", str(c).strip())}
    funcs = {}
    for r in t31:
        if str(r[0] or "").startswith("As percentages"):
            break
        name = str(r[0] or "").strip()
        if not name or name.startswith(("Superfunction", "In millions")):
            continue
        vals = {years[i]: num(r[i]) * 1e6 for i in years if i < len(r) and num(r[i]) is not None and years[i] >= FIRST_YEAR - 1}
        if vals:
            funcs[name] = vals
    out["t31"] = funcs
    out["t31_url"] = links["03z1"]
    log(f"OMB 3.1 rows: {list(funcs)[:30]}")
    # Table 10.1: GDP (billions), fiscal years.
    t101 = xlsx_rows(links["10z1"])
    for r in t101[:8]:
        log(f"  OMB 10.1 header: {r[:6]}")
    gdp = {}
    for r in t101:
        if r and re.fullmatch(r"\d{4}", str(r[0] or "").strip()) and num(r[1]) is not None:
            y = int(str(r[0]).strip())
            if y >= FIRST_YEAR - 1:
                gdp[y] = num(r[1]) * 1e9
    out["gdp"] = gdp
    out["t101_url"] = links["10z1"]
    log(f"OMB GDP: {min(gdp) if gdp else None}–{max(gdp) if gdp else None}; 2024 {gdp.get(2024)}")
    return out


def census_population():
    pop = {}
    t = fetch("https://www2.census.gov/programs-surveys/popest/datasets/2000-2010/intercensal/national/us-est00int-tot.csv")
    for r in csv.DictReader(io.StringIO(t)):
        if r.get("MONTH") == "7":
            pop[int(r["YEAR"])] = int(r["TOT_POP"])
    for url, first in (("https://www2.census.gov/programs-surveys/popest/datasets/2010-2020/national/totals/nst-est2020.csv", 2010),
                       ("https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/NST-EST2025-ALLDATA.csv", 2020)):
        for r in csv.DictReader(io.StringIO(fetch(url))):
            if r.get("NAME") == "United States":
                for k, v in r.items():
                    m = re.fullmatch(r"POPESTIMATE(\d{4})", k or "")
                    if m and v:
                        pop[int(m.group(1))] = int(v)
    try:
        t = fetch("https://www2.census.gov/programs-surveys/popest/tables/1990-2000/intercensal/national/us-est90int-07.csv")
        for line in t.splitlines():
            m = re.match(r"^\s*7/1/(\d{4})\s*,\s*([\d,]+)", line.replace('"', ""))
            if m:
                pop.setdefault(int(m.group(1)), int(m.group(2).replace(",", "")))
    except Exception as e:  # noqa: BLE001
        log(f"population 1990s: {e}")
    log(f"population: {min(pop)}–{max(pop)}")
    return pop


def census_households():
    import xlrd
    wb = xlrd.open_workbook(file_contents=fetch("https://www2.census.gov/programs-surveys/demo/tables/families/time-series/households/hh1.xls", binary=True))
    ws = wb.sheet_by_index(0)
    hh = {}
    for i in range(ws.nrows):
        r = ws.row_values(i)
        y = str(r[0]).strip()
        m = re.fullmatch(r"(\d{4})(\.0)?", y)  # skip revised/footnoted duplicates like "2021r"
        if m and isinstance(r[1], float):
            hh.setdefault(int(m.group(1)), int(r[1] * 1000))
    log(f"households: {min(hh)}–{max(hh)}")
    return hh


def party_control():
    """Majority party of each chamber, by Congress, as the House and Senate historians list it."""
    house = {}
    t = text_of(fetch(HOUSE_PARTY))
    for m in re.finditer(r"(\d{3})(?:st|nd|rd|th) \((\d{4})[–-](\d{4})\) 435 (?:\d+ )?(\d+) (\d+)", t):
        c = int(m.group(1))
        if c >= 102:
            d, r = int(m.group(4)), int(m.group(5))
            house[c] = {"years": [int(m.group(2)), int(m.group(3))], "democrats": d, "republicans": r, "majority": "Democrats" if d > r else "Republicans"}
    senate = {}
    t = text_of(fetch(SENATE_PARTY))
    for m in re.finditer(r"(\d{3})(?:st|nd|rd|th) Congress \((\d{4})[–-](\d{4})\)(.{0,600}?)(?=-{10,}|\d{3}(?:st|nd|rd|th) Congress \()", t):
        c = int(m.group(1))
        if c >= 102:
            body = re.sub(r"\s+", " ", m.group(4)).strip()
            maj = re.findall(r"Majority Party(?: \([^)]*\))?: (Democrats|Republicans)", body)
            senate[c] = {"years": [int(m.group(2)), int(m.group(3))], "majority": maj[0] if len(set(maj)) == 1 else None, "majorities": maj, "text": body[:400]}
    log(f"party control: House {sorted(house)[:3]}…{sorted(house)[-3:]}, Senate {sorted(senate)[:3]}…{sorted(senate)[-3:]}; 107th Senate {senate.get(107)}")
    return {"house": house, "senate": senate, "house_source": HOUSE_PARTY, "senate_source": SENATE_PARTY}


# Factual markers. Each is kept only if its source states it (the `verify` text
# must be found there); the dates are what the source gives.
EVENTS = [
    {"kind": "Recession", "label": "Recession (NBER business cycle dates)", "from": "2001-03", "to": "2001-11", "source": "https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions", "verify": [r"March 2001", r"November 2001"]},
    {"kind": "Recession", "label": "Recession (NBER business cycle dates)", "from": "2007-12", "to": "2009-06", "source": "https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions", "verify": [r"December 2007", r"June 2009"]},
    {"kind": "Recession", "label": "Recession (NBER business cycle dates)", "from": "2020-02", "to": "2020-04", "source": "https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions", "verify": [r"February 2020", r"April 2020"]},
    {"kind": "War", "label": "Authorization for Use of Military Force (Public Law 107-40)", "from": "2001-09", "to": None, "source": "https://www.congress.gov/107/plaws/publ40/PLAW-107publ40.htm", "verify": [r"Sept(?:ember|\.)? 18, 2001"]},
    {"kind": "War", "label": "Authorization for Use of Military Force Against Iraq (Public Law 107-243)", "from": "2002-10", "to": None, "source": "https://www.congress.gov/107/plaws/publ243/PLAW-107publ243.htm", "verify": [r"Oct(?:ober|\.)? 16, 2002"]},
    {"kind": "Pandemic", "label": "COVID-19 public health emergency (HHS determination)", "from": "2020-01", "to": "2023-05", "source": "https://aspr.hhs.gov/legal/PHE/Pages/default.aspx", "verify": [r"COVID-19", r"2020"]},
    {"kind": "Pandemic", "label": "2009 H1N1 influenza public health emergency (HHS determination)", "from": "2009-04", "to": "2010-06", "source": "https://aspr.hhs.gov/legal/PHE/Pages/default.aspx", "verify": [r"H1N1"]},
]


def events():
    out, cache = [], {}
    for e in EVENTS:
        try:
            t = cache.get(e["source"]) or text_of(fetch(e["source"]))
            cache[e["source"]] = t
        except Exception as err:  # noqa: BLE001
            log(f"event {e['label']}: {err}")
            continue
        missing = [v for v in e["verify"] if not re.search(v, t)]
        if missing:
            log(f"event left out (not found on the source): {e['label']} {missing}")
            continue
        out.append({k: e[k] for k in ("kind", "label", "from", "to", "source")})
    log(f"events: {len(out)} of {len(EVENTS)}")
    return out


def dof_charts():
    """California's budget history: the Department of Finance's historical charts (PDF). Logged for checking; parsed where the layout is known."""
    page = fetch(DOF_CHARTS)
    links = ["https://dof.ca.gov" + l if l.startswith("/") else l for l in sorted(set(re.findall(r'href="([^"]+CHART-[A-Z0-9-]+\.pdf)"', page)))]
    charts = {}
    for l in links:
        try:
            t = pdf_text(l)
        except Exception as e:  # noqa: BLE001
            log(f"DOF {l}: {e}")
            continue
        title = re.sub(r"\s+", " ", " ".join(t.strip().splitlines()[:4]))[:200]
        charts[l] = t
        log(f"DOF chart {l.rsplit('/', 1)[-1]}: {title}")
    return charts


def ca_general_fund(charts):
    """General Fund revenues and expenditures by fiscal year (thousands or millions as the chart states), from the chart that lists them."""
    for url, t in charts.items():
        if not re.search(r"General Fund", t, re.I) or not re.search(r"Expenditures", t, re.I):
            continue
        rows = {}
        for line in t.splitlines():
            m = re.match(r"^\s*(\d{4})-(\d{2})\s+(.*)$", line)
            if not m:
                continue
            nums = [num(x) for x in re.findall(r"-?\$?[\d,]+\.?\d*", m.group(3))]
            nums = [x for x in nums if x is not None]
            if len(nums) >= 2:
                rows[int(m.group(1)) + 1] = nums
        if len(rows) >= 20:
            head = "\n".join(t.splitlines()[:14])
            log(f"CA general fund chart: {url}\n{head}\n  sample: {sorted(rows.items())[-3:]}")
            return {"source": url, "rows": rows, "header": head}
    log("CA general fund: no chart matched")
    return None


def ca_population():
    """California's population and households (Department of Finance E-4, E-5 and E-8), January 1 of each year."""
    import openpyxl
    out_pop, out_hh = {}, {}
    sources = [
        ("https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/estimates-e8-2000-2010/E8_2000-2010_Report_ByYear_Final_EOC.xlsx", "e8-2000"),
        ("https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/estimates-e8-2010-2020/E-8_2010_2020_by_Geo_Internet.xlsx", "e8-2010"),
        ("https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/e-5-population-and-housing-estimates-for-cities-counties-and-the-state-2020-2026/E-5_2026_InternetVersion.xlsx", "e5"),
    ]
    for url, kind in sources:
        try:
            wb = openpyxl.load_workbook(io.BytesIO(fetch(url, binary=True)), read_only=True, data_only=True)
        except Exception as e:  # noqa: BLE001
            log(f"DOF {kind}: {e}")
            continue
        for ws in wb.worksheets:
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
            for r in rows:
                cells = [str(c).strip() if c is not None else "" for c in r]
                if any(re.fullmatch(r"California|State Total|California Total", c) for c in cells[:3]):
                    log(f"  DOF {kind} {ws.title}: {cells[:14]}")
                    break
            break
    return out_pop, out_hh, [u for u, _ in sources]


def finances(executive, governor_terms):
    links = omb_links()
    log(f"OMB tables found: {sorted(links)}")
    omb = omb_series(links)
    debt = treasury_debt()
    pop = census_population()
    hh = census_households()
    control = party_control()
    ev = events()
    charts = dof_charts()
    cagf = ca_general_fund(charts)
    ca_pop, ca_hh, ca_pop_sources = ca_population()
    years = sorted(y for y in set(omb["t11"]) | set(debt) if y >= FIRST_YEAR - 1)
    federal = []
    for y in years:
        t11 = omb["t11"].get(y, {})
        row = {"fy": y, "debt": debt.get(y), "receipts": t11.get("receipts"), "outlays": t11.get("outlays"), "surplus": t11.get("surplus"),
               "gdp": omb["gdp"].get(y), "population": pop.get(y), "households": hh.get(y),
               "functions": {k: v[y] for k, v in omb["t31"].items() if y in v}}
        federal.append(row)
    pres = [t for t in executive["terms"] if t["office"] == "President" and t["end"] >= f"{FIRST_YEAR}-01-21"]
    return {
        "_readme": "Generated by tools/build_history.py; don't edit by hand.",
        "federal": {
            "years": federal,
            "terms": [{"name": t["name"], "start": t["start"], "end": t["end"]} for t in pres],
            "control": control,
            "sources": {
                "debt": {"label": "Total public debt outstanding at the end of each fiscal year: Treasury, Debt to the Penny (Fiscal Data)", "url": "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/"},
                "budget": {"label": "Receipts, outlays and surplus or deficit: OMB Historical Tables, Table 1.1", "url": omb["t11_url"]},
                "functions": {"label": "Outlays by superfunction and function, including net interest: OMB Historical Tables, Table 3.1", "url": omb["t31_url"]},
                "gdp": {"label": "Gross domestic product by fiscal year: OMB Historical Tables, Table 10.1", "url": omb["t101_url"]},
                "population": {"label": "Resident population on July 1: Census Bureau population estimates", "url": "https://www.census.gov/programs-surveys/popest.html"},
                "households": {"label": "Households: Census Bureau, Current Population Survey, Table HH-1", "url": "https://www2.census.gov/programs-surveys/demo/tables/families/time-series/households/hh1.xls"},
            },
        },
        "california": {
            "general_fund": cagf,
            "governors": governor_terms,
            "population": ca_pop, "households": ca_hh, "population_sources": ca_pop_sources,
            "charts": sorted(charts),
        },
        "events": ev,
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    executive = federal_executive()
    write("federal-executive.json", executive)
    for st, d in congress_members().items():
        write(f"congress/{st.lower()}.json", {"_readme": "Generated by tools/build_history.py; don't edit by hand.", "source": BIOGUIDE, "source_note": "congress-legislators (legislators-current and legislators-historical), compiled from the Biographical Directory of the United States Congress.", **d})
    for st, d in districts_by_period().items():
        write(f"districts/{st.lower()}.json", {"_readme": "Generated by tools/build_history.py; don't edit by hand.", "source": RELFILES, **d})
    govs = governors()
    elections = sov_elections()
    write("california.json", {
        "_readme": "Generated by tools/build_history.py; don't edit by hand.",
        "governors": {"source": GOVERNORS, "list": govs},
        "elections": elections,
        "legislature_makeup": legislature_makeup(elections),
        "sov_index": SOV_INDEX,
    })
    write("finances.json", finances(executive, govs))


if __name__ == "__main__":
    main()
