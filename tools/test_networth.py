#!/usr/bin/env python3
"""Tests for tools/networth.py: "Net worth, as reported" from annual financial
disclosure reports. The fixtures in tools/fixtures/networth/ are text layers of
filed public reports (House Clerk, Senate eFD, OGE, the judiciary), trimmed;
the expected sums were checked line by line against each report.
Standard library only.

    python3 tools/test_networth.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import networth as N  # noqa: E402
import test_scotus_trades as S  # noqa: E402  (the table layout's test report)

FIX = Path(__file__).resolve().parent / "fixtures" / "networth"


def fixture(name):
    return (FIX / name).read_text()


def summary(name):
    t = fixture(name)
    reader = {"house": N.read_house, "oge": N.read_oge, "senate": N.read_senate, "scotus": N.read_judiciary}[name.split("_")[0]]
    return N.summarize(reader(t))


class Values(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(N.value_bounds("$1,001 - $15,000"), (1001, 15000, False))
        self.assertEqual(N.value_bounds("$15,000 or less"), (0, 15000, False))
        self.assertEqual(N.value_bounds("None (or less than $1,001)"), (0, 1000, False))
        self.assertEqual(N.value_bounds("None"), (0, 0, False))

    def test_open_ended_uses_the_stated_minimum(self):
        self.assertEqual(N.value_bounds("Over $50,000,000"), (50000001, None, True))
        self.assertEqual(N.value_bounds("Spouse/DC Over $1,000,000"), (1000001, None, True))
        self.assertEqual(N.value_bounds("Over $1,000,000 (Spouse/DC Asset)"), (1000001, None, True))
        self.assertEqual(N.value_bounds("Over $1,000,000 and held independently by spouse or dependent child"), (1000001, None, True))
        self.assertEqual(N.value_bounds("Undetermined"), (0, None, True))

    def test_not_a_value(self):
        self.assertIsNone(N.value_bounds(""))
        self.assertIsNone(N.value_bounds("$15,000 - $1,001"))
        self.assertIsNone(N.value_bounds("Dividends"))

    def test_net_range(self):
        r = N.net_range([(1001, 15000, False), (1000001, None, True)], [(10001, 15000, False)])
        # Low: asset minimums minus liability maximums. High: asset maximums (an open one at its minimum) minus liability minimums.
        self.assertEqual(r["low"], 1001 + 1000001 - 15000)
        self.assertEqual(r["high"], 15000 + 1000001 - 10001)
        self.assertEqual((r["low_open"], r["high_open"]), (0, 1))

    def test_open_liability_leaves_the_low_end_open(self):
        r = N.net_range([(1001, 15000, False)], [(50000001, None, True)])
        self.assertEqual(r["low_open"], 1)

    def test_money(self):
        self.assertEqual(N.fmt_money(-315941), "-$315,941")


class Reports(unittest.TestCase):
    def check(self, name, assets, liabilities, low, high, high_open=0, residence=0):
        s = summary(name)
        self.assertEqual((s["assets"], s["liabilities"], s["residence_mortgages"]), (assets, liabilities, residence), name)
        self.assertEqual((s["low"], s["high"], s["high_open"]), (low, high, high_open), name)

    def test_house_annual(self):
        self.check("house_O_10067693_liab.txt", 42, 2, 3193041, 15155998)
        self.check("house_O_10071961_spouse.txt", 57, 2, 936057, 3124998)
        self.check("house_O_10066594_spouse.txt", 67, 0, 8880064, 25650002, high_open=1)

    def test_house_candidate(self):
        self.check("house_C_10058815.txt", 54, 0, 1419053, 3736000)

    def test_house_older_layouts(self):
        self.check("house_aderholt_2019_10037812.txt", 23, 1, 2540022, 9849999, high_open=1)
        self.check("house_peters_2021_10049820.txt", 106, 2, 36119073, 63885020, high_open=1)
        self.check("house_peters_2022_10052909.txt", 99, 2, 34906078, 68715016, high_open=1)

    def test_house_small_capital_type_codes(self):
        # 2014-2017 reports print the codes in small capitals ("[Ba]"); a value wraps below the checkbox letters.
        self.check("house_massie_2017_excerpt.txt", 3, 2, 1001 + 1000001 + 1 - 500000, 15000 + 5000000 + 1000 - 200002)

    def test_house_without_type_codes(self):
        # Through 2016: no type codes, so rows are told apart by their values; an amount runs on from the type.
        s = summary("house_aderholt_2016_17_excerpt.txt")
        self.assertEqual((s["assets"], s["liabilities"]), (5, 2))
        self.assertEqual(s["asset_min"], 15001 + 1000001 + 100001 + 1001 + 0)
        self.assertEqual(s["liab_max"], 50000 + 1000000)

    def test_liability_split_by_a_blank_line(self):
        t = fixture("house_massie_2017_excerpt.txt")
        # The rest of an amount after a blank line, and a comment line after another.
        t = t.replace("Mortgage on farm                         $100,001 -\n", "Mortgage on farm                         $100,001 -\n\n")
        t = t.replace("Mortgage on land                         $100,001 -\n                                                                                                                $250,000\n",
                      "Mortgage on land                         $100,001 -\n                                                                                                                $250,000\n\nC : Paid off in 2018\n")
        r = N.read_house(t)
        self.assertEqual([x["bounds"] for x in r["liabilities"]], [(100001, 250000, False), (100001, 250000, False)])

    def test_exact_values(self):
        self.assertEqual(N.value_bounds(N.first_value("$209,630.10")), (209630, 209631, False))
        self.assertIsNone(N.first_value("$100,001 -"))
        self.assertEqual(N.value_bounds("Over $1,000,000 (asset held independently by spouse or dependent child)"), (1000001, None, True))

    def test_personal_residence_mortgage_left_out(self):
        self.check("house_scott_2022_10062671.txt", 42, 1, 951040, 2576999, high_open=1, residence=1)

    def test_oge(self):
        self.check("oge_bessent.txt", 58, 1, 203329048, 446070002, high_open=1, residence=1)
        self.check("oge_hegseth.txt", 17, 0, 3181015, 5717001, high_open=1, residence=2)

    def test_oge_scan_is_not_read(self):
        with self.assertRaisesRegex(N.Unreadable, "scanned"):
            N.read_oge(fixture("oge_trump.txt"))

    def test_senate(self):
        self.check("senate_annual_1_c6b1e74d.html.txt", 63, 5, -315941, 3538995)
        self.check("senate_annual_1_4a2553f2.html.txt", 42, 1, 331041, 2189999, high_open=1)

    def test_judiciary(self):
        self.check("scotus_2025.txt", 55, 1, 13965036, 50979999)

    def test_a_missing_value_makes_the_report_unreadable(self):
        t = fixture("house_O_10067693_liab.txt")
        lines = t.split("\n")
        i = next(k for k, l in enumerate(lines) if "$" in l and N.H_TYPE_CODE.search(l))
        lines[i] = lines[i].replace("$", "#")
        with self.assertRaises(N.Unreadable):
            N.read_house("\n".join(lines))


# OGE: a fund with a value, its holdings listed under it without values; an
# account without a value, its holdings with values; an income-only line.
OGE_PART6 = "\n".join([
    "6. Other Assets and Income",
    "",
    "#      DESCRIPTION                                     EIF           VALUE              INCOME TYPE   INCOME",
    "                                                                                                      AMOUNT",
    "",
    "1      Example Fund LP - real estate portfolio         No            $250,001 -                       None (or less",
    "                                                                    $500,000                         than $201)",
    "",
    "1.1    commercial real estate, Example City            N/A",
    "",
    "1.2    commercial real estate, Example Town            N/A",
    "",
    "2      Brokerage Account #1                            No",
    "",
    "2.1    Example Index Fund (EXIDX)                      Yes           $15,001 -          Dividends     $201 - $1,000",
    "                                                                    $50,000",
    "",
    "3      Example consulting fees                         N/A                              Fees          $12,000",
    "",
    "8. Liabilities",
    "",
    "None",
])


def table_report(liability_code="O"):
    """A justice's report in the table layout (through 2024), with Part VI first."""
    vi = "\n".join([
        "VI. LIABILITIES. (Includes those of spouse and dependent children.)",
        "         NONE (No reportable liabilities.)",
        "                CREDITOR                                                       DESCRIPTION                                                  VALUE CODE",
        "",
        "1.   Example Bank, N.A.                         Priority Credit Line                                                                             " + liability_code,
        "",
        "2.",
        "",
    ])
    return vi + "\n" + S.TABLE


