"""
"Net worth, as reported": loads each member of Congress's, the President's,
Vice President's, Cabinet's and the justices' annual (and candidate, nominee,
new member) financial disclosure reports into D1's networth_reports, read by
tools/networth.py, with the range their assets and liabilities add up to
(docs/funding.md, "Net worth"; migration 0036).

  House Clerk   every year's index (<year>FD.zip, since --since-year): annual
                (O), amended (A), candidate (C) and new member (H) reports,
                attached to a member only on one match (load_trades.match_house)
  Senate eFD    annual reports of senators and former senators, and candidate
                reports, since 2012; paper filings are links
  OGE           the 278e reports the sync's executive-funding step listed
                (disclosures): annual, nominee and candidate reports
  Judiciary     the justices' reports in data/scotus/trades.json (JEFS copies)

A report read in full is 'read'; a scan is 'scan' (or 'paper' on the Senate
site) and waits for the AI reading; one released only on request is 'request';
one whose lines couldn't all be accounted for is 'unreadable'. Reports are read
newest first, up to --max-reports a run; a report already read with the same
parser version isn't read again.

  python3 tools/load_networth.py --mode measure --names "Aderholt,Fong"
  python3 tools/load_networth.py --mode load --max-reports 400

These records may not be used for commercial purposes (Ethics in Government
Act): never sell, export or put them behind a paid plan.
"""
import argparse
import datetime
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_trades as T  # noqa: E402  (fetching, D1, matching)
import networth as N  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HOUSE_KINDS = {"O": ("annual", 0), "A": ("annual", 1), "C": ("candidate", 0), "H": ("new", 0)}
OGE_KIND = [(re.compile(r"^Annual \((\d{4})\)"), "annual"), (re.compile(r"^Nominee 278"), "nominee"),
            (re.compile(r"^(?:Vice )?Presidential Candidate"), "candidate"), (re.compile(r"^New Entrant"), "new")]


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(int(v))
    return "'" + str(v).replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# Finding the reports


def house_index(years):
    """Annual, amended, candidate and new member reports in each year's index."""
    out = []
    for y in years:
        try:
            z = zipfile.ZipFile(io.BytesIO(T.get(f"{T.HOUSE}/public_disc/financial-pdfs/{y}FD.zip")))
        except Exception as e:  # a year not published yet
            print(f"House {y}: index not read ({type(e).__name__})", file=sys.stderr)
            continue
        name = next((n for n in z.namelist() if n.lower().endswith(".xml")), None)
        for m in ET.fromstring(z.read(name)).iter("Member") if name else []:
            g = lambda tag: (m.findtext(tag) or "").strip()
            ft = g("FilingType")
            if ft not in HOUSE_KINDS or not g("DocID") or not T.iso(g("FilingDate")):
                continue
            kind, amended = HOUSE_KINDS[ft]
            out.append({"id": f"house:{g('DocID')}", "doc_id": g("DocID"), "source": "house", "kind": kind, "amended": amended,
                        "year": int(g("Year") or y), "filed_on": T.iso(g("FilingDate")), "first": g("First"), "last": g("Last"),
                        "state_dst": g("StateDst"), "url": f"{T.HOUSE}/public_disc/financial-pdfs/{g('Year') or y}/{g('DocID')}.pdf"})
    return out


def senate_reports(s, since="01/01/2012", page_size=100, max_pages=80):
    """Annual reports of senators and former senators, and candidate reports."""
    out = []
    for filer_types in ("[1, 5]", "[4]"):
        for i in range(max_pages):
            data = {"start": str(i * page_size), "length": str(page_size), "report_types": "[7]", "filer_types": filer_types,
                    "submitted_start_date": f"{since} 00:00:00", "submitted_end_date": "", "candidate_state": "", "senator_state": "",
                    "office_id": "", "first_name": "", "last_name": "", "order[0][column]": "4", "order[0][dir]": "desc",
                    "csrfmiddlewaretoken": s.csrf}
            res = json.loads(s._req(f"{T.SENATE}/search/report/data/", data, {"X-CSRFToken": s.csrf, "Referer": f"{T.SENATE}/search/"}))
            for first, last, office, link, received in res.get("data", []):
                m = re.search(r'href="(/search/view/(annual|paper)/([^"/]+)/?)"', link or "")
                title = html.unescape(re.sub(r"<[^>]+>", "", link or "")).strip()
                if not m or T.iso(received) is None:
                    continue
                cy = re.search(r"\bCY (\d{4})", title)
                candidate = "Candidate" in title or "Candidate" in (office or "")
                if not cy and not candidate:
                    continue  # another kind of report (a due date extension, a blind trust)
                out.append({"id": f"senate:{m.group(3).lower()}", "source": "senate", "kind": "candidate" if candidate else "annual",
                            "amended": 1 if "Amendment" in title else 0, "year": int(cy.group(1)) if cy else int(T.iso(received)[:4]),
                            "filed_on": T.iso(received), "first": html.unescape(re.sub(r"<[^>]+>", "", first)).strip(),
                            "last": html.unescape(re.sub(r"<[^>]+>", "", last)).strip(), "office": office,
                            "paper": m.group(2) == "paper", "url": T.SENATE + m.group(1), "title": title})
            if (i + 1) * page_size >= int(res.get("recordsFiltered") or res.get("recordsTotal") or 0):
                break
            time.sleep(1)
    return out


