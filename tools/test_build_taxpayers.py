#!/usr/bin/env python3
"""Tests for tools/build_taxpayers.py. Every number here is FAKE, laid out like the IRS's and the FTB's tables."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_taxpayers as T  # noqa: E402


class Irs(unittest.TestCase):
    def test_newest_edition_of_each_table(self):
        page = '<a href="/pub/irs-soi/22in41ts.xlsx">x</a><a href="/pub/irs-soi/23in41ts.xls">x</a><a href="/pub/irs-soi/23in41ts.xlsx">x</a><a href="/pub/irs-soi/23in42ts.xls">x</a>'
        self.assertEqual(T.newest_tables(page), {"41": "https://www.irs.gov/pub/irs-soi/23in41ts.xlsx", "42": "https://www.irs.gov/pub/irs-soi/23in42ts.xls"})

    def test_blocks_by_their_labels_and_years(self):
        groups = ["bottom-50", "bottom-75"]
        rows = [
            ("Table 4.2. All Individual Returns", None),
            ("Item, tax year", "Total", "Ascending"),
            (1.0, 2.0, 3.0, 4.0),
            ("Number of returns:", None),
            (2022.0, 100.0, 50.0, 75.0),
            (2023.0, 110.0, 55.0, 82.0),
            ("Average tax rate (percentage):  [2]", None),
            (2023.0, 14.1, 3.7, 6.1),
            ("Adjusted gross income share (percentage):", None),
            (2023.0, 100.0, 12.3, 31.5),
            ("Total income tax share (percentage) [1]:", None),
            (2023.0, 100.0, 3.3, 13.7),
        ]
        b = T.irs_blocks(rows, groups)
        self.assertEqual(sorted(b), ["agi_share", "returns", "tax_share"])  # the average rate isn't kept
        g = T.irs_groups(b, groups, T.group_labels())
        self.assertEqual(g[0], {"id": "bottom-50", "label": "Bottom 50 percent", "returns": {"2022": 50.0, "2023": 55.0}, "floor": {}, "agi_share": {"2023": 12.3}, "tax_share": {"2023": 3.3}})


TOP400 = """Table 1—Selected Items for the Top 400 Individual Income Tax Returns
[Money amounts are in thousands of dollars]
1992                                  113,604,503               24,421                  22,760
2007 [7]                              142,978,806              138,815                  87,525
2014 [8]                              148,606,578              126,833                  70,035
                                                                         Adjusted gross income
1992                                   18,716,032            46,790                17,442,714       3,629,129,550            0.52
2007                                  137,903,411           344,759                86,950,449       8,687,718,769            1.59
                                                                   Salaries and wages
2014                                   9,999,999            99,999                 9,999,999       9,999,999,999            9.99
"""


class Top400(unittest.TestCase):
    def test_a_year_is_kept_only_when_both_blocks_read(self):
        rows = T.top400_rows(TOP400)
        self.assertEqual([r["year"] for r in rows], [1992, 2007])  # 2014's second block is past "Salaries and wages"
        self.assertEqual(rows[1], {"year": 2007, "returns_all": 142978806, "cutoff": 138815000.0, "agi_total": 137903411000.0, "agi_average": 344759000.0, "agi_share": 1.59})


class Ftb(unittest.TestCase):
    def test_classes_add_up_into_bands_for_the_latest_year(self):
        row = lambda y, agic, ret, agi, tax: {"Taxable Year": str(y), "AGIC": agic, "All Returns": ret, "California AGI": agi, "Total Tax Liability": tax}
        rows = [
            row(2021, "Negative", "5", "-10", "0"),
            row(2022, "Negative", "10", "-100", "1"),
            row(2022, "Zero", "2", "0", "0"),
            row(2022, "40,000  to  49,999", "1,000", "45,000,000", "600,000"),
            row(2022, "100,000  to  149,999", "300", "37,000,000", "1,500,000"),
            row(2022, "10,000,000  and  over", "3", "90,000,000", "8,000,000"),
        ]
        f = T.ftb_bands(rows)
        self.assertEqual((f["year"], f["classes"], f["years"]), (2022, 5, [2021, 2022]))
        first, *_, last = f["bands"]
        self.assertEqual((first["label"], first["returns"], first["tax"]), ("Under $50,000", 1012, 600001.0))
        self.assertEqual((last["label"], last["returns"], last["tax"]), ("$5 million and over", 3, 8000000.0))
        self.assertEqual(f["total"]["returns"], 1315)

    def test_an_unreadable_class_stops_rather_than_guessing(self):
        with self.assertRaises(ValueError):
            T.ftb_bands([{"Taxable Year": "2022", "AGIC": "Other", "All Returns": "1", "California AGI": "1", "Total Tax Liability": "1"}])


if __name__ == "__main__":
    unittest.main()
