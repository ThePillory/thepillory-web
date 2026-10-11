#!/usr/bin/env python3
"""Tests for tools/load_trades.py. Standard library only.

    python3 tools/test_load_trades.py
"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_trades as T  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

INDEX = b"""<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member><Prefix>Hon.</Prefix><Last>Example</Last><First>Jane</First><Suffix /><FilingType>P</FilingType><StateDst>CA05</StateDst><Year>2026</Year><FilingDate>9/15/2026</FilingDate><DocID>20031234</DocID></Member>
  <Member><Prefix>Hon.</Prefix><Last>Example</Last><First>Jane</First><Suffix /><FilingType>O</FilingType><StateDst>CA05</StateDst><Year>2026</Year><FilingDate>5/15/2026</FilingDate><DocID>10061234</DocID></Member>
  <Member><Prefix>Hon.</Prefix><Last>Paper</Last><First>Pat</First><Suffix /><FilingType>P</FilingType><StateDst>TX12</StateDst><Year>2026</Year><FilingDate>8/1/2026</FilingDate><DocID>8221234</DocID></Member>
</FinancialDisclosure>"""

# pdftotext -layout output in the layout of an electronic House PTR.
HOUSE_TEXT = """
Periodic Transaction Report
Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515

Name:            Hon. Jane Example
Status:          Member
State/District:  CA05

ID   Owner Asset                                   Transaction Date          Notification      Amount                 Cap.
                                                   Type                      Date                                     Gains >
                                                                                                                      $200?
     SP    Apple Inc. - Common Stock (AAPL) [ST]   P           07/01/2026    07/02/2026        $1,001 - $15,000
           F S: New
     JT    Alphabet Inc. - Class A Common Stock    S (partial) 06/03/2026    06/04/2026        $500,001 -
           (GOOGL) [ST]                                                                        $1,000,000
           F S: New
           D: Sold shares held in a joint account.
           Example Municipal Bond Fund [MF]        E           05/20/2026    05/21/2026        $15,001 - $50,000
     DC    Example Holdings Corp. (EXH) [ST]       S           04/01/2026    04/02/2026        Over $50,000,000

* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.
I CERTIFY that the statements I have made on the attached Report are true, complete, and correct to the best of my knowledge and belief.
Digitally Signed: Hon. Jane Example , 09/15/2026
"""

SENATE_HTML = """<html><body><h1>Periodic Transaction Report</h1>
<table class="table table-striped"><thead><tr><th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th><th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th></tr></thead>
<tbody>
<tr><td>1</td><td>08/14/2026</td><td>Spouse</td><td><a href="https://finance.yahoo.com/quote/MSFT">MSFT</a></td><td>Microsoft Corporation<div class="text-muted"><em>Rate/Coupon:</em> --</div></td><td>Stock</td><td>Purchase</td><td>$15,001 - $50,000</td><td>--</td></tr>
<tr><td>2</td><td>08/20/2026</td><td>Self</td><td>--</td><td>Example State Bond</td><td>Municipal Security</td><td>Sale (Partial)</td><td>$1,001 - $15,000</td><td>--</td></tr>
</tbody></table></body></html>"""


class LoadTrades(unittest.TestCase):
    def test_house_index_keeps_only_periodic_transaction_reports(self):
        rows = T.parse_house_index(INDEX)
        self.assertEqual([r["doc_id"] for r in rows], ["20031234", "8221234"])
        self.assertEqual(rows[0]["filed_on"], "2026-09-15")
        self.assertEqual(T.house_pdf_url(2026, "20031234"), "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20031234.pdf")

    def test_house_report_rows_as_filed(self):
        rows = T.parse_house_ptr_text(HOUSE_TEXT)
        self.assertEqual(len(rows), 4)
        a, b, c, d = rows
        self.assertEqual((a["owner"], a["ticker"], a["type"], a["transaction_date"], a["amount"]), ("Spouse", "AAPL", "Purchase", "2026-07-01", "$1,001 - $15,000"))
        self.assertEqual(a["asset_name"], "Apple Inc. - Common Stock (AAPL)")
        self.assertEqual(a["asset_type"], "ST")
        self.assertEqual((b["owner"], b["type"], b["amount"], b["ticker"]), ("Joint", "Partial sale", "$500,001 - $1,000,000", "GOOGL"))
        self.assertIn("Alphabet Inc. - Class A Common Stock (GOOGL)", b["asset_name"])
        self.assertEqual((c["owner"], c["type"], c["ticker"]), ("Self", "Exchange", None))
        self.assertEqual((d["owner"], d["amount_min"], d["amount_max"]), ("Dependent child", 50000001, None))

    def test_unreadable_or_unfinished_tables_are_not_guessed(self):
        self.assertIsNone(T.parse_house_ptr_text(""))
        self.assertIsNone(T.parse_house_ptr_text("ID Owner Asset\nsomething else entirely"))
        cut = HOUSE_TEXT.replace("$1,000,000", "")
        self.assertIsNone(T.parse_house_ptr_text(cut), "a range without its upper bound is not guessed")

    def test_senate_report_table(self):
        rows = T.parse_senate_ptr_html(SENATE_HTML)
        self.assertEqual(len(rows), 2)
        self.assertEqual((rows[0]["owner"], rows[0]["ticker"], rows[0]["type"], rows[0]["transaction_date"]), ("Spouse", "MSFT", "Purchase", "2026-08-14"))
        self.assertTrue(rows[0]["asset_name"].startswith("Microsoft Corporation"))
        self.assertEqual((rows[1]["ticker"], rows[1]["type"]), (None, "Partial sale"))
        self.assertIsNone(T.parse_senate_ptr_html("<p>no table</p>"))
        self.assertEqual(T.senate_link('<a href="/search/view/paper/AB12-34/" target="_blank">Report</a>'), ("paper", "https://efdsearch.senate.gov/search/view/paper/AB12-34/"))

    def test_owner_is_never_a_name(self):
        self.assertEqual(T.owner_label("SP"), "Spouse")
        self.assertEqual(T.owner_label(""), "Self")
        self.assertEqual(T.owner_label("Child"), "Dependent child")
        self.assertIsNone(T.owner_label("Jane Q. Example"))

    def test_amounts_and_days(self):
        self.assertEqual(T.amount_bounds("$1,001 - $15,000"), (1001, 15000))
        self.assertEqual(T.amount_bounds("Spouse/DC Over $1,000,000"), (1000001, None))
        self.assertEqual(T.days_between("2026-01-01", "2026-04-23"), 112)
        self.assertEqual(T.sic_division("3571"), "Manufacturing")
        self.assertEqual(T.sic_division("6022"), "Finance, Insurance and Real Estate")
        self.assertIsNone(T.sic_division(None))

    def test_matching_needs_exactly_one_member(self):
        officials = [
            {"id": "h1", "name": "Jane Example", "last_name": "Example", "state": "CA", "district_code": "5", "chamber": "us-house", "active": 1},
            {"id": "h2", "name": "Sam Example", "last_name": "Example", "state": "CA", "district_code": "6", "chamber": "us-house", "active": 1},
            {"id": "s1", "name": "Ann Núñez", "last_name": "Núñez", "state": "WA", "chamber": "us-senate", "active": 1},
            {"id": "s2", "name": "Bob Smith", "last_name": "Smith", "state": "OH", "chamber": "us-senate", "active": 1},
            {"id": "s3", "name": "Bea Smith", "last_name": "Smith", "state": "TX", "chamber": "us-senate", "active": 1},
        ]
        self.assertEqual(T.match_house({"last": "Example", "state_dst": "CA05"}, officials)[0]["id"], "h1")
        o, why = T.match_house({"last": "Example", "state_dst": "CA07"}, officials)
        self.assertIsNone(o)
        self.assertIn("0 House members", why)
        self.assertEqual(T.match_senate({"first": "Ann", "last": "Nunez"}, officials)[0]["id"], "s1")
        self.assertIsNone(T.match_senate({"first": "B", "last": "Smith"}, officials)[0], "two senators: not attached")
        self.assertEqual(T.match_senate({"first": "Robert", "last": "Smith"}, officials)[0], None, "a first name that doesn't match")

    def test_sql_writes_reports_trades_and_summaries(self):
        db = sqlite3.connect(":memory:")
        db.executescript((ROOT / "workers/sync/migrations/0024_trades.sql").read_text())
        rep = {"id": "house:20031234", "chamber": "us-house", "official_id": "h1", "filer_name": "Jane Example", "state": "CA", "district": "CA05",
               "filed_on": "2026-09-15", "report_url": "https://example.org/r.pdf", "paper": 0, "parsed": 1, "trade_count": 4, "unmatched": None,
               "source_url": "https://example.org/r.pdf"}
        trades = T.parse_house_ptr_text(HOUSE_TEXT)
        paper = {**rep, "id": "house:8221234", "paper": 1, "parsed": 0, "trade_count": 0, "filed_on": "2026-08-01"}
        db.executescript("\n".join(T.report_sql(rep, trades) + T.report_sql(paper, []) + T.summary_sql({"h1"})))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM trades").fetchone()[0], 4)
        days = dict(db.execute("SELECT n, days_to_file FROM trades"))
        self.assertEqual(days[1], 76)
        self.assertEqual(db.execute("SELECT owner FROM trades WHERE n = 1").fetchone()[0], "Spouse")
        self.assertEqual(db.execute("SELECT trades, total_min, total_max, open_ended, paper FROM trade_summary WHERE official_id = 'h1' AND year = 2026").fetchone(),
                         (4, 1001 + 500001 + 15001 + 50000001, None, 1, 1))
        # Loading the same report again replaces its trades.
        db.executescript("\n".join(T.report_sql(rep, trades[:1]) + T.summary_sql({"h1"})))
        self.assertEqual(db.execute("SELECT trades, total_max FROM trade_summary WHERE official_id = 'h1'").fetchone(), (1, 15000))


if __name__ == "__main__":
    unittest.main()