def oge_reports(args):
    rows = T.d1(args, command="""SELECT d.id, d.official_id, d.doc_type, d.filed_on, d.document_url, d.request_url, o.term_start
      FROM disclosures d JOIN officials o ON o.id = d.official_id
      WHERE d.source = 'oge' AND o.chamber = 'us-executive' AND d.filed_on IS NOT NULL""")
    out = []
    for r in rows:
        kind, year = None, None
        for rx, k in OGE_KIND:
            m = rx.match(r["doc_type"] or "")
            if m:
                kind = k
                # "Annual (2026)" is the year it was filed; it covers the year before.
                year = int(m.group(1)) - 1 if k == "annual" else int(r["filed_on"][:4])
                break
        if not kind or not (r["document_url"] or r["request_url"]):
            continue
        out.append({"id": "oge:" + hashlib.sha1(r["id"].encode()).hexdigest()[:16], "source": "oge", "kind": kind, "amended": 0,
                    "year": year, "filed_on": r["filed_on"], "official_id": r["official_id"], "url": r["document_url"],
                    "request_url": r["request_url"], "term_start": r["term_start"]})
    return out


def judiciary_reports():
    data = json.loads((ROOT / "data" / "scotus" / "trades.json").read_text())
    out = []
    for slug, j in (data.get("justices") or {}).items():
        for r in j.get("reports") or []:
            if r.get("url") and r.get("year"):
                out.append({"id": f"judiciary:{slug}:{r['year']}", "source": "judiciary", "kind": "annual", "amended": 0,
                            "year": int(r["year"]), "filed_on": None, "official_id": f"justice:{slug}", "url": r["url"]})
    return out


def first_starts():
    """{bioguide: {'rep': first House term start, 'sen': first Senate term start}} from congress-legislators."""
    data = json.loads(T.get(f"{T.LEGISLATORS}/legislators-current.json"))
    out = {}
    for p in data:
        b = (p.get("id") or {}).get("bioguide")
        for t in p.get("terms") or []:
            k = t.get("type")
            if b and k in ("rep", "sen") and t.get("start"):
                out.setdefault(b, {})
                out[b][k] = min(out[b].get(k, t["start"]), t["start"])
    return out


# ---------------------------------------------------------------------------
# Reading


def read(f, senate=None):
    """-> (status, reason, method, summary or None)."""
    if f.get("paper"):
        return "paper", "Filed on paper", None, None
    if f["source"] == "oge" and not f.get("url"):
        return "request", "Released by OGE only on request", None, None
    if f["source"] == "house" and not f["doc_id"].startswith("1"):
        return "scan", "Scanned", None, None  # the Clerk's e-filed reports have IDs starting with 1
    try:
        if f["source"] == "senate":
            got, method = N.read_senate(senate.page(f["url"])), "html"
        else:
            text = T.pdf_text(T.get(f["url"]))
            if N.is_scan(text):
                return "scan", "Scanned", None, None
            got = N.read_house(text) if f["source"] == "house" else N.read_oge(text) if f["source"] == "oge" else N.read_judiciary(text)
            method = "text"
    except N.Unreadable as e:
        return ("scan", "Scanned", None, None) if str(e) == "scanned" else ("unreadable", str(e)[:300], None, None)
    return "read", None, method, N.summarize(got)


