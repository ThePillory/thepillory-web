#!/usr/bin/env python3
"""
Money from government to organizations, privately paid travel and foreign
agents' contacts, into D1 (migration 0031). Run weekly by the "Refresh
government money" workflow. See docs/funding.md.

    python3 tools/load_gov_money.py earmarks --mode measure   # read, write nothing
    python3 tools/load_gov_money.py travel --mode load
    python3 tools/load_gov_money.py fara --mode load --max-docs 150

  earmarks  The Senate Appropriations Committee's tables of Congressionally
            Directed Spending and Community Project Funding in each enacted
            law (both chambers' projects; a table that doesn't read cleanly
            stays a link), the House committee's table of projects in its own
            bills, and the House's consolidated tables of members' requests.
            A request is tied to a table row only when the same member is
            among its requesters and the recipient is the same: one match only.
  travel    The House Clerk's gift travel filings (searched by quarter) and
            the Senate's Gift Rule database (reimbursed travel reports).
  fara      The Justice Department's FARA bulk files (registrants, foreign
            principals, documents), and each supplemental statement filed
            since 2025 with a text layer: its Item 12 contacts with members of
            Congress or their offices. Statements without one stay links.

Names are matched to officials only on exactly one match; staff aren't named.
Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (wrangler) to load, and
pdftotext and openpyxl.
"""
import argparse
import datetime
import http.cookiejar
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import govmoney as G  # noqa: E402
import usaspending as U  # noqa: E402
from load_trades import d1, lit, run_sql, MIGRATIONS  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
SINCE = datetime.date(2023, 1, 1)

SENATE_NAMES = {"ag": "agriculture", "cjs": "cjs", "ewd": "energy-water", "fsgg": "fsgg", "interior": "interior", "lhhs": "lhhs", "mcva": "milcon-va", "thud": "thud"}
HOUSE_FILES = "https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/"
HOUSE_REQUESTS = {
    2024: "https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/FY%202024%20House%20CPF%20Requests%202023-04-27%20%28430pm%29.xlsx",
    2025: HOUSE_FILES + "fy25-house-cpfs-as-requested-06.28.2024.xlsx",
    2026: HOUSE_FILES + "fy26-house-cpf-consolidated.xlsx",
    2027: HOUSE_FILES + "consolidated-table-of-fy27-cpf-requests.xlsx",
}
HOUSE_AWARDS = {2027: HOUSE_FILES + "consolidated-table-of-fy27-cpf-awards.xlsx"}

HOUSE_TRAVEL = "https://disclosures-clerk.house.gov/GiftTravelFilings/"
SENATE_TRAVEL = "https://giftrule-disclosure.senate.gov/media/giftruledownloads/giftruledata.zip"
FARA_BULK = "https://efile.fara.gov/bulk/zip/"


def say(*a):
    print(*a, flush=True)


_jar = http.cookiejar.CookieJar()
_open = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar)).open


def get(url, data=None, headers=None, timeout=300, waits=(5, 20)):
    """GET (or POST) with retries on server errors, 429 and 403 (some sites refuse a burst for a while)."""
    h = {"User-Agent": UA, **(headers or {})}
    for wait in (*waits, None):
        try:
            with _open(urllib.request.Request(url, data=data, headers=h), timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            if wait is None or (isinstance(e, urllib.error.HTTPError) and e.code < 500 and e.code not in (403, 429)):
                raise
            time.sleep(wait)


SENATE_FY_PAGE = "https://www.appropriations.senate.gov/fy-{fy}-congressionally-directed-spending"


def senate_tables(fy):
    """{subcommittee: table URL} from the committee's page for this fiscal year; {} when there's no page."""
    try:
        page = get(SENATE_FY_PAGE.format(fy=fy), waits=(30, 90)).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            return {}
        raise
    out = {}
    for href in set(re.findall(r'href="([^"]*/download/fy\d{2}-([a-z]+)-cds-public-law)[^"]*"', page)):
        url, short = href
        if short in SENATE_NAMES:
            out[SENATE_NAMES[short]] = urllib.parse.urljoin("https://www.appropriations.senate.gov/", url)
    return out


def pdf_text(data):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        r = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, timeout=300)
        return r.stdout if r.returncode == 0 else ""


