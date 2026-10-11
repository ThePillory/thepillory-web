#!/usr/bin/env python3
"""
California officials' investments acquired and disposed of, from Schedule A-1
of their annual Form 700, into D1 (form700_lines, form700_reads; migration 0028).

The sync Worker's executive-funding step lists each official's Form 700s
(disclosures, source 'fppc'): the Governor and statewide officers, the
Legislature and the county's supervisors. This reads each annual statement
since 2023 (the newest filing for each year, so an amendment replaces the
original), with tools/form700.py, and writes each Schedule A-1 investment with
an acquired or disposed date, exactly as filed. A statement not read in full
is recorded as a link. Statements already read by this parser version are
skipped, so a run reads only new ones.

    python3 tools/load_form700.py --mode measure   # read up to --max statements, write nothing
    python3 tools/load_form700.py --mode load      # read them and write to D1

Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (wrangler), and pdfplumber.
"""
import argparse
import http.cookiejar
import json
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import form700  # noqa: E402
from load_trades import d1, lit, run_sql, MIGRATIONS  # noqa: E402

FPPC = "https://form700search.fppc.ca.gov"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
FIRST_YEAR = 2023
SITE = "https://thepillory.co"


def say(*a):
    print(*a, flush=True)


# The FPPC hands out a statement's PDF link within a browsing session: keep its cookies,
# and open the search page first, as a reader's browser does.
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
_session = []


def get(url, *, accept="application/json"):
    if not _session:
        req = urllib.request.Request(f"{FPPC}/", headers={"User-Agent": UA, "Accept": "text/html"})
        with OPENER.open(req, timeout=120) as r:
            r.read()
        _session.append(True)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with OPENER.open(req, timeout=120) as r:
        return r.read()


def ensure_tables(args):
    """Apply migration 0028 if the Worker hasn't yet, and record it so the Worker doesn't apply it again."""
    have = {r["name"] for r in d1(args, command="SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('form700_reads', 'form700_lines')")}
    if have == {"form700_reads", "form700_lines"}:
        return
    sql = (MIGRATIONS / "0028_form700_lines.sql").read_text()
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql + "\nINSERT OR IGNORE INTO d1_migrations (name) VALUES ('0028_form700_lines.sql');\n")
    d1(args, file=f.name)
    say("Applied migration 0028_form700_lines.sql")


def statements(args):
    """The newest annual Form 700 for each official and year since FIRST_YEAR that this parser hasn't read."""
    return d1(args, command=f"""
      SELECT d.id, d.official_id, d.period, d.filed_on, d.detail, o.name
      FROM disclosures d JOIN officials o ON o.id = d.official_id
      LEFT JOIN form700_reads r ON r.disclosure_id = d.id
      WHERE d.source = 'fppc' AND d.doc_type LIKE '%Annual%' AND CAST(d.period AS INTEGER) >= {FIRST_YEAR}
        AND d.filed_on = (SELECT MAX(x.filed_on) FROM disclosures x WHERE x.official_id = d.official_id AND x.source = 'fppc'
                          AND x.period = d.period AND x.doc_type = d.doc_type)
        AND (r.disclosure_id IS NULL OR r.parser < {form700.PARSER_VERSION})
      ORDER BY CAST(d.period AS INTEGER) DESC, o.chamber = 'county-board' DESC, o.chamber = 'ca-executive' DESC, d.filed_on DESC
      LIMIT {int(args.max)}""")


def fetch_pdf(row):
    """A fresh PDF link from the FPPC (they expire), then the PDF."""
    detail = json.loads(row["detail"] or "{}")
    q = {"indexID": detail["index_id"], **{k: "" if v is None else str(v) for k, v in (detail.get("pdf") or {}).items()}}
    link = json.loads(get(f"{FPPC}/Home/GetRedactedFormPdf?{urllib.parse.urlencode(q)}"))
    url = str(link.get("PDFDownloadUrl") or "")
    if not url.startswith(f"{FPPC}/"):
        raise RuntimeError(f"no PDF link ({link.get('Message')})")
    pdf = get(url, accept="application/pdf")
    if pdf[:4] != b"%PDF":
        raise RuntimeError(f"not a PDF: {pdf[:120]!r}")
    return pdf


def write_sql(row, entries, error=None):
    did, oid, period = row["id"], row["official_id"], row["period"]
    index_id = did.split(":", 1)[1]
    source = f"{SITE}/api/form700/{index_id}"
    out = [f"DELETE FROM form700_lines WHERE disclosure_id = {lit(did)};"]
    if error:
        out.append(f"""INSERT OR REPLACE INTO form700_reads (disclosure_id, official_id, period, status, reason, entries, lines, parser)
          VALUES ({lit(did)}, {lit(oid)}, {lit(period)}, 'link', {lit(str(error)[:300])}, 0, 0, {form700.PARSER_VERSION});""")
        return out
    dated = [e for e in entries if e["acquired"] or e["disposed"]]
    # A newer statement for the same year (an amendment) replaces an older one's lines.
    out.append(f"DELETE FROM form700_lines WHERE official_id = {lit(oid)} AND period = {lit(period)};")
    for e in dated:
        out.append(f"""INSERT INTO form700_lines (disclosure_id, official_id, period, n, entity, description, nature, value, acquired, disposed, page, source_url)
          VALUES ({lit(did)}, {lit(oid)}, {lit(period)}, {e['n']}, {lit(e['entity'])}, {lit(e['description'])}, {lit(e['nature'])}, {lit(e['value'])},
                  {lit(e['acquired'])}, {lit(e['disposed'])}, {e['page']}, {lit(source)});""")
    out.append(f"""INSERT OR REPLACE INTO form700_reads (disclosure_id, official_id, period, status, reason, entries, lines, parser)
      VALUES ({lit(did)}, {lit(oid)}, {lit(period)}, 'read', NULL, {len(entries)}, {len(dated)}, {form700.PARSER_VERSION});""")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["measure", "load"], default="measure")
    ap.add_argument("--max", type=int, default=60, help="statements to read this run")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--pace", type=float, default=3.0, help="seconds between FPPC requests")
    args = ap.parse_args()
    if args.mode == "load":
        ensure_tables(args)
    rows = statements(args)
    say(f"{len(rows)} statement(s) to read")
    sql, read, links, lines = [], 0, 0, 0
    for row in rows:
        try:
            pdf = fetch_pdf(row)
        except Exception as e:  # the FPPC didn't hand the statement over: try again next run
            say(f"  {row['name']} {row['period']}: not downloaded ({type(e).__name__}: {e})")
            time.sleep(args.pace)
            continue
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(pdf)
            f.flush()
            try:
                entries = form700.read_pdf(f.name, int(row["period"]))
                dated = [e for e in entries if e["acquired"] or e["disposed"]]
                say(f"  {row['name']} {row['period']}: {len(entries)} Schedule A-1 investments, {len(dated)} acquired or disposed of")
                for e in dated[:3]:
                    say(f"      {e['disposed'] and 'Disposed ' + e['disposed'] or 'Acquired ' + e['acquired']} · {e['entity']} · {e['value']}")
                sql += write_sql(row, entries)
                read += 1
                lines += len(dated)
            except form700.Unreadable as e:
                say(f"  {row['name']} {row['period']}: left as a link ({e})")
                sql += write_sql(row, [], error=e)
                links += 1
        time.sleep(args.pace)
    say(f"Read {read} statement(s) in full ({lines} lines); {links} left as links")
    if args.mode == "load" and sql:
        run_sql(args, sql)
        say("Written to D1")


if __name__ == "__main__":
    main()