def row_sql(f, status, reason, method, s, before_office):
    s = s or {}
    cols = {
        "id": f["id"], "official_id": f["official_id"], "source": f["source"], "kind": f["kind"], "amended": f.get("amended", 0),
        "year": f["year"], "filed_on": f.get("filed_on"), "before_office": before_office, "status": status, "reason": reason,
        "method": method, "assets": s.get("assets"), "liabilities": s.get("liabilities"), "asset_min": s.get("asset_min"),
        "asset_max": s.get("asset_max"), "liab_min": s.get("liab_min"), "liab_max": s.get("liab_max"), "low": s.get("low"),
        "high": s.get("high"), "low_open": s.get("low_open", 0), "high_open": s.get("high_open", 0),
        "residence_mortgages": s.get("residence_mortgages", 0), "report_url": f.get("url") or f.get("request_url"),
        "parser": N.PARSER_VERSION if status in ("read", "unreadable") else None,
    }
    return (f"INSERT OR REPLACE INTO networth_reports ({', '.join(cols)}, checked_at) VALUES ("
            + ", ".join(lit(v) for v in cols.values()) + ", datetime('now'));")


def before_office(f, starts, officials_by_id):
    """A candidate or nominee report filed before the office the person holds now began."""
    if f["kind"] not in ("candidate", "nominee") or not f.get("filed_on"):
        return 0
    o = officials_by_id.get(f["official_id"]) or {}
    if f["source"] in ("house", "senate"):
        start = (starts.get(o.get("bioguide_id") or "") or {}).get("rep" if f["source"] == "house" else "sen")
    else:
        start = f.get("term_start") or o.get("term_start")
    return 1 if start and f["filed_on"] < start else 0


