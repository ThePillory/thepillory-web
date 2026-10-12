#!/usr/bin/env python3
"""Tests for tools/usaspending.py. Every response here is FAKE, shaped like USAspending's."""
import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import usaspending as U  # noqa: E402

# One university listed several ways (the money on its child record), a laboratory with a longer
# name, and a second, unrelated organization with the same name and no money.
RESULTS = [
    {"id": "aaa-C", "recipient_level": "C", "name": "THE EXAMPLE UNIVERSITY APPLIED PHYSICS LABORATORY LLC", "amount": 2000},
    {"id": "bbb-C", "recipient_level": "C", "name": "THE EXAMPLE UNIVERSITY", "amount": 1100},
    {"id": "bbb-P", "recipient_level": "P", "name": "THE EXAMPLE UNIVERSITY", "amount": 0},
    {"id": "bbb-R", "recipient_level": "R", "name": "THE EXAMPLE UNIVERSITY", "amount": 0},
    {"id": "ccc-P", "recipient_level": "P", "name": "EXAMPLE UNIVERSITY", "amount": 0},
    {"id": "ccc-R", "recipient_level": "R", "name": "EXAMPLE UNIVERSITY", "amount": 0},
]


class Pick(unittest.TestCase):
    def test_name_key_matches_the_page(self):
        self.assertEqual(U.name_key("The Example Co., Inc."), "example")
        self.assertEqual(U.name_key("Example & Sons"), "example and sons")

    def test_one_record_per_organization_the_one_with_money(self):
        got = U.pick_recipients(RESULTS, "Example University")
        self.assertEqual(got["total_found"], 2)
        self.assertEqual([r["id"] for r in got["recipients"]], ["bbb-C"])

    def test_no_money_anywhere_keeps_them(self):
        got = U.pick_recipients([r for r in RESULTS if r["id"].startswith("ccc")], "Example University")
        self.assertEqual([r["id"] for r in got["recipients"]], ["ccc-P"])

    def test_no_exact_name(self):
        self.assertEqual(U.pick_recipients(RESULTS, "Example Institute")["recipients"], [])


class Lookup(unittest.TestCase):
    def test_by_agency_and_fiscal_year(self):
        def post(path, body):
            if path == "recipient/":
                return {"results": RESULTS}
            start = body["filters"]["time_period"][0]["start_date"]
            return {"results": [{"name": "Department of Example", "amount": 1200.5}, {"name": "Zero Agency", "amount": 0}] if start == "2025-10-01" else []}

        got = U.lookup("Example University", today=datetime.date(2026, 10, 12), post=post,
                       get=lambda path: {"location": {"city_name": "Exampletown", "state_code": "MD"}})
        self.assertEqual(got["fiscal_years"], [2027, 2026, 2025, 2024])
        r = got["recipients"][0]
        self.assertEqual((r["id"], r["location"]), ("bbb-C", "Exampletown, MD"))
        self.assertEqual([(y["fy"], y["total"]) for y in r["years"]], [(2027, 0), (2026, 1200.5), (2025, 0), (2024, 0)])
        self.assertEqual(r["years"][1]["agencies"], [{"name": "Department of Example", "amount": 1200.5}])
        self.assertEqual(got["checked"], "2026-10-12")


if __name__ == "__main__":
    unittest.main()