class OgeLines(unittest.TestCase):
    def test_a_value_counts_once_and_lines_without_values_are_inside_or_income(self):
        got = N.oge_assets(N._oge_sections(OGE_PART6))
        self.assertEqual([(a["n"], a["bounds"]) for a in got], [("1", (250001, 500000, False)), ("2.1", (15001, 50000, False))])

    def test_a_line_with_nothing_makes_the_report_unreadable(self):
        broken = OGE_PART6.replace("3      Example consulting fees                         N/A                              Fees          $12,000",
                                   "3      Example consulting fees                         N/A")
        with self.assertRaises(N.Unreadable):
            N.oge_assets(N._oge_sections(broken))


class JudiciaryTable(unittest.TestCase):
    def test_value_codes(self):
        r = N.read_judiciary(table_report())
        # The account (line 1) holds line 2; line 3 is another transaction of line 2; line 7 is empty.
        self.assertEqual([(a["n"], a["value"]) for a in r["assets"]], [("2", "P1"), ("4", "K"), ("5", "J"), ("6", "L")])
        self.assertEqual([(x["name"], x["bounds"]) for x in r["liabilities"]], [("Example Bank, N.A. Priority Credit Line", (500001, 1000000, False))])
        s = N.summarize(r)
        self.assertEqual((s["low"], s["high"]), (1000001 + 15001 + 0 + 50001 - 1000000, 5000000 + 50000 + 15000 + 100000 - 500001))

    def test_an_open_code(self):
        s = N.summarize(N.read_judiciary(table_report().replace(S.row(2, "- Example Index Fund (EXIDX)", "E", "Dividend", "P1", "T", "Buy", "02/15/24", "K"),
                                                              S.row(2, "- Example Index Fund (EXIDX)", "E", "Dividend", "P4", "T", "Buy", "02/15/24", "K"))))
        self.assertEqual(s["high_open"], 1)

    def test_a_liability_without_a_code_is_unreadable(self):
        with self.assertRaises(N.Unreadable):
            N.read_judiciary(table_report(liability_code=""))


