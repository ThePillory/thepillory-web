#!/usr/bin/env python3
"""Tests for tools/form700.py's date and label reading (the PDF reading itself was checked
against filed statements; see docs/trades.md). Standard library only.

    python3 tools/test_form700.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import form700 as F  # noqa: E402


class Dates(unittest.TestCase):
    def test_blank_month_and_day_is_no_date(self):
        # The form prints the year; the filer's year field alone isn't a date.
        self.assertIsNone(F._date([[], [], ["25"]], 2025))

    def test_whole_dates(self):
        self.assertEqual(F._date([["10"], ["21"], ["25"]], 2025), "2025-10-21")
        self.assertEqual(F._date([["09"], ["04"], ["2025"]], 2025), "2025-09-04")

    def test_partial_or_impossible_dates_make_the_statement_a_link(self):
        with self.assertRaises(F.Unreadable):
            F._date([["10"], [], ["25"]], 2025)
        with self.assertRaises(F.Unreadable):
            F._date([["13"], ["40"], ["25"]], 2025)


class Labels(unittest.TestCase):
    def test_the_printed_words_right_of_a_box(self):
        words = [
            {"text": "$2,000", "top": 179, "x0": 63, "fontname": "EESERI+ArialMT"},
            {"text": "-", "top": 179, "x0": 87, "fontname": "EESERI+ArialMT"},
            {"text": "$10,000", "top": 179, "x0": 93, "fontname": "EESERI+ArialMT"},
            {"text": "$10,001", "top": 179, "x0": 171, "fontname": "EESERI+ArialMT"},
            {"text": "Example", "top": 179, "x0": 70, "fontname": "Helvetica"},
        ]
        self.assertEqual(F._label(words, (51.4, 177.7, 59.8, 186.1), 159.4), "$2,000 - $10,000")


if __name__ == "__main__":
    unittest.main()