def previews(results, by_id):
    """Measure runs: the summary line each person's page would show (functions/_lib/networth.js, networthPoints)."""
    out = []
    people = {}
    for r in results:
        people.setdefault(r["official_id"], []).append(r)
    rng = lambda r: f"{N.fmt_money(r['low'])}{' or less' if r.get('low_open') else ''}–{N.fmt_money(r['high'])}{' or more' if r.get('high_open') else ''}"
    for oid, rows in people.items():
        who = (by_id.get(oid) or {}).get("name") or oid
        annual = {}
        for r in sorted((r for r in rows if r["kind"] == "annual"), key=lambda r: (r.get("filed_on") or "", r.get("amended", 0))):
            annual[r["year"]] = r
        read = [annual[y] for y in sorted(annual) if annual[y]["status"] == "read"]
        befores = sorted((r for r in rows if r["before_office"] and r["kind"] in ("candidate", "nominee")), key=lambda r: r.get("filed_on") or "")
        before = next((r for r in befores if r["status"] == "read"), None)
        if before:
            first, label = before, "before taking office"
        elif read:
            first = read[0]
            label = "earliest report read" if any(r is not first and (r["year"] < first["year"] or (r.get("filed_on") and first.get("filed_on") and r["filed_on"] < first["filed_on"])) for r in rows) else "earliest report online"
        else:
            out.append((who, f"(no line: {len(rows)} reports, none read)"))
            continue
        latest = read[-1] if read and read[-1] is not first else None
        out.append((who, f"Net worth, as reported: {rng(first)} ({first['year']}, {label})" + (f" → {rng(latest)} ({latest['year']})" if latest else "")))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--max-reports", type=int, default=400, help="reports read this run, newest first")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--since-year", type=int, default=2008)
    ap.add_argument("--names", default="", help="measure only: last names to read (comma-separated)")
    ap.add_argument("--only", default="house,senate,oge,judiciary")
    args = ap.parse_args()
    have_d1 = bool(os.environ.get("CLOUDFLARE_API_TOKEN"))
    only = set(args.only.split(","))
    names = {T.norm(n) for n in args.names.split(",") if n.strip()}
    log = []
    say = lambda s: (print(s, flush=True), log.append(s))

    if not have_d1:
        raise SystemExit("needs Cloudflare access (the officials to match come from D1)")
    if args.mode == "load":
        T.d1(args, file=ROOT / "workers" / "sync" / "migrations" / "0036_networth.sql")
        T.d1(args, command="INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0036_networth.sql')")
    officials = T.d1(args, command="SELECT id, name, last_name, state, district_code, chamber, bioguide_id, active, term_start FROM officials WHERE chamber IN ('us-house', 'us-senate', 'us-executive')")
    by_id = {o["id"]: o for o in officials}
    known = {}
    if args.mode == "load":
        try:
            known = {r["id"]: r for r in T.d1(args, command="SELECT id, status, parser, method, reason FROM networth_reports")}
        except SystemExit:
            known = {}
    starts = first_starts()

    found = []
    if "house" in only:
        h = house_index(range(datetime.date.today().year, args.since_year - 1, -1))
        unmatched = 0
        for f in h:
            o, _ = T.match_house(f, officials)
            if o:
                found.append({**f, "official_id": o["id"]})
            else:
                unmatched += 1
        say(f"House: {len(h)} annual, amended, candidate and new member reports since {args.since_year}; {len(h) - unmatched} attach to one current member")
    senate = None
    if "senate" in only:
        try:
            senate = T.Senate()
            senate.start()
            sr = senate_reports(senate)
            matched = 0
            for f in sr:
                o, _ = T.match_senate(f, officials)
                if o:
                    found.append({**f, "official_id": o["id"]})
                    matched += 1
            say(f"Senate: {len(sr)} annual and candidate reports since 2012; {matched} attach to one senator; {sum(1 for f in sr if f['paper'])} filed on paper")
        except Exception as e:
            say(f"Senate: eFD not read ({type(e).__name__}: {e})")
    if "oge" in only:
        og = oge_reports(args)
        found += og
        say(f"Executive branch (OGE 278e): {len(og)} annual, nominee and candidate reports; {sum(1 for f in og if not f['url'])} released only on request")
    if "judiciary" in only:
        jr = judiciary_reports()
        found += jr
        say(f"Justices: {len(jr)} reports with copies")

    if names:
        found = [f for f in found if any(n in T.norm((by_id.get(f["official_id"]) or {}).get("name") or f["official_id"]) for n in names)]
    def settled(f):
        """Already in D1 and nothing new to read: a scan or paper filing (waits for the AI reading), a report still
        released only on request, or one read (or found unreadable) by this parser version."""
        k = known.get(f["id"])
        if not k:
            return False
        if k.get("method") == "ai" or (k["status"] == "scan" and (k.get("reason") or "").startswith("Read by AI")):
            return True  # read by tools/networth_scan.py: never overwritten here
        if k["status"] == "request":
            return not f.get("url")
        return k["status"] in ("scan", "paper") or k["parser"] == N.PARSER_VERSION
    todo = [f for f in found if not settled(f)]
    # The executive branch and the justices first (a few dozen), then newest first.
    first = [f for f in todo if f["source"] in ("oge", "judiciary")]
    rest = sorted((f for f in todo if f["source"] not in ("oge", "judiciary")), key=lambda f: f.get("filed_on") or "", reverse=True)
    queue = (first + rest)[: args.max_reports]
    say(f"Reading {len(queue)} of {len(todo)} reports not read yet")

    sql, tally, examples, results, unreadable = [], {}, [], [], []
    for f in queue:
        try:
            status, reason, method, s = read(f, senate)
        except Exception as e:  # the source didn't answer: tried again next run
            say(f"  {f['id']}: not fetched ({type(e).__name__})")
            continue
        tally[status] = tally.get(status, 0) + 1
        bo = before_office(f, starts, by_id)
        results.append({**f, "status": status, "before_office": bo, **(s or {})})
        sql.append(row_sql(f, status, reason, method, s, bo))
        who = (by_id.get(f["official_id"]) or {}).get("name") or f["official_id"]
        if status == "read" and (len(examples) < 40 or names):
            examples.append(f"  {who}: {f['kind']}{' (amended)' if f.get('amended') else ''} {f['year']}{' before taking office' if bo else ''}: "
                            f"{s['assets']} assets, {s['liabilities']} liabilities; {N.fmt_money(s['low'])}{' or less' if s['low_open'] else ''} to "
                            f"{N.fmt_money(s['high'])}{' or more' if s['high_open'] else ''}")
        elif status != "read" and names:
            examples.append(f"  {who}: {f['kind']} {f['year']}: {status} ({reason})")
        elif status == "unreadable":
            unreadable.append(f"  not read: {f['id']} ({who}, {f['kind']} {f['year']}): {reason}")
    say("Read: " + ", ".join(f"{v} {k}" for k, v in sorted(tally.items())))
    for e in examples:
        say(e)
    for u in unreadable[:40]:
        say(u)
    if names:
        for who, line in previews(results, by_id):
            say(f"  Line for {who}: {line}")
    if args.mode == "load" and sql:
        T.run_sql(args, sql)
        say(f"Written to D1: {len(sql)} reports")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("## Net worth reports\n\n```\n" + "\n".join(log) + "\n```\n")


if __name__ == "__main__":
    main()
