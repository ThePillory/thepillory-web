#!/usr/bin/env python3
"""Tests for tools/ca_lobbying.py and the SQL tools/load_ca_lobbying.py writes. Activity texts are real report wording."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ca_lobbying as C  # noqa: E402
import load_ca_lobbying as L  # noqa: E402


class Bills(unittest.TestCase):
    def test_prefix_carries_over(self):
        self.assertEqual(C.bills_in("AB 6, 7, 96, 316; SB 411, 544"), ["AB 6", "AB 7", "AB 96", "AB 316", "SB 411", "SB 544"])
        self.assertEqual(C.bills_in("ABs 238, 683; SBs 14, 45 and 633"), ["AB 238", "AB 683", "SB 14", "SB 45", "SB 633"])
        self.assertEqual(C.bills_in("AB 46, 322; ACR 23; SB 331,  531"), ["AB 46", "AB 322", "ACR 23", "SB 331", "SB 531"])

    def test_written_other_ways(self):
        self.assertEqual(C.bills_in("SB, 1325, A.B. 12 and 14"), ["SB 1325", "AB 12", "AB 14"])
        self.assertEqual(C.bills_in("AB 1231, AB 1261."), ["AB 1231", "AB 1261"])
        self.assertEqual(C.bills_in("AB1331: Legislature re: CalOSHA"), ["AB 1331"])

    def test_not_bills(self):
        self.assertEqual(C.bills_in("NO LEGISLATION OR ADMINISTRATIVE ACTIONS LOBBIED THIS QUARTER"), [])
        self.assertEqual(C.bills_in("Caltrans re: SR 99 widening; HR 12"), [])
        self.assertEqual(C.bills_in("FY 2025-2026 budget; AB 5, 2026-27 budget"), ["AB 5"])
        self.assertEqual(C.bills_in("AB 100, 5% cap; LAB 12"), ["AB 100"])

    def test_earlier_laws_set_aside(self):
        # Implementing a law passed in an earlier session: its number isn't this session's bill.
        self.assertEqual(C.bills_in("SBs 72, 237; California Air Resources Board re: Regulations Implementing SB 253 & SB 261"), ["SB 72", "SB 237"])
        self.assertEqual(C.bills_in("CalRecycle re: SB 343 implementation; AB 1148"), ["AB 1148"])

    def test_ids_and_sessions(self):
        self.assertEqual(C.session_of("2026-03-31"), "20252026")
        self.assertEqual(C.session_of("2025-06-30"), "20252026")
        self.assertEqual(C.session_of("2027-03-31"), "20272028")
        self.assertEqual(C.bill_id("ACR 23", "20252026"), "ca-20252026-acr-23")


COVER = {
    "FILING_ID": "3066461", "AMEND_ID": "1", "FORM_TYPE": "F635", "FILER_ID": "C26481", "FILER_NAML": "CITY OF EXAMPLE", "FILER_NAMF": "",
    "FROM_DATE": "4/1/2025 12:00:00 AM", "THRU_DATE": "6/30/2025 12:00:00 AM", "RPT_DATE": "7/31/2025 12:00:00 AM",
    "LBY_ACTVTY": "AB 2334, 2464; SB 919; LEGISLATURE RE: RENEWABLE PORTFOLIO STANDARD   ",
}


class Rows(unittest.TestCase):
    def test_report(self):
        r = C.report_row(COVER, {"ABCD": 17400.0, "B": 17400.0})
        self.assertEqual(r["employer_name"], "CITY OF EXAMPLE")
        self.assertEqual((r["period_start"], r["period_end"], r["filed_on"]), ("2025-04-01", "2025-06-30", "2025-07-31"))
        self.assertEqual(r["amount"], 17400.0)
        self.assertEqual(r["bills"], ["ca-20252026-ab-2334", "ca-20252026-ab-2464", "ca-20252026-sb-919"])
        self.assertEqual(r["source_url"], "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=3066461&amendid=1")
        self.assertEqual(r["activity"], "AB 2334, 2464; SB 919; LEGISLATURE RE: RENEWABLE PORTFOLIO STANDARD")

    def test_a_person_is_not_named(self):
        self.assertIsNone(C.report_row({**COVER, "FORM_TYPE": "F645", "FILER_NAMF": "JANE"}, {"AB": 9000.0}))
        item = {"FILING_ID": "1", "AMEND_ID": "0", "LINE_ITEM": "3", "FORM_TYPE": "F615P2", "RECIP_NAML": "SMITH FOR ASSEMBLY 2026", "RECIP_ID": "1477000", "CTRIB_DATE": "3/3/2026 12:00:00 AM", "AMOUNT": "250"}
        c = C.contribution_row(item, {"FILER_ID": "1400000", "FILER_NAML": "DOE", "FILER_NAMF": "JOHN"})
        self.assertEqual((c["filer_kind"], c["filer_name"]), ("lobbyist", None))
        c = C.contribution_row({**item, "FORM_TYPE": "F645P3B"}, {"FILER_ID": "1400001", "FILER_NAML": "ROE", "FILER_NAMF": "JANE"})
        self.assertEqual((c["filer_kind"], c["filer_name"]), ("other", None))

    def test_employer_contribution(self):
        item = {"FILING_ID": "3206540", "AMEND_ID": "0", "LINE_ITEM": "2", "FORM_TYPE": "F635P4B", "RECIP_NAML": "EXAMPLE FOR ASSEMBLY 2026", "RECIP_ID": "1477498", "CTRIB_DATE": "7/9/2026 12:00:00 AM", "AMOUNT": "2200"}
        c = C.contribution_row(item, {"FILER_ID": "C1", "FILER_NAML": "EXAMPLE UTILITY CO", "FILER_NAMF": ""})
        self.assertEqual((c["filer_kind"], c["filer_name"], c["recipient_id"], c["date"], c["amount"], c["n"]), ("employer", "EXAMPLE UTILITY CO", "1477498", "2026-07-09", 2200.0, 2))

    def test_mistyped_quarters_left_out(self):
        self.assertTrue(C.in_range(COVER, "2026-10-12"))
        self.assertFalse(C.in_range({**COVER, "FROM_DATE": "7/1/2101 12:00:00 AM", "THRU_DATE": "9/30/2013 12:00:00 AM"}, "2026-10-12"))
        self.assertFalse(C.in_range({**COVER, "FROM_DATE": "1/1/2024 12:00:00 AM", "THRU_DATE": "3/31/2024 12:00:00 AM"}, "2026-10-12"))

    def test_latest_amendment(self):
        got = C.latest_amendments([{**COVER, "AMEND_ID": "0"}, {**COVER, "AMEND_ID": "2"}, {**COVER, "AMEND_ID": "1"}])
        self.assertEqual(got["3066461"]["AMEND_ID"], "2")


class Sql(unittest.TestCase):
    def test_replaces_amended_filings_only(self):
        r = C.report_row(COVER, {"ABCD": 17400.0})
        changed = {"3066461": {"amend_id": 1, "form": "F635", "report": r, "contributions": []}}
        out, n_reports, n_bills, _ = L.sql_for(changed, {"3066461": 0})
        self.assertEqual((n_reports, n_bills), (1, 3))
        self.assertTrue(out[0].startswith("DELETE FROM ca_bill_lobbying WHERE filing_id IN ('3066461')"))
        self.assertTrue(any(s.startswith("INSERT OR REPLACE INTO ca_lobby_loaded") for s in out))
        out, *_ = L.sql_for(changed, {})
        self.assertFalse(any(s.startswith("DELETE") for s in out))

    def test_statements_stay_small(self):
        rows = [[str(i), "x" * 1500] for i in range(500)]
        stmts = L.inserts("t", ["a", "b"], rows)
        self.assertTrue(all(len(s) < 100000 for s in stmts))
        self.assertEqual(sum(s.count("('") for s in stmts), 500)


if __name__ == "__main__":
    unittest.main()
