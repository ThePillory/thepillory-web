#!/usr/bin/env python3
"""Tests for tools/networth_scan.py and the AI-reading rules in tools/networth.py:
choosing the pages, splitting them into chunks, reading the models' lines,
comparing two readings line by line, and adding up the agreed lines. No
network and no model: the readings here are written by hand. Every name is
invented. Standard library only.

    python3 tools/test_networth_scan.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import networth as N  # noqa: E402
import networth_scan as S  # noqa: E402

PAGE = "OGE Form 278e (Updated 08/2024)\nInstructions for {0}\nFiler's Name   Page Number\nExample Filer   Page {1} of 9\n{0}: Heading\n"
TEXTS = [
    "OGE Form 278e\nReport Type: Annual",                    # 1 cover
    PAGE.format("Part 1", 2),                                # 2 positions: not read
    PAGE.format("Part 2", 3) + "1.  See attached Schedule 1",
    PAGE.format("Part 6", 4) + "1   EXAMPLE FUND   $1,001 - $15,000",
    "continued table, no heading\n2   EXAMPLE BOND   $15,001 - $50,000",  # 5 continues Part 6
    PAGE.format("Part 7", 6) + "1  EXAMPLE  Sale  $1,001 - $15,000",       # transactions: not read
    PAGE.format("Part 8", 7) + "1  Example Bank  Mortgage on personal residence  $250,001 - $500,000",
    "OGE Form 278e\nSchedule 1 for Part 2\n1  EXAMPLE HOLDINGS LLC  $5,000,001 - $25,000,000",
    "OGE Form 278e\nExhibit A\nan exhibit with no values",
]


def L(page, sec, n, v, flags="", grp="", cred=""):
    return {"page": page, "sec": sec, "grp": grp, "n": n, "v": v, "inc": "I" in flags, "elsewhere": "E" in flags, "nra": "N" in flags, "unsure": "U" in flags, "cred": cred}


class Pages(unittest.TestCase):
    def test_only_asset_and_liability_pages(self):
        got = S.page_sections(TEXTS)
        self.assertEqual(got, {3: "Part 2", 4: "Part 6", 5: "Part 6", 7: "Part 8", 8: "Schedule 1 for Part 2"})

    def test_chunks_are_consecutive_runs(self):
        self.assertEqual(S.chunks({3: 0, 4: 0, 5: 0, 7: 0, 8: 0}, 2), [(3, 4), (5, 5), (7, 8)])


class Parsing(unittest.TestCase):
    def test_entries(self):
        sections = S.page_sections(TEXTS)
        grp = {}
        got = S.parse_lines(["4|H|INVESTMENT ACCOUNT #1", "4|L|1|$1,001 - $15,000|I|", "5|L|2|$15,001 - $50,000||", "6|L|1|$1,001 - $15,000||", "junk", "9|L|1|x||"], sections, 4, 5, grp)
        self.assertEqual([(x["page"], x["sec"], x["grp"], x["n"], x["v"], x["inc"]) for x in got],
                         [(4, "6", "INVESTMENT ACCOUNT #1", "1", "$1,001 - $15,000", True), (5, "6", "INVESTMENT ACCOUNT #1", "2", "$15,001 - $50,000", False)])
        # The heading carries into the next chunk.
        nxt = S.parse_lines(["7|L|1|$250,001 - $500,000||Example Bank Mortgage on personal residence"], sections, 7, 8, grp)
        self.assertEqual((nxt[0]["sec"], nxt[0]["cred"]), ("8", "Example Bank Mortgage on personal residence"))

    def test_cost(self):
        self.assertAlmostEqual(S.cost("claude-opus-5-5", 1_000_000, 100_000), 6.0)


class Comparing(unittest.TestCase):
    A = [L(3, "2", "1", "", "E"), L(4, "6", "1", "$1,001 - $15,000", "I"), L(4, "6", "2", "$15,001 - $50,000"), L(7, "8", "1", "$250,001 - $500,000", cred="Bank, Mortgage on personal residence")]

    def test_agree(self):
        got = N.compare_readings(self.A, [dict(x) for x in self.A])
        self.assertEqual((len(got["lines"]), got["disagreements"]), (4, []))

    def test_a_value_read_differently(self):
        b = [dict(x) for x in self.A]
        b[2]["v"] = "$15,001 - $50,001"
        got = N.compare_readings(self.A, b)
        self.assertEqual([d["key"] for d in got["disagreements"]], ["p4.1"])
        self.assertEqual(len(got["lines"]), 3)

    def test_unsure_never_counts(self):
        b = [dict(x) for x in self.A]
        b[1]["unsure"] = True
        self.assertEqual([d["key"] for d in N.compare_readings(self.A, b)["disagreements"]], ["p4.0"])

    def test_a_line_only_one_reading_has(self):
        got = N.compare_readings(self.A, [x for x in self.A if not (x["page"] == 4 and x["n"] == "2")])
        self.assertEqual([(d["key"], d["a"]["n"], d["b"]) for d in got["disagreements"]], [("p4.1", "2", None)])
        self.assertEqual(len(got["lines"]), 3, "the lines around it still line up")

    def test_empty_rows_one_reading_lists_are_absent(self):
        # Forms print empty numbered rows; one model lists them, the other doesn't.
        a = self.A[:1] + [L(3, "2", str(n), "") for n in range(2, 6)] + self.A[1:]
        got = N.compare_readings(a, [dict(x) for x in self.A])
        self.assertEqual(got["disagreements"], [])

    def test_flags_on_a_line_with_a_value_change_nothing(self):
        b = [dict(x) for x in self.A]
        b[1]["nra"] = True
        b[2]["elsewhere"] = True
        self.assertEqual(N.compare_readings(self.A, b)["disagreements"], [])

    def test_flags_on_a_line_without_a_value_do(self):
        a = [L(9, "6", "4", "", "E")]
        self.assertEqual(N.compare_readings(a, [L(9, "6", "4", "", "I")])["disagreements"], [], "both: not counted")
        self.assertEqual(len(N.compare_readings(a, [L(9, "6", "4", "", "N")])["disagreements"]), 1, "skipped vs open-ended")

    def test_a_trailing_period_in_the_number(self):
        b = [dict(x) for x in self.A]
        b[0]["n"] = "1."
        self.assertEqual(N.compare_readings(self.A, b)["disagreements"], [])

    def test_ranges_written_with_to(self):
        self.assertEqual(N.value_bounds(N.first_value("$1,001 to $15,000")), (1001, 15000, False))


class Storing(unittest.TestCase):
    def test_a_page_per_row_and_each_open_line(self):
        lines = [dict(L(3, "2", "1", "", "E"), idx=0), dict(L(4, "6", "1", "$1,001 - $15,000"), idx=0), dict(L(4, "6", "2", "$15,001 - $50,000"), idx=1)]
        open_dis = [{"key": "p4.2", "page": 4, "idx": 2, "a": L(4, "6", "3", "$1,001 - $15,000"), "b": None}]
        sql = S.storage_sql("oge:x", lines, open_dis)
        self.assertEqual(len(sql), 2 + 2 + 1)
        self.assertTrue(sql[0].startswith("DELETE FROM networth_scan_pages"))
        self.assertIn("VALUES ('oge:x', 4, ", sql[3])
        self.assertIn('"idx":0', sql[3], "a line's place on the page is kept, even the first")
        self.assertTrue(sql[4].endswith(", NULL);"), "a reading without the line stores NULL")
        self.assertNotIn('"inc"', sql[3], "false flags aren't stored")
        self.assertLess(max(len(x) for x in sql), 100_000)

    def test_an_empty_chunk_is_read_again_once(self):
        have = {("a", 1): {"reading": '{"lines": []}'}, ("b", 1): {"reading": '{"lines": ["1|L|1|$1|"]}'}, ("a", 7): {"reading": '{"lines": [], "retry": 1}'}, ("b", 7): {"reading": '{"lines": ["7|L|1|$1|"]}'}}
        self.assertTrue(S.empty_beside(have, ["a", "b"], "a", 1))
        self.assertFalse(S.empty_beside(have, ["a", "b"], "b", 1))
        self.assertFalse(S.empty_beside(have, ["a", "b"], "a", 7), "already read again")


class Adding(unittest.TestCase):
    def test_rules(self):
        lines = [
            L(3, "2", "1", "", "E"),                                   # see Schedule 1
            L(4, "6", "1", "$1,000,001 - $5,000,000", grp="FUND A"),   # a value covers the lines under it
            L(4, "6", "1.1", "$1,001 - $15,000", grp="FUND A"),
            L(4, "6", "2", "", grp="ACCOUNT #2"),                      # an account: its lines count
            L(4, "6", "2.1", "$15,001 - $50,000", grp="ACCOUNT #2"),
            L(5, "6", "3", "", "I"),                                    # income only
            L(5, "6", "4", "", "N"),                                    # not readily ascertainable: open
            L(8, "Schedule 1 for Part 2", "1", "Over $50,000,000"),
            L(7, "8", "1", "$250,001 - $500,000", cred="Example Bank, Mortgage on personal residence"),
            L(7, "8", "2", "$1,000,001 - $5,000,000", cred="Example Bank, Line of credit"),
        ]
        r = N.report_from_lines(lines)
        self.assertEqual([a["bounds"] for a in r["assets"]], [(1000001, 5000000, False), (15001, 50000, False), (0, None, True), (50000001, None, True)])
        s = N.summarize(r)
        self.assertEqual((s["liabilities"], s["residence_mortgages"]), (1, 1))
        self.assertEqual(s["low"], 1000001 + 15001 + 0 + 50000001 - 5000000)
        self.assertEqual(s["high_open"], 1)

    def test_a_line_with_nothing(self):
        with self.assertRaises(N.Unreadable):
            N.report_from_lines([L(4, "6", "1", "")])

    def test_a_value_that_isnt_one(self):
        with self.assertRaises(N.Unreadable):
            N.report_from_lines([L(4, "6", "1", "$1,001 - ")])

    def test_ocr_check(self):
        lines = [L(4, "6", "1", "$1,001 - $15,000"), L(5, "6", "2", "$15,001 - $50,000")]
        texts = {4: "1  EXAMPLE FUND  $1,001 - $15,000", 5: "2  EXAMPLE  $15,001 - $5O,000"}
        self.assertEqual(N.ocr_misses(lines, texts), [(5, "$15,001 - $50,000")])


if __name__ == "__main__":
    unittest.main()
