#!/usr/bin/env python3
"""
California lobbying from the Cal-Access export into D1 (migration 0029):

  - lobbyist employers' quarterly reports (Form 635) and reports of
    organizations that spent $5,000 or more to influence state action
    (Form 645) since 2025: who, the quarter, the total paid for lobbying, and
    the bills the report lists (tools/ca_lobbying.py) → ca_lobby_reports,
    ca_bill_lobbying;
  - contributions to state candidates' committees that lobbyist employers,
    lobbying firms (Form 625), those organizations, and lobbyists (Form 615)
    report → ca_lobby_contributions. Lobbyists, and anyone reporting under
    their own name, are kept without a name: pages show them only as counts
    and totals.

The latest amendment of each filing is kept; a run writes only filings that
are new or amended since the last run (ca_lobby_loaded).

    python3 tools/load_ca_lobbying.py <dbwebexport.zip> --mode measure   # read, write nothing
    python3 tools/load_ca_lobbying.py <dbwebexport.zip> --mode load

Runs in the weekly "Refresh California campaign data" workflow, after
tools/build_ca_campaign.py has downloaded the export. Needs
CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (wrangler). Standard library only.
"""
import argparse
import collections
import csv
import io
import os
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ca_lobbying as C  # noqa: E402
from load_trades import d1, lit, MIGRATIONS  # noqa: E402

csv.field_size_limit(10**9)
ROWS_PER_INSERT = 200
MAX_STATEMENT = 80000  # bytes; D1 refuses a statement over 100 KB
STATEMENTS_PER_FILE = 4000


def say(*a):
    print(*a, flush=True)


def rows(zf, table):
    member = next(n for n in zf.namelist() if n.upper().endswith(f"/{table}.TSV"))
    with zf.open(member) as f:
        rd = csv.reader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(rd)
        for r in rd:
            yield dict(zip(header, r))


def read_export(zip_path):
    """The latest amendment of each lobbying filing since C.SINCE: reports (with bills) and contributions."""
    zf = zipfile.ZipFile(zip_path)
    covers = C.latest_amendments(
        r for r in rows(zf, "CVR_LOBBY_DISCLOSURE_CD") if r["FORM_TYPE"] in C.FORMS and C.iso(r.get("FROM_DATE")) >= C.SINCE
    )
    keep = {(fid, r["AMEND_ID"]) for fid, r in covers.items()}
    totals = collections.defaultdict(dict)
    for r in rows(zf, "SMRY_CD"):
        if r["FORM_TYPE"] in C.TOTAL_LINE and (r["FILING_ID"], r["AMEND_ID"]) in keep:
            totals[r["FILING_ID"]][r["LINE_ITEM"]] = C.amount(r.get("AMOUNT_A"))
    contribs = collections.defaultdict(list)
    for r in rows(zf, "LCCM_CD"):
        if r["FORM_TYPE"] in C.CONTRIB_FORMS and (r["FILING_ID"], r["AMEND_ID"]) in keep:
            contribs[r["FILING_ID"]].append(C.contribution_row(r, covers[r["FILING_ID"]]))
    filings = {}
    people = 0
    for fid, cover in covers.items():
        report = C.report_row(cover, totals.get(fid, {})) if cover["FORM_TYPE"] in C.TOTAL_LINE else None
        if cover["FORM_TYPE"] in C.TOTAL_LINE and report is None:
            people += 1
        filings[fid] = {"amend_id": int(cover["AMEND_ID"] or 0), "form": cover["FORM_TYPE"], "report": report, "contributions": contribs.get(fid, [])}
    return filings, people


def ensure_tables(args):
    have = {r["name"] for r in d1(args, command="SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ca_lobby_reports', 'ca_lobby_loaded')")}
    if have == {"ca_lobby_reports", "ca_lobby_loaded"}:
        return
    sql = (MIGRATIONS / "0029_lobbying_more.sql").read_text()
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql + "\nCREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);\n"
                "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0029_lobbying_more.sql');\n")
    d1(args, file=f.name)
    say("Applied migration 0029_lobbying_more.sql")