def xlsx_rows(data, must):
    """A spreadsheet's first sheet from its header row (the first row with a cell containing `must`)."""
    import openpyxl

    ws = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    start = next((i for i, r in enumerate(rows[:15]) if any(must in str(c or "").lower() for c in r)), 0)
    return rows[start:]


def ensure_tables(args):
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    for name in ("0031_gov_money.sql", "0033_awards_queue.sql"):  # CREATE … IF NOT EXISTS only
        if not d1(args, command=f"SELECT 1 AS x FROM d1_migrations WHERE name = '{name}'"):
            d1(args, file=MIGRATIONS / name)
            d1(args, command=f"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('{name}')")
            say(f"Applied migration {name}")


def members(args):
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        say("No Cloudflare access: names aren't matched to officials")
        return G.Members([])
    return G.Members(d1(args, command="SELECT id, name, last_name, state, district_code, chamber, active FROM officials WHERE chamber IN ('us-house', 'us-senate')"))


def inserts(table, cols, rows, per=40):
    """Multi-row INSERT OR REPLACE statements."""
    out = []
    for i in range(0, len(rows), per):
        vals = ",\n".join("(" + ", ".join(lit(r.get(c)) for c in cols) + ")" for r in rows[i:i + per])
        out.append(f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES\n{vals};")
    return out


# ---------------------------------------------------------------------------
# Earmarks


EARMARK_COLS = ["id", "fy", "stage", "subcommittee", "agency", "account", "state", "location", "recipient", "project", "amount", "origination", "page", "source_url"]
REQUEST_COLS = ["id", "fy", "official_id", "member_name", "district", "subcommittee", "recipient", "project", "address", "amount_requested", "member_url", "enacted_id", "source_url"]


def table_sql(url, fy, stage, sub, status, rows, note=None):
    out = [f"DELETE FROM earmark_requesters WHERE earmark_id IN (SELECT id FROM earmarks WHERE source_url = {lit(url)});",
           f"DELETE FROM earmarks WHERE source_url = {lit(url)};"]
    out += inserts("earmarks", EARMARK_COLS, rows)
    reqs = [{"earmark_id": r["id"], "name": n, "chamber": ch, "official_id": oid} for r in rows for ch, n, oid in r["_who"]]
    out += inserts("earmark_requesters", ["earmark_id", "name", "chamber", "official_id"], reqs, per=80)
    out.append(f"INSERT OR REPLACE INTO earmark_tables (source_url, fy, stage, subcommittee, status, rows, note, read_at) VALUES "
               f"({lit(url)}, {fy}, {lit(stage)}, {lit(sub)}, {lit(status)}, {len(rows)}, {lit(note)}, datetime('now'));")
    return out


def who(rows, m):
    """Each row's requesters with their official on one match: [(chamber, name, official_id)]."""
    unmatched = set()
    for r in rows:
        r["_who"], seen = [], set()
        for ch in ("house", "senate"):
            names = list(r[ch])
            # "Scott, Austin (GA)": a table can write a first name after the last, split at the comma.
            for i in range(len(names) - 1, 0, -1):
                f = re.match(r"^([A-Z]\.?|[A-Z][a-z]+)\s*\(([A-Z]{2})\)$", names[i])
                if f and "(" not in names[i - 1] and " " not in names[i - 1] and not m.match_requester(names[i], ch, r.get("state")):
                    if m.match_full(f.group(1), names[i - 1], "us-" + ch, f.group(2)):
                        names[i - 1:i + 1] = [f"{names[i - 1]}, {names[i]}"]
            for n in names:
                if (n, ch) in seen:
                    continue
                seen.add((n, ch))
                full = re.match(r"^([^,(]+),\s*([^,(]+?)\s*\(([A-Z]{2})\)$", n)
                oid = m.match_full(full.group(2), full.group(1), "us-" + ch, full.group(3)) if full else m.match_requester(n, ch, r.get("state"))
                if not oid:
                    unmatched.add(f"{n} ({ch})")
                r["_who"].append((ch, n, oid))
    return unmatched


def tie_requests(requests, tables):
    """A request's table row: the same official among its House requesters, the same recipient; one match only."""
    by = {}
    for r in tables:
        for ch, _, oid in r["_who"]:
            if ch == "house" and oid:
                by.setdefault((r["fy"], oid), []).append(r)
    tied = 0
    for q in requests:
        q["enacted_id"] = None
        if not q.get("official_id") or not q.get("recipient"):
            continue
        key = G.org_key(q["recipient"])
        if not key:
            continue
        hits = [r for r in by.get((q["fy"], q["official_id"]), [])
                if G.org_key(r.get("recipient")) == key or (not r.get("recipient") and G.org_key(r["project"]).startswith(key + " "))]
        if len(hits) == 1:
            q["enacted_id"] = hits[0]["id"]
            tied += 1
    return tied


def earmarks(args):
    m = members(args)
    sql, tables = [], []
    this_fy = datetime.date.today().year + (1 if datetime.date.today().month >= 10 else 0)
    for fy in range(2024, this_fy + 2):
        try:
            found = senate_tables(fy)
        except urllib.error.URLError as e:
            say(f"  FY{fy}: the Senate committee's page wasn't fetched ({getattr(e, 'code', e)})")
            args.failed.append(f"Senate FY{fy} page")
            continue
        for sub, url in sorted(found.items()):
            time.sleep(3)
            try:
                data = get(url + "&download=1", waits=(30, 90))
            except urllib.error.URLError as e:
                say(f"  FY{fy} {sub}: not fetched ({getattr(e, 'code', e)})")
                args.failed.append(f"Senate FY{fy} {sub}")
                continue
            if data[:4] != b"%PDF":
                continue
            try:
                rows = G.parse_table(pdf_text(data), fy, sub, url)
            except G.Unreadable as e:
                say(f"  FY{fy} {sub} (enacted): left as a link: {e}")
                sql += table_sql(url, fy, "enacted", sub, "link", [], str(e))
                continue
            unmatched = who(rows, m)
            tables += rows
            say(f"  FY{fy} {sub} (enacted): {len(rows)} projects, ${sum(r['amount'] for r in rows):,.0f}; requesters not matched: {len(unmatched)} {sorted(unmatched)[:8]}")
            sql += table_sql(url, fy, "enacted", sub, "read", rows)
    for fy, url in HOUSE_AWARDS.items():
        rows = G.house_awards(xlsx_rows(get(url), "requestor"), fy, url)
        unmatched = who(rows, m)
        tables += rows
        say(f"  FY{fy} House committee bills: {len(rows)} projects, ${sum(r['amount'] for r in rows):,.0f}; requesters not matched: {len(unmatched)} {sorted(unmatched)[:8]}")
        sql += table_sql(url, fy, "house_committee", None, "read", rows)
    requests = []
    for fy, url in HOUSE_REQUESTS.items():
        try:
            rows = G.house_requests(xlsx_rows(get(url), "last"), fy, url)
        except urllib.error.HTTPError as e:
            say(f"  FY{fy} House requests: not fetched ({e.code})")
            continue
        miss = set()
        for q in rows:
            q["official_id"] = m.match_full(q["first"], q["last"], "us-house", q["district"])
            q["member_name"] = f"{q['first']} {q['last']}".strip()
            if not q["official_id"]:
                miss.add(q["member_name"])
        requests += rows
        say(f"  FY{fy} House requests: {len(rows)} requests, ${sum(q['amount_requested'] for q in rows):,.0f}; members not matched: {len(miss)} {sorted(miss)[:8]}")
        sql.append(f"DELETE FROM earmark_requests WHERE source_url = {lit(url)};")
    tied = tie_requests(requests, tables)
    say(f"Requests tied to one table row: {tied} of {len(requests)}")
    sql += inserts("earmark_requests", REQUEST_COLS, requests)
    return sql


# ---------------------------------------------------------------------------
# Travel


def quarters(since, today):
    d = since
    while d <= today:
        end = (datetime.date(d.year + (d.month + 2) // 12, (d.month + 2) % 12 + 1, 1) - datetime.timedelta(days=1))
        yield d, min(end, today)
        d = end + datetime.timedelta(days=1)


def house_trips():
    out = []
    for a, b in quarters(SINCE, datetime.date.today()):
        page = get(HOUSE_TRAVEL + "ViewSearch").decode("utf-8", "replace")
        tok = (re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', page) or [None, ""])[1]
        form = {"MemberLastName": "", "StaffLastName": "", "TravelDateFrom": a.strftime("%m/%d/%Y"), "TravelDateTo": b.strftime("%m/%d/%Y"),
                "Sponsor": "", "Destination": "", "__RequestVerificationToken": tok}
        html = get(HOUSE_TRAVEL + "ViewSearchResult", data=urllib.parse.urlencode(form).encode(),
                   headers={"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": HOUSE_TRAVEL}).decode("utf-8", "replace")
        rows = G.house_travel(html)
        say(f"  House {a}–{b}: {len(rows)} filings")
        out += rows
        time.sleep(1)
    return out


def senate_trips():
    z = zipfile.ZipFile(io.BytesIO(get(SENATE_TRAVEL)))
    name = next(n for n in z.namelist() if n.lower().endswith(".xml"))
    rows = [r for r in G.senate_travel(z.read(name).decode("utf-8-sig", "replace")) if r["start"] and r["start"] >= SINCE.isoformat()]
    say(f"  Senate: {len(rows)} reimbursed travel reports since {SINCE}")
    return rows


SENATOR_OFFICE = re.compile(r"^(?:Office of\s+)?(?:Senator|Sen\.)\s+(.+)$", re.I)


def travel(args):
    m = members(args)
    out, miss = [], {}
    for r in house_trips():
        last, _, first = (r["member"] or "").partition(",")
        oid = m.match_full(first.strip(), last.strip(), "us-house")
        if not oid or not r["url"]:
            miss[r["member"]] = miss.get(r["member"], 0) + 1
            continue
        # The member traveled when the filer is the member; otherwise a staff member (not named).
        f, l = G.fold(first).split(" ")[0] if first.strip() else "", G.fold(last)
        filer = G.fold(r["filer"])
        mine = bool(l) and filer.endswith(l) and (not f or filer.startswith(f[:3]))
        out.append({"id": G.digest(r["url"], r["start"]), "official_id": oid, "chamber": "house", "traveler": "member" if mine else "staff",
                    "sponsor": r["sponsor"], "destination": r["destination"], "start_date": r["start"], "end_date": r["end"], "source_url": r["url"]})
    try:
        senate = senate_trips()
    except Exception as e:  # the House's filings are still loaded
        say(f"  Senate: not read ({type(e).__name__}: {e})")
        senate = []
    for r in senate:
        if r["member_trip"]:
            oid = m.match_full(r["filer_first"], r["filer_last"], "us-senate")
        else:
            o = SENATOR_OFFICE.match((r["office"] or "").strip())
            # The office is "Senator Name" or the senator's own "LAST, FIRST"; committee offices aren't matched.
            name = o.group(1) if o else ((r["office"] or "").strip() if re.fullmatch(r"[A-Za-z.'\- ]+,\s*[A-Za-z.'\- ]+", (r["office"] or "").strip()) else "")
            if "," in name:
                last, _, first = name.partition(",")
            else:
                parts = name.split()
                first, last = (parts[0] if len(parts) > 1 else ""), (parts[-1] if parts else "")
            oid = m.match_full(first.strip(), last.strip(), "us-senate") if last else None
        if not oid or not (r["url"] or "").startswith("http"):
            key = f"{r['filer_first']} {r['filer_last']} / {r['office']}" if r["member_trip"] else (r["office"] or "?")
            miss[key] = miss.get(key, 0) + 1
            continue
        out.append({"id": G.digest(r["url"], r["start"]), "official_id": oid, "chamber": "senate", "traveler": "member" if r["member_trip"] else "staff",
                    "sponsor": None, "destination": None, "start_date": r["start"], "end_date": r["end"], "source_url": r["url"]})
    out = list({r["id"]: r for r in out}.values())
    say(f"Trips matched to one member: {len(out)} (members {sum(r['traveler'] == 'member' for r in out)}, staff {sum(r['traveler'] == 'staff' for r in out)}); "
        f"not matched: {sum(miss.values())}, most common: {sorted(miss.items(), key=lambda x: -x[1])[:12]}")
    sql = ["DELETE FROM gift_travel;"] if out else []
    return sql + inserts("gift_travel", ["id", "official_id", "chamber", "traveler", "sponsor", "destination", "start_date", "end_date", "source_url"], out)


# ---------------------------------------------------------------------------
# FARA


def bulk_csv(name):
    z = zipfile.ZipFile(io.BytesIO(get(FARA_BULK + name)))
    return G.csv_rows(z.read(z.namelist()[0]).decode("latin-1"))


def pick(row, *names):
    for k, v in row.items():
        if k and any(n in k.lower() for n in names):
            return (v or "").strip()
    return ""


def registrant_url(n):
    return f"https://efile.fara.gov/ords/fara/f?p=1381:200:::NO:RP,200:P200_REG_NUMBER:{n}"


def fara(args):
    m = members(args)
    regs = bulk_csv("FARA_All_Registrants.csv.zip")
    keep = lambda term: not term or (G._iso(term) or "") >= SINCE.isoformat()
    reg_rows = [{"registration_number": int(r["Registration Number"]), "name": r["Name"].strip(), "registration_date": G._iso(r["Registration Date"]),
                 "termination_date": G._iso(r["Termination Date"]), "city": r.get("City", "").strip() or None, "state": r.get("State", "").strip() or None,
                 "source_url": registrant_url(r["Registration Number"].strip())}
                for r in regs if (r.get("Registration Number") or "").strip().isdigit() and keep(r.get("Termination Date"))]
    principals = bulk_csv("FARA_All_ForeignPrincipals.csv.zip")
    prin_rows = list({(int(p["Registration Number"]), p["Foreign Principal"].strip()): {
        "registration_number": int(p["Registration Number"]), "principal": p["Foreign Principal"].strip(), "country": p.get("Country/Location Represented", "").strip() or None,
        "registration_date": G._iso(p.get("Foreign Principal Registration Date")), "termination_date": G._iso(p.get("Foreign Principal Termination Date"))}
        for p in principals if (p.get("Registration Number") or "").strip().isdigit() and p.get("Foreign Principal", "").strip() and keep(p.get("Foreign Principal Termination Date"))}.values())
    if args.mode == "measure" and reg_rows:
        try:
            page = get(reg_rows[0]["source_url"], timeout=60).decode("utf-8", "replace")
            say(f"Registrant page {reg_rows[0]['source_url']}: {len(page)} bytes, names the registrant: {reg_rows[0]['name'][:20].lower() in page.lower()}")
        except Exception as e:
            say(f"Registrant page not reachable ({type(e).__name__}: {e})")
    say(f"FARA: {len(reg_rows)} registrants active since {SINCE} (of {len(regs)}), {len(prin_rows)} foreign principals")
    sql = inserts("fara_registrants", list(reg_rows[0].keys()), reg_rows) if reg_rows else []
    sql += inserts("fara_principals", list(prin_rows[0].keys()), prin_rows) if prin_rows else []

    docs = bulk_csv("FARA_All_RegistrantDocs.csv.zip")
    say(f"Documents file columns: {list(docs[0].keys()) if docs else []}")
    statements = []
    for d in docs:
        kind, url, stamped = pick(d, "document type"), pick(d, "url"), G._iso(pick(d, "date stamped", "date"))
        if "supplemental statement" not in kind.lower() or not url.startswith("http") or not stamped or stamped < "2025-01-01":
            continue
        statements.append({"url": url, "reg": int(pick(d, "registration number") or 0), "filed": stamped})
    statements.sort(key=lambda d: d["filed"], reverse=True)
    done = set()
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        try:
            done = {r["doc_url"] for r in d1(args, command="SELECT doc_url FROM fara_docs")}
        except SystemExit:
            done = set()
    todo = [d for d in statements if d["url"] not in done][: args.max_docs]
    say(f"Supplemental statements since 2025: {len(statements)}; new this run: {len(todo)}")
    read = linked = found = matched = 0
    for d in todo:
        try:
            text = pdf_text(get(d["url"], timeout=120))
        except Exception as e:
            say(f"  {d['url']}: not fetched ({type(e).__name__})")
            continue
        time.sleep(1)
        if len(text.strip()) < 200:
            linked += 1
            sql.append(f"INSERT OR REPLACE INTO fara_docs (doc_url, registration_number, filed_on, status, contacts) VALUES ({lit(d['url'])}, {d['reg']}, {lit(d['filed'])}, 'link', 0);")
            continue
        read += 1
        rows = G.item12_contacts(text)
        found += len(rows)
        keep_rows = []
        for i, c in enumerate(rows):
            hit = G.contact_member(c["contact"], m)
            if hit:
                if args.mode == "measure":
                    say(f"    {c['contact'][:70]!r} -> {hit[0]} ({hit[1]})")
                keep_rows.append({"doc_url": d["url"], "n": i, "registration_number": d["reg"], "official_id": hit[0], "contact_kind": hit[1],
                                  "principal": c["principal"] or None, "contact_date": c["date"], "method": c["method"], "filed_on": d["filed"]})
        matched += len(keep_rows)
        sql.append(f"DELETE FROM fara_contacts WHERE doc_url = {lit(d['url'])};")
        sql += inserts("fara_contacts", ["doc_url", "n", "registration_number", "official_id", "contact_kind", "principal", "contact_date", "method", "filed_on"], keep_rows)
        sql.append(f"INSERT OR REPLACE INTO fara_docs (doc_url, registration_number, filed_on, status, contacts) VALUES ({lit(d['url'])}, {d['reg']}, {lit(d['filed'])}, 'read', {len(keep_rows)});")
        if keep_rows:
            say(f"  {d['url']}: {len(rows)} contacts listed, {len(keep_rows)} with a member or member's office")
    say(f"Statements read: {read}; scanned (links): {linked}; contacts listed: {found}; with one member or office: {matched}")
    return sql


# ---------------------------------------------------------------------------
# Federal awards (USAspending.gov), for every organization the site names with a "Federal awards" link


# Each source of organization names shown with a "Federal awards" link (functions/_lib/*.js awardsLink()).
AWARD_NAMES = [
    # The Funding tab shows each member's top 10 per period with MIN_EMPLOYER_DONORS (functions/_lib/funding.js) or more donors.
    ("donors' employers", """SELECT DISTINCT employer AS name FROM (
        SELECT employer, ROW_NUMBER() OVER (PARTITION BY official_id, cycle ORDER BY total DESC) AS n
        FROM funding_employers WHERE count >= 3) WHERE n <= 10"""),
    ("bill lobbying clients", "SELECT DISTINCT f.client_name AS name FROM lobbying_filings f JOIN bill_lobbying b ON b.filing_uuid = f.filing_uuid"),
    ("lobbying organizations' contributions", "SELECT DISTINCT registrant_name AS name FROM lobby_contrib_filings WHERE filer_type = 'organization'"),
    ("outside spenders' organization donors", "SELECT DISTINCT name FROM outside_donors WHERE kind != 'committee'"),
    ("California lobbying organizations", "SELECT DISTINCT filer_name AS name FROM ca_lobby_contributions WHERE filer_kind != 'lobbyist' AND filer_name IS NOT NULL"),
    ("California lobbying employers", "SELECT DISTINCT employer_name AS name FROM ca_lobby_reports"),
    ("earmark recipients", "SELECT DISTINCT recipient AS name FROM earmarks WHERE recipient IS NOT NULL"),
    ("earmark request recipients", "SELECT DISTINCT recipient AS name FROM earmark_requests WHERE recipient IS NOT NULL"),
]
AWARDS_REFRESH_DAYS = 30
# Employer entries that aren't organizations: nothing to look up.
NOT_AN_ORG = re.compile(r"^(retired|self[ -]?employed|not employed|unemployed|none|n/?a|homemaker|student|information requested.*|requested|self|disabled)$", re.I)


def award_names(args):
    """{name_key: name} for every organization shown with a "Federal awards" link."""
    names = {}
    for label, sql in AWARD_NAMES:
        try:
            rows = d1(args, command=sql)
        except SystemExit as e:  # a table not created yet
            say(f"  {label}: not read ({str(e).splitlines()[-1][:120]})")
            continue
        n = 0
        for r in rows:
            k = U.name_key(r.get("name"))
            if len(k) >= 3 and k not in names and not NOT_AN_ORG.match(r["name"].strip()):
                names[k] = " ".join(r["name"].split())
                n += 1
        say(f"  {label}: {len(rows)} names, {n} new")
    return names


def awards(args):
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise SystemExit("awards needs Cloudflare access (the names come from D1)")
    from concurrent.futures import ThreadPoolExecutor

    names = award_names(args)
    try:
        wanted = {r["name_key"]: r["name"] for r in d1(args, command="SELECT name_key, name FROM federal_awards_wanted ORDER BY asked_at")}
    except SystemExit:  # migration 0033 not applied yet (a measure run before the first load)
        wanted = {}
    fetched = {r["name_key"]: r["fetched_at"] for r in d1(args, command="SELECT name_key, fetched_at FROM federal_awards_cache")}
    stale = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=AWARDS_REFRESH_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    # Asked for on the site first, then never looked up, then the oldest past the refresh age.
    queue = list(wanted.items())
    queue += [(k, n) for k, n in names.items() if k not in fetched and k not in wanted]
    queue += sorted(((k, n) for k, n in names.items() if k in fetched and k not in wanted and fetched[k] < stale), key=lambda x: fetched[x[0]])
    say(f"Organizations: {len(names)} named on the site; {len(wanted)} asked for; {sum(1 for k in names if k not in fetched)} never looked up; "
        f"looking up {min(len(queue), args.max_names)} this run")
    queue = queue[: args.max_names]

    def one(item):
        k, n = item
        for wait in (5, 20, None):
            try:
                return k, U.lookup(n), None
            except Exception as e:  # noqa: BLE001 - kept for the summary; the name is tried again next run
                if wait is None:
                    return k, None, f"{type(e).__name__}: {e}"
                time.sleep(wait)

    sql, done, failed, with_awards = [], 0, [], 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for k, got, err in pool.map(one, queue):
            if err:
                failed.append((k, err))
                continue
            done += 1
            with_awards += any(y["total"] for r in got["recipients"] for y in r["years"])
            sql.append(f"INSERT OR REPLACE INTO federal_awards_cache (name_key, result, fetched_at) VALUES ({lit(k)}, {lit(json.dumps(got, separators=(',', ':')))}, datetime('now'));")
            sql.append(f"DELETE FROM federal_awards_wanted WHERE name_key = {lit(k)};")
            if args.mode == "measure" and done <= 8:
                say(f"    {got['name']}: {len(got['recipients'])} recipient(s) of {got['total_found']}; "
                    + "; ".join(f"{r['name']} ({r['location']}) " + ", ".join(f"FY{y['fy']} ${y['total']:,.0f}" for y in r["years"]) for r in got["recipients"]))
    say(f"Looked up {done}; with awards in the last {U.YEARS} fiscal years: {with_awards}; failed: {len(failed)} {failed[:5]}")
    if failed and not done:
        args.failed.append("USAspending")
    return sql


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=("earmarks", "travel", "fara", "awards"))
    ap.add_argument("--max-names", type=int, default=3500, help="organizations looked up on USAspending this run")
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--max-docs", type=int, default=150, help="FARA statements read this run, newest first")
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()
    args.failed = []
    if args.mode == "load":
        ensure_tables(args)
    sql = {"earmarks": earmarks, "travel": travel, "fara": fara, "awards": awards}[args.what](args)
    say(f"{len(sql)} SQL statements")
    if args.mode == "load" and sql:
        run_sql(args, sql)
        say("Written to D1")
    if args.failed:
        # Everything else is written; the run shows red so a source that refused us isn't missed.
        raise SystemExit(f"Not fetched: {', '.join(args.failed)}")


if __name__ == "__main__":
    main()
