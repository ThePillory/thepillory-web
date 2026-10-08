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
import time
import urllib.error
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


NOTES = []  # checks printed again at the end of the run, where the job log keeps them


def note(*a):
    log(*a)
    NOTES.append(" ".join(str(x) for x in a))


def fetch(url, binary=False, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(urllib.parse.quote(url, safe=":/?=&%#~+[],"), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            return data if binary else data.decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code == 404 or i == tries - 1:
                raise
            # The Census Bureau's file server answers 429 when asked too quickly: wait and try again.
            time.sleep(20 * (i + 1) if e.code == 429 else 3)
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(3)


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
    time.sleep(1)  # one file a second keeps the Census file server from refusing
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
    time.sleep(1)
    try:
        t = fetch(url)
    except Exception as e:  # noqa: BLE001
        log(f"  {url}: {e}")
        return [], url
    # "County<spaces>Congressional District" with ranges like "9-11,13": names are matched to
    # FIPS codes through the county list in data/geo/places/<st>.json.
    names = {}
    try:
        for c in json.loads((ROOT / "data" / "geo" / "places" / f"{st.lower()}.json").read_text())["counties"]:
            names[county_key(c["name"])] = c["fips"]
    except Exception as e:  # noqa: BLE001
        note(f"cd108 {st}: county list: {e}")
    rows, unmatched = [], []
    for line in t.splitlines():
        m = re.match(r"^(\S.*?)\s{2,}((?:\d{1,2}(?:-\d{1,2})?)(?:\s*,\s*\d{1,2}(?:-\d{1,2})?)*|At Large|At-Large|AL)\s*$", line, re.I)
        if not m or m.group(1).strip().lower() in ("county", "parish"):
            continue
        fips = names.get(county_key(m.group(1)))
        if not fips:
            unmatched.append(m.group(1).strip())
            continue
        spec = m.group(2)
        if re.match(r"a", spec, re.I):
            rows.append((fips, "0"))
            continue
        for part in re.split(r"\s*,\s*", spec):
            lo, _, hi = part.partition("-")
            for d in range(int(lo), int(hi or lo) + 1):
                rows.append((fips, str(d)))
    if st == "CA" or unmatched or not rows:
        note(f"cd108 {st}: {len(set(r[0] for r in rows))} counties read; unmatched {unmatched[:8]}")
    return rows, url


def county_key(name):
    import unicodedata
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"[^a-z ]", "", n.replace("saint", "st").replace("st.", "st"))
    n = re.sub(r"\b(county|parish|borough|census area|city and borough|municipality)\b", "", n)
    return re.sub(r"\s+", "", n)


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
            periods.append({"from": 2003, "to": 2012, "cd": group(r108), "source": u108, "note": "Districts of the 108th Congress, drawn after the 2000 census. A state that redrew its lines later in the decade isn't reflected."})
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
            note(f"districts CA: {[(p['from'], p['to'], p['cd'].get('06009'), (p.get('sldu') or {}).get('06009'), (p.get('sldl') or {}).get('06009')) for p in periods]}")
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
# 2010's summary pages list candidates without a party: "Steve Pougnet    87,141   42.2%".
CAND_NO_PARTY = re.compile(r"([A-Z][A-Za-z.'\- ]{2,60}?)\*?\s{2,}([\d,]{2,})\s+([\d.]+)\s?%")
CAND = re.compile(r"([A-Z][^,\d]{1,60}?(?:, (?:Jr|Sr|II|III)\.?)?),\s+([A-Z]{2,4})\*?\s+([\d,]{2,})\s+([\d.]+)\s?%")
HEAD = re.compile(r"((?:Governor|Lieutenant Governor|Secretary of State|Controller|Treasurer|Attorney General|Insurance Commissioner|Superintendent of Public Instruction|Board of Equalization(?: Member)?(?: District \d+)?|State Senat(?:e|or) District \d+|(?:Member of (?:the )?)?(?:State )?Assembly(?: ?[Mm]ember)?,? District \d+|United States Representative District \d+|US Senate[^V]*?|United States Senator[^V]*?))\s{2,}Votes\s+Percent")


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


def sov_summary(text, no_party=False):
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
        found = [(m.start(), m.group(1), m.group(2), m.group(3)) for m in CAND.finditer(line)]
        if no_party:
            found = [(m.start(), m.group(1), None, m.group(2)) for m in CAND_NO_PARTY.finditer(line)]
        for start, raw, party, votes in found:
            col = 0 if start < 45 else 1
            key = current.get(col)
            if not key:
                continue
            name = re.sub(r"\s+", " ", raw).strip().rstrip("*")
            if re.search(r"Votes Not Cast|\(w/i\)|^Total|Percent", name):
                continue
            contests.setdefault(key, []).append({"name": name, "party": party, "votes": int(votes.replace(",", ""))})
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
        pdfs = [p if p.startswith("http") else "https://www.sos.ca.gov" + p for p in pdfs]
        summary = next((p for p in pdfs if re.search(r"/(\d+[-_])+(sov[-_])?(summary|sum)(-pages)?\.pdf$", p, re.I) and "/ssov/" not in p), None) \
            or next((p for p in pdfs if re.search(r"/(sov[-_])?(summary|sum)\.pdf$", p, re.I) and "/ssov/" not in p), None)
        files = [summary] if summary else [p for p in pdfs if re.search(r"complete_sov|_entire\.pdf$", p)]
        if not files:
            # Older years publish one PDF per office instead of a summary.
            files = [p for p in pdfs if re.search(r"(gov|ltgov|lt_gov|sos|sec|cont|treas|ag|ins|spi|supt|boe|congress|us_reps|assembly|senat)[^/]*\.pdf$", p, re.I)
                     and not re.search(r"about|contents|vot_sys|reg|cert|errata|ballot_measures|pref|particip", p, re.I)]
        if not files:
            note(f"SOV {year}: no summary PDF among {[p.rsplit('/', 1)[-1] for p in pdfs]}")
            continue
        contests = {}
        for f in files:
            try:
                text = pdf_text(f)
                # Candidates are listed with their party ("Name, DEM"), except in years whose
                # summary leaves it out (2010): read those without a party.
                parsed = sov_summary(text) or sov_summary(text, no_party=True)
                for k, v in parsed.items():
                    contests.setdefault(k, []).extend(v)
                if not any(k[0] == "sldl" for k in contests) or not contests:
                    heads = [l.strip()[:140] for l in text.splitlines() if re.search(r"(?i)assembly", l)][:6]
                    cands = [l.strip()[:140] for l in text.splitlines() if re.search(r"[A-Z][a-z]+.*\b(DEM|REP|LIB|GRN|PF|AI|NPP)\b", l)][:4]
                    note(f"SOV {year} {f.rsplit('/', 1)[-1]}: headers {heads}; candidate lines {cands}")
            except Exception as e:  # noqa: BLE001
                note(f"SOV {year} {f}: {e}")
        winners = []
        for (key, label, district), cands in contests.items():
            names = [c["name"] for c in cands]
            if len(names) != len(set(names)):
                # The same candidate listed more than once: county-by-county lines, not one statewide total. Not used.
                continue
            top = max(cands, key=lambda c: c["votes"])
            winners.append({"office": key, "label": label, "district": district, "name": top["name"], "party": top["party"], "votes": top["votes"]})
        counts = {}
        for w in winners:
            counts[w["office"]] = counts.get(w["office"], 0) + 1
        note(f"SOV {year}: {[f.rsplit('/', 1)[-1] for f in files]} -> {counts}")
        if winners:
            out.append({"year": year, "source": files[0], "page": link, "winners": winners})
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
                k = w["party"] or "Party not listed"
                t[k] = t.get(k, 0) + 1
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
    # Before Debt to the Penny (April 1993): Historical Debt Outstanding, the amount at the end of each fiscal year.
    try:
        for r in fiscal("v2/accounting/od/debt_outstanding", {"fields": "record_date,record_fiscal_year,debt_outstanding_amt", "sort": "record_date"}):
            y = int(r.get("record_fiscal_year") or r["record_date"][:4])
            if y >= FIRST_YEAR - 2 and y not in out and num(r.get("debt_outstanding_amt")) is not None:
                out[y] = num(r["debt_outstanding_amt"])
    except Exception as e:  # noqa: BLE001
        note(f"treasury debt outstanding: {e}")
    note(f"treasury debt: {min(out)}–{max(out)}, FY1992 {out.get(1992)}, FY2025 {out.get(2025)}")
    return out


def omb_links():
    page = fetch(OMB_PAGE)
    return {m.group(1): m.group(0) for m in re.finditer(r"https://www\.whitehouse\.gov/wp-content/uploads/[^\"']*?hist(\d\dz\d)_fy\d{4}\.xlsx", page)}


def xlsx_rows(url):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(fetch(url, binary=True)), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    ws.reset_dimensions()  # some sheets state a one-cell size; read every row there is
    return [list(r) for r in ws.iter_rows(values_only=True)]


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
    gdp = {}
    for r in t101:
        y = str(r[0] or "").strip().replace(".0", "") if r else ""
        if re.fullmatch(r"\d{4}", y) and int(y) >= FIRST_YEAR - 1:
            # The first number after the year is GDP in billions of current dollars.
            v = next((num(c) for c in r[1:] if num(c) is not None), None)
            if v is not None:
                gdp[int(y)] = v * 1e9
    if not gdp or 2024 not in gdp:
        note(f"OMB 10.1 rows: {[r[:5] for r in t101[:14]]}")
    out["gdp"] = gdp
    out["t101_url"] = links["10z1"]
    note(f"OMB GDP: {min(gdp) if gdp else None}–{max(gdp) if gdp else None}; 2024 {gdp.get(2024)}")
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
    t90 = ""
    try:
        t90 = fetch("https://www2.census.gov/programs-surveys/popest/tables/1990-2000/intercensal/national/us-est90int-07.csv")
        for line in t90.splitlines():
            line = line.replace('"', "")
            m = re.match(r"^\s*(?:7/1/(\d{4})|July 1,\s*(\d{4}))\s*,\s*([\d,]{9,})", line)
            if m:
                pop.setdefault(int(m.group(1) or m.group(2)), int(m.group(3).replace(",", "")))
    except Exception as e:  # noqa: BLE001
        note(f"population 1990s: {e}")
    if 1995 not in pop:
        note(f"population 1990s: not read; first lines {t90.splitlines()[:14]}")
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
    for m in re.finditer(r"(\d{3})(?:st|nd|rd|th) \((\d{4})[–-](\d{4})\) 435((?: \d+)+)", t):
        c = int(m.group(1))
        if c >= 102:
            ns = [int(x) for x in m.group(4).split()]
            # Democrats then Republicans, as the historian's table lists them: the first two
            # adjacent counts that together come close to the 435 seats.
            pair = next(((ns[i], ns[i + 1]) for i in range(len(ns) - 1) if 400 <= ns[i] + ns[i + 1] <= 435), None)
            if not pair:
                note(f"House {c}: counts not read from {m.group(0)}")
                continue
            d, r = pair
            house[c] = {"years": [int(m.group(2)), int(m.group(3))], "democrats": d, "republicans": r, "majority": "Democrats" if d > r else "Republicans"}
    senate = {}
    t = text_of(fetch(SENATE_PARTY))
    for m in re.finditer(r"(\d{3})(?:st|nd|rd|th) Congress \((\d{4})[–-](\d{4})\)(.{0,3000}?)(?=-{10,}|\d{3}(?:st|nd|rd|th) Congress \(|$)", t):
        c = int(m.group(1))
        if c >= 102:
            body = re.sub(r"\s+", " ", m.group(4)).strip()
            maj = re.findall(r"Majority Party(?: \([^)]*\))?: (Democrats|Republicans)", body)
            senate[c] = {"years": [int(m.group(2)), int(m.group(3))], "majority": maj[0] if len(set(maj)) == 1 else None, "majorities": maj, "text": body[:600]}
    note(f"party control: House {[(c, h['democrats'], h['republicans']) for c, h in sorted(house.items())]}")
    note(f"party control: Senate {[(c, v['majority'], v['majorities']) for c, v in sorted(senate.items())]}")
    for c in range(102, 120):
        if c not in senate:
            i = t.find(f"{c}th Congress") if c not in (101, 102, 103) else t.find(f"{c}{'st' if c == 101 else 'nd' if c == 102 else 'rd'} Congress")
            note(f"Senate {c} not read: {t[i:i + 500] if i >= 0 else 'not on the page'}")
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
        if not re.search(r"CHART A\b", t) or not re.search(r"GENERAL FUND BUDGET SUMMARY", t):
            continue
        rows = {}
        for line in t.splitlines():
            m = re.match(r"^\s*(\d{4})-(\d{2})([^\d\s-]*)\s+(.*)$", line)
            if not m:
                continue
            body = re.sub(r"(?<![\d.,])\d{1,2}/", " ", m.group(4))  # footnote markers like "3/"
            nums = [num(x) for x in re.findall(r"-?[\d,]+\.\d", body)]
            if len(nums) >= 7:
                # Chart A columns: prior-year balance, adjustment, adjusted balance, revenues and
                # transfers, resources available, expenditures, ending balance ($ millions).
                rows[int(m.group(1)) + 1] = {"revenues": nums[3] * 1e6, "expenditures": nums[5] * 1e6, "ending_balance": nums[6] * 1e6, "mark": m.group(3) or None}
        tail = [l.strip() for l in t.splitlines() if l.strip()][-25:]
        last_lines = [l for l in t.splitlines() if re.match(r'^\s*20[12]\d-\d\d', l)][-5:]
        est_lines = [l.strip()[:160] for l in t.splitlines() if re.search(r'(?i)estimat|budget act|proposed|enacted', l)][:8]
        note(f"CA Chart A last data lines: {last_lines}; estimate words: {est_lines}")
        note(f"CA Chart A: {len(rows)} years {min(rows) if rows else None}–{max(rows) if rows else None}; last rows {sorted(rows.items())[-4:]}; notes {tail}")
        if len(rows) >= 20:
            # The chart's date ("July 2026") is on its last page. The current fiscal year and the
            # budget year as of that date are the Department of Finance's estimates, not actuals.
            dm = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s*$", t.strip())
            as_of = f"{dm.group(1)} {dm.group(2)}" if dm else None
            # A chart dated in calendar year Y still estimates the fiscal year that ended in June of Y.
            estimates_from = int(dm.group(2)) if dm else max(rows) - 1
            note(f"CA Chart A as of {as_of}: estimates from fiscal year ending {estimates_from}")
            return {"source": url, "rows": rows, "notes": tail, "as_of": as_of, "estimates_from": estimates_from}
    note("CA general fund: Chart A not found")
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
            note(f"DOF {kind}: {e}")
            continue
        for ws in wb.worksheets:
            if "City" in ws.title:
                continue  # the same state total as the County/State sheet
            ws.reset_dimensions()
            ym = re.search(r"(20\d\d|19\d\d)", ws.title)
            for r in ws.iter_rows(values_only=True):
                cells = list(r)
                first = [str(c).strip() for c in cells[:3] if c not in (None, "")]
                if not first or not re.fullmatch(r"California|State Total|California Total|CALIFORNIA|STATE TOTAL", first[0]):
                    continue
                when = next((c for c in cells[:4] if hasattr(c, "year")), None)
                year = when.year if when is not None and (when.month, when.day) == (1, 1) else (int(ym.group(1)) if ym and when is None else None)
                if year is None:
                    continue  # census-day (April 1) rows: the January 1 estimates are used
                vals = [num(c) for c in cells if not hasattr(c, "year") and num(c) is not None]
                # Total population, household population, ..., occupied units (households), vacancy rate, persons per household.
                if len(vals) < 5 or not 25e6 < vals[0] < 50e6:
                    continue
                pph = vals[-1]
                occupied = next((v for v in vals[3:-1] if v > 1e6 and abs(vals[1] / v - pph) < 0.01), None)
                if occupied is None:
                    note(f"DOF {kind} {ws.title}: households not found in {vals}")
                    continue
                out_pop.setdefault(year, int(vals[0]))
                out_hh.setdefault(year, int(occupied))
                if ym:
                    break  # one state row per yearly sheet
    note(f"CA population: {sorted(out_pop.items())}; households: {sorted(out_hh.items())}")
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
        old = OUT / f"districts/{st.lower()}.json"
        if old.exists() and len(json.loads(old.read_text())["periods"]) > len(d["periods"]):
            note(f"districts {st}: kept the earlier file ({len(d['periods'])} periods read this time)")
            continue
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
    log("\n==== Checks ====")
    for n in NOTES:
        log(n[:3000])


if __name__ == "__main__":
    main()