# The list layout (2025 on): a value range that starts above its row's number and ends below it.
LIST_SPLIT = "\n".join([
    "VI. Liabilities", "", "I do not have any Liabilities to report", "No entries in this section", "", "",
    "VII. Investments and Trusts", "",
    "       DESCRIPTION                                       INCOME AMOUNT           INCOME TYPE GROSS VALUE              VALUE METHOD",
    "       Example Federal Credit Union (Cash",
    "1.                                                       $1,000 or less          Interest        $50,001 - $100,000   Cash/Market",
    "       Accounts)", "", "",
    "                                                                                                 $1,000,001 -",
    "2.     Example Holdings, LLC, Example County             $50,001 - $100,000      Rent                                 Estimated",
    "                                                                                                 $5,000,000", "", "",
    "3.     Example Treasury Bill                             $1,001 - $2,500         Interest", "", "",
    "VIII. Additional Information or Explanations", "",
])


class JudiciaryList(unittest.TestCase):
    def test_a_range_split_around_its_row(self):
        r = N.read_judiciary(LIST_SPLIT)
        # Line 3 has income but no value at the year's end: not held then, counted as zero.
        self.assertEqual([(a["n"], a["bounds"]) for a in r["assets"]], [("1", (50001, 100000, False)), ("2", (1000001, 5000000, False)), ("3", (0, 0, False))])
        self.assertEqual(r["liabilities"], [])


class OgeReportedElsewhere(unittest.TestCase):
    def test_a_line_reported_at_another_line(self):
        text = OGE_PART6.replace(
            "3      Example consulting fees                         N/A                              Fees          $12,000",
            "3      Family Trust #1 - 3.2% interest in Example      No\n       Holdco LLC - value and income\n       reported at Line 1")
        got = N.oge_assets(N._oge_sections(text))
        self.assertEqual([a["n"] for a in got], ["1", "2.1"])


if __name__ == "__main__":
    unittest.main()
