#!/usr/bin/env python3
"""Tests for tools/scotus_trades.py: the justices' purchases and sales from Part VII
of the annual reports, in both layouts. Every name here is invented; the column
positions are the filed reports'. Standard library only.

    python3 tools/test_scotus_trades.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scotus_trades as S  # noqa: E402

# The table layout's heading, repeated at the top of every page of Part VII (2023-2024 reports).
HEADER = 'VII. INVESTMENTS and TRUSTS -- income, value, transactions (Includes those of spouse and dependent children; see Guide to Judiciary Policy, Volume\n2D, Ch. 3, § 310 Reporting Thresholds for Assets; § 312 Types of Reportable Property; § 315 Interests in Property; § 320 Income; § 325 Purchases, Sales, and Exchanges; § 360 Spouses\n\nand Dependent Children; § 365 Trusts, Estates, and Investment Funds.)\n\n            NONE (No reportable income, assets, or transactions.)\n                              A.                                              B.                           C.                                                    D.\n                     Description of Assets                              Income during              Gross value at end                           Transactions during reporting period\n                    (including trust assets)                           reporting period            of reporting period\n                                                                  (1)            (2)               (1)           (2)             (1)             (2)      (3)             (4)\n                  Place "(X)" after each asset                  Amount        Type (e.g.,        Value         Value          Type (e.g.,       Date    Value            Gain\n                 exempt from prior disclosure                   Code 1        div., rent,        Code 2        Method          buy, sell,      mm/dd/yy Code 2          Code 1\n                                                                 (A-H)         or int.)           (J-P)        Code 3        redemption)                 (J-P)          (A-H)\n                                                                                                               (Q-W)'


def row(n, desc, inc="", typ="", gv="", gm="", tt="", td="", tv="", tg=""):
    """One line of the table layout, each column where the filed reports put it."""
    line = (f" {n}." if n else "").ljust(10) + desc
    for col, v in ((63, inc), (74, typ), (96, gv), (110, gm), (126, tt), (140, td), (154, tv), (168, tg)):
        if v:
            line = line.ljust(col) + v
    return line


TABLE = "\n".join([
    "VI. GIFTS", "", HEADER, "",
    row(1, "Brokerage Acct #1 (H)"), "", "",
    row(2, "- Example Index Fund (EXIDX)", "E", "Dividend", "P1", "T", "Buy", "02/15/24", "K"), "", "",
    row(3, "", tt="Buy", td="08/21/24", tv="J"),
    row(None, "", tt="(add'l)"),
    row(4, "Example State 529 Plan (Age", "", "None", "K", "T", "Sold", "01/10/24", "K", "F"),
    row(None, "Based)", tt="(part)"),
    row(5, "Example Bank account", "A", "Interest", "J", "T"), "",
    "  1. Income Gain Codes:                A =$1,000 or less",
    "  2. Value Codes                       J =$15,000 or less                   K =$15,001 - $50,000",
    "                                       P3 =$25,000,001 - $50,000,000                                             P4 =More than $50,000,000",
    " FINANCIAL DISCLOSURE REPORT",
    " Page 6 of 9                                                                              Example, Ann B.                                                                             05/15/2025",
    "", HEADER, "",
    row(6, "- Example Treasury Note CPN 1.5% DUE", "A", "Interest", "L", "T", "Redeemed", "11/26/24", "M"),
    row(None, "9/30/24"),
    row(7, ""),
    "", "VIII. ADDITIONAL INFORMATION OR EXPLANATIONS. (Indicate part of report.)", "  Part VII line 4: a note.",
])

# The list layout (2025 reports on).
LIST = "VII. Investments and Trusts\n\n      DESCRIPTION                                          INCOME AMOUNT INCOME TYPE GROSS VALUE               VALUE METHOD\n1. EXAMPLE CREDIT UNION CASH ACCOUNT $1,000 or less                   Interest   $50,001 - $100,000    Cash/Market\n\n\n2. EXAMPLE TOTAL STOCK MKT INDEX ADM                      $5,001 - $15,000   Dividend   $500,001 - $1,000,000 Cash/Market\n      Transactions Transaction Type Transaction Date Transaction Value\n      (1).           Sold (part)          Aug 8, 2025   $15,000 or less\n\n\n        (H) Example Holdings, Inc.\n3.\n        (IRA) (H)\n3-A. EXAMPLE GOLD TR SHS                                           $1,000 or less         Dividend,Gain $15,001 - $50,000                 Cash/Market\n         Transactions Transaction Type Transaction Date Transaction Value\n         (1).               Buy                      Jan 7, 2025           $15,001 - $50,000\n\n        -- Example Target Ret. 2020 Trust Select\n3-B.                                                $5,001 - $15,000          Dividend      $250,001 - $500,000       Cash/Market\n        EXTRX\nAdditional Explanation: The fund changed its name in 2025.\n                                                                                                                         Page 3/4\n\x0c\n         Transactions Transaction Type Transaction Date Transaction Value\n         (1).           Buy (add'l)         Jan 17, 2025      $15,001 - $50,000\n         (2).           Donated (part)\n\nVIII. Additional Information or Explanations\n"


class TableLayout(unittest.TestCase):
    def test_rows_as_filed(self):
        rows = S.read_report(TABLE)
        self.assertEqual([(r["asset"], r["account"], r["type"], r["date"], r["amount"]) for r in rows], [
            ("Example Index Fund (EXIDX)", "Brokerage Acct #1 (H)", "Buy", "2024-02-15", "$15,001 - $50,000"),
            # A row with no description is another transaction of the asset above; "(add'l)" wraps onto the next line.
            ("Example Index Fund (EXIDX)", "Brokerage Acct #1 (H)", "Buy (add'l)", "2024-08-21", "$15,000 or less"),
            # The description and the type wrap on the same line.
            ("Example State 529 Plan (Age Based)", None, "Sold (part)", "2024-01-10", "$15,001 - $50,000"),
            # The page's codes legend and the next page's heading aren't part of any description;
            # a holding after a plain account (one with values) isn't inside it.
            ("Example Treasury Note CPN 1.5% DUE 9/30/24", None, "Redeemed", "2024-11-26", "$100,001 - $250,000"),
        ])

    def test_a_transaction_not_accounted_for_makes_the_report_a_link(self):
        broken = TABLE.replace(row(None, "9/30/24"), row(None, "9/30/24", tt="Sold", td="12/01/24", tv="J"))
        with self.assertRaises(S.Unreadable):
            S.read_report(broken)

    def test_an_unknown_type_makes_the_report_a_link(self):
        with self.assertRaises(S.Unreadable):
            S.read_report(TABLE.replace("Redeemed", "Bagpen  "))


class ListLayout(unittest.TestCase):
    def test_rows_as_filed(self):
        rows = S.read_report(LIST)
        self.assertEqual([(r["asset"], r["account"], r["type"], r["date"], r["amount"]) for r in rows], [
            ("EXAMPLE TOTAL STOCK MKT INDEX ADM", None, "Sold (part)", "2025-08-08", "$15,000 or less"),
            # An account's name wraps above and below its number; its holdings are numbered 3-A, 3-B.
            ("EXAMPLE GOLD TR SHS", "(H) Example Holdings, Inc. (IRA) (H)", "Buy", "2025-01-07", "$15,001 - $50,000"),
            # A holding's description starts with "--" between two items, wraps below, and the filer's
            # Additional Explanation isn't part of it; its transactions continue after a page break.
            ("Example Target Ret. 2020 Trust Select EXTRX", "(H) Example Holdings, Inc. (IRA) (H)", "Buy (add'l)", "2025-01-17", "$15,001 - $50,000"),
            # Filed with no date or value: kept as filed.
            ("Example Target Ret. 2020 Trust Select EXTRX", "(H) Example Holdings, Inc. (IRA) (H)", "Donated (part)", None, None),
        ])

    def test_an_unreadable_column_makes_the_report_a_link(self):
        with self.assertRaises(S.Unreadable):
            S.read_report(LIST.replace("Aug 8, 2025", "Aug 8 2O25"))


class Filer(unittest.TestCase):
    def test_names(self):
        self.assertEqual(S.filer_name("Filer's Information\nExample Jr., Ann B.\nU.S. Supreme Court"), "Example Jr., Ann B.")
        self.assertEqual(S.filer_name(TABLE), "Example, Ann B.")


if __name__ == "__main__":
    unittest.main()