def inserts(table, cols, values):
    """Multi-row INSERTs: up to ROWS_PER_INSERT rows, and under D1's 100 KB statement limit."""
    head = f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES "
    out, part, size = [], [], 0
    for row in values:
        v = "(" + ", ".join(lit(x) for x in row) + ")"
        if part and (len(part) >= ROWS_PER_INSERT or size + len(v) > MAX_STATEMENT):
            out.append(head + ", ".join(part) + ";")
            part, size = [], 0
        part.append(v)
        size += len(v) + 2
    if part:
        out.append(head + ", ".join(part) + ";")
    return out


def sql_for(changed, loaded):
    """Statements that replace each changed filing's rows."""
    out = []
    old = [fid for fid in changed if fid in loaded]
    for i in range(0, len(old), 300):
        ids = ", ".join(lit(x) for x in old[i:i + 300])
        for table in ("ca_bill_lobbying", "ca_lobby_contributions", "ca_lobby_reports"):
            out.append(f"DELETE FROM {table} WHERE filing_id IN ({ids});")
    reports, bills, contribs, done = [], [], [], []
    for fid, f in changed.items():
        r = f["report"]
        if r and r["period_end"] and r["employer_name"]:
            reports.append([r[k] for k in ("filing_id", "amend_id", "form", "employer_id", "employer_name", "period_start", "period_end", "filed_on", "amount", "activity", "source_url")])
            bills += [[b, fid] for b in r["bills"]]
        for c in f["contributions"]:
            contribs.append([c[k] for k in ("filing_id", "n", "form", "filer_kind", "filer_id", "filer_name", "recipient_id", "recipient_name", "date", "amount", "source_url")])
        done.append([fid, f["amend_id"], f["form"]])
    out += inserts("ca_lobby_reports", ["filing_id", "amend_id", "form", "employer_id", "employer_name", "period_start", "period_end", "filed_on", "amount", "activity", "source_url"], reports)
    out += inserts("ca_bill_lobbying", ["bill_id", "filing_id"], bills)
    out += inserts("ca_lobby_contributions", ["filing_id", "n", "form", "filer_kind", "filer_id", "filer_name", "recipient_id", "recipient_name", "date", "amount", "source_url"], contribs)
    out += inserts("ca_lobby_loaded", ["filing_id", "amend_id", "form"], done)
    return out, len(reports), len(bills), len(contribs)


def run(args, statements):
    for i in range(0, len(statements), STATEMENTS_PER_FILE):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write("\n".join(statements[i:i + STATEMENTS_PER_FILE]))
        try:
            d1(args, file=f.name)
        finally:
            os.unlink(f.name)
        say(f"  wrote statements {i + 1}–{min(i + STATEMENTS_PER_FILE, len(statements))} of {len(statements)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip")
    ap.add_argument("--mode", choices=["measure", "load"], default="measure")
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()
    filings, people = read_export(args.zip)
    reports = [f["report"] for f in filings.values() if f["report"]]
    with_bills = [r for r in reports if r["bills"]]
    say(f"{len(filings)} lobbying filing(s) since {C.SINCE} (latest amendments); {len(reports)} employer report(s), "
        f"{len(with_bills)} listing bills ({sum(len(r['bills']) for r in reports)} bill mentions); {people} report(s) filed under a person's own name left out; "
        f"{sum(len(f['contributions']) for f in filings.values())} contribution(s)")
    for r in with_bills[:5]:
        say(f"  {r['employer_name']} · {r['period_start']}–{r['period_end']} · ${r['amount'] or 0:,.0f} · {', '.join(r['bills'][:6])}")
    if args.mode != "load":
        return
    ensure_tables(args)
    loaded = {r["filing_id"]: int(r["amend_id"]) for r in d1(args, command="SELECT filing_id, amend_id FROM ca_lobby_loaded")}
    changed = {fid: f for fid, f in filings.items() if loaded.get(fid) != f["amend_id"]}
    statements, n_reports, n_bills, n_contribs = sql_for(changed, loaded)
    say(f"{len(changed)} new or amended filing(s): {n_reports} report(s), {n_bills} bill link(s), {n_contribs} contribution(s)")
    if statements:
        run(args, statements)
        say("Written to D1")


if __name__ == "__main__":
    main()
