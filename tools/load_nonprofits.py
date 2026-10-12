#!/usr/bin/env python3
"""
Political spending of 501(c)(4) and 501(c)(6) nonprofits, as filed on Schedule C
of their IRS Form 990, into D1 (nonprofits; migration 0030).

The sync Worker's dark-money step finds the nonprofits that spend for or
against federal candidates or give to groups that do, and fills in their
revenue and expenses from ProPublica's Nonprofit Explorer. This reads each
one's latest e-filed return from the IRS's own XML (tools/irs990.py): the IRS
index for this year and last says which batch holds it, and a few range
requests fetch just that return. From it: the tax year and period, total
revenue and expenses, Schedule C Part I-A political campaign activity
expenditures, and the political organizations Schedule C says it paid. A
return without Schedule C says "no_schedule_c"; one not found in the IRS's
files stays a link ("not_read"), never guessed.

    python3 tools/load_nonprofits.py --mode measure   # read, write nothing
    python3 tools/load_nonprofits.py --mode load

Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (wrangler), and
zipfile-deflate64 for the batches compressed with Deflate64.
"""
import argparse
import csv
import datetime
import io
import json
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import irs990  # noqa: E402
from load_trades import d1, lit, run_sql, MIGRATIONS  # noqa: E402


def say(*a):
    print(*a, flush=True)


def ensure_tables(args):
    if any(c["name"] == "ein" for c in d1(args, command="PRAGMA table_info(fec_committees)")):
        return
    sql = (MIGRATIONS / "0030_dark_money.sql").read_text()
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql + "\nCREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);\n"
                "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0030_dark_money.sql');\n")
    d1(args, file=f.name)
    say("Applied migration 0030_dark_money.sql")


def wanted(args):
    return d1(args, command=f"""
      SELECT ein, name, tax_year FROM nonprofits
      WHERE political_read IS NULL OR xml_checked_at IS NULL OR xml_checked_at < datetime('now', '-90 days')
      ORDER BY political_read IS NOT NULL, ein LIMIT {int(args.max)}""")


def latest_returns(eins, years):
    """{ein: index row} for each EIN's newest 990, 990-EZ or 990-O in these years' IRS indexes."""
    best = {}
    for year in years:
        say(f"Reading the IRS index for {year}")
        req = urllib.request.Request(irs990.index_url(year), headers={"User-Agent": irs990.UA})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                for row in csv.DictReader(io.TextIOWrapper(r, encoding="utf-8", errors="replace")):
                    ein = (row.get("EIN") or "").lstrip("0")
                    if ein not in eins or row.get("RETURN_TYPE") not in irs990.RETURN_TYPES or not row.get("XML_BATCH_ID"):
                        continue
                    key = (row.get("TAX_PERIOD") or "", row.get("OBJECT_ID") or "")
                    if ein not in best or key > (best[ein]["TAX_PERIOD"], best[ein]["OBJECT_ID"]):
                        best[ein] = {**row, "_year": year}
        except urllib.error.HTTPError as e:
            say(f"  no index for {year} ({e.code})")
    return best


_zips = {}


def read_one(row):
    url = irs990.batch_url(row["_year"], row["XML_BATCH_ID"])
    if url not in _zips:
        _zips[url] = zipfile.ZipFile(io.BufferedReader(irs990.RangeFile(url, irs990.remote_size(url)), buffer_size=1 << 20))
    z = _zips[url]
    name = next((n for n in z.namelist() if n.startswith(row["OBJECT_ID"])), None)
    if not name:
        return None
    return irs990.read_return(z.read(name))


def sql_for(ein, row, got):
    full = f"https://projects.propublica.org/nonprofits/organizations/{ein}/{row['OBJECT_ID']}/full" if row else None
    if not got:
        return f"UPDATE nonprofits SET political_read = 'not_read', xml_checked_at = datetime('now') WHERE ein = {lit(ein)};"
    read = "schedule_c" if got["schedule_c"] else "no_schedule_c"
    recips = json.dumps(sorted(got["recipients"], key=lambda r: -(r["amount"] or 0))[:10]) if got["recipients"] else None
    return f"""UPDATE nonprofits SET tax_year = {lit(got['tax_year'])}, period_end = {lit(got['period_end'])},
      revenue = COALESCE({lit(got['revenue'])}, revenue), expenses = COALESCE({lit(got['expenses'])}, expenses),
      political = {lit(got['political'])}, political_read = {lit(read)}, recipients = {lit(recips)},
      filing_url = {lit(full)}, xml_checked_at = datetime('now') WHERE ein = {lit(ein)};"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["measure", "load"], default="measure")
    ap.add_argument("--max", type=int, default=200)
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--ein", action="append", help="read these EINs instead of D1's list (measure)")
    args = ap.parse_args()
    if args.mode == "load":
        ensure_tables(args)
    rows = [{"ein": e} for e in args.ein] if args.ein else wanted(args)
    eins = {str(r["ein"]).lstrip("0") for r in rows}
    say(f"{len(eins)} nonprofit(s) to read")
    if not eins:
        return
    year = datetime.date.today().year
    found = latest_returns(eins, [year, year - 1])
    sql, read, schedc = [], 0, 0
    for ein in sorted(eins):
        row = found.get(ein)
        got = None
        if row:
            try:
                got = read_one(row)
            except Exception as e:  # a batch that can't be read: the filing stays a link
                say(f"  {ein}: not read ({type(e).__name__}: {e})")
        if got:
            read += 1
            schedc += got["schedule_c"]
            say(f"  {ein} {got['name']} · {got['return_type']} {got['tax_year']} · revenue {got['revenue']} · expenses {got['expenses']} · "
                f"{'Schedule C political ' + str(got['political']) if got['schedule_c'] else 'no Schedule C'} · {len(got['recipients'])} political organization(s) paid")
        else:
            say(f"  {ein}: no e-filed 990 found in the IRS's {year - 1}–{year} files")
        sql.append(sql_for(ein, row, got))
    say(f"Read {read} of {len(eins)} return(s); {schedc} with Schedule C")
    if args.mode == "load" and sql:
        run_sql(args, sql)
        say("Written to D1")


if __name__ == "__main__":
    main()
