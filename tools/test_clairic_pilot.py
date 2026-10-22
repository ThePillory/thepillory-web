#!/usr/bin/env python3
"""Tests for tools/clairic_pilot.py: the fields asked for, reading Clairic's
answers into rows, comparing them with the record field by field, and the
summary. No network and no model: the answers are written by hand in the
documented response shape. Every name is invented. Standard library only.

    python3 tools/test_clairic_pilot.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clairic_pilot as P  # noqa: E402


def ans(value, conf=0.999, span=None):
    return {"type": "text", "value": value, "confidence": conf, "p_null": 0.0 if value is not None else 1.0, **({"span": span} if span else {})}


class Fields(unittest.TestCase):
    def test_numbered_typed_fields(self):
        f = P.fields_for("house", rows=2)
        self.assertEqual(f["rows"]["type"], "number")
        self.assertEqual(f["r01.date"]["type"], "date")
        self.assertEqual(f["r02.amount"]["type"], "text")
        self.assertIn("Row 2 of the transactions", f["r02.asset"]["instructions"])
        self.assertEqual(len(f), 1 + 2 * 5)
        for name in P.fields_for("annual"):
            self.assertRegex(name, r"^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$")  # Clairic's field-name rule


class Rows(unittest.TestCase):
    def test_rows_in_order_and_spans_checked(self):
        state = "EXAMPLE CORP COMMON  P  01/02/2026  $1,001 - $15,000"
        answers = {
            "r01.asset": ans("EXAMPLE CORP COMMON", span=[0, 19]), "r01.type": ans("P", span=[21, 22]),
            "r01.date": {"type": "date", "value": "2026-01-02", "confidence": 0.98},
            "r01.amount": ans("$1,001 - $15,000", span=[36, 52]), "r01.owner": ans(None),
            "r02.asset": ans(None), "r02.amount": ans("$15,001 - $50,000", conf=0.4),
        }
        rows = P.rows_from_answers("house", answers, state)
        self.assertEqual(len(rows), 1, "a row with no asset isn't a row")
        self.assertTrue(rows[0]["asset"]["grounded"])
        self.assertTrue(rows[0]["amount"]["grounded"])
        self.assertIsNone(rows[0]["date"]["grounded"], "a date is computed, not a span")
        bad = P.rows_from_answers("house", {"r01.asset": ans("EXAMPLE CORP", span=[0, 19])}, state)
        self.assertFalse(bad[0]["asset"]["grounded"], "a span that points at other text")


class Compare(unittest.TestCase):
    def test_fields_by_the_parsers_rules(self):
        self.assertEqual(P.same_field("house", "type", "S (partial)", "Partial sale"), "exact")
        self.assertEqual(P.same_field("house", "type", "P", "Sale"), "wrong")
        self.assertEqual(P.same_field("house", "owner", "SP", "Spouse"), "exact")
        self.assertEqual(P.same_field("house", "amount", "$1,001-$15,000", "$1,001 - $15,000"), "exact")
        self.assertEqual(P.same_field("house", "amount", "$1,001 - $15,000", "$15,001 - $50,000"), "wrong")
        self.assertEqual(P.same_field("annual", "value", "Over $50,000,000", "Over $50,000,000"), "exact")
        self.assertEqual(P.same_field("annual", "value", "Undetermined", "$1,001 - $15,000"), "wrong")
        self.assertEqual(P.same_field("house", "asset", "Example Holdings Inc.", "EXAMPLE HOLDINGS INC"), "exact")
        self.assertEqual(P.same_field("house", "asset", "Example Holding Inc", "EXAMPLE HOLDINGS INC"), "close")
        self.assertEqual(P.same_field("agenda", "number", "9.", "9"), "exact")
        self.assertEqual(P.same_field("house", "date", None, "2026-01-02"), "wrong")

    def test_found_missed_invented(self):
        want = [
            {"date": "2026-01-02", "type": "Purchase", "amount": "$1,001 - $15,000", "asset": "EXAMPLE ONE", "owner": "Self"},
            {"date": "2026-01-03", "type": "Sale", "amount": "$15,001 - $50,000", "asset": "EXAMPLE TWO", "owner": None},
            {"date": "2026-01-04", "type": "Sale", "amount": "$1,001 - $15,000", "asset": "EXAMPLE THREE", "owner": "Spouse"},
        ]
        row = lambda **kv: {k: {"value": v, "confidence": 0.999, "grounded": None} for k, v in kv.items()}  # noqa: E731
        got = [
            row(date="2026-01-02", type="P", amount="$1,001 - $15,000", asset="Example One", owner="Self"),
            row(date="2026-01-03", type="S", amount="$1,001 - $15,000", asset="EXAMPLE TWO", owner="JT"),
            row(date="2026-02-02", type="P", amount="$1,001 - $15,000", asset="NOT ON THE REPORT", owner=None),
        ]
        c = P.compare("house", got, want)
        self.assertEqual((c["found"], c["missed"], c["invented"]), (2, 1, 1))
        wrong = [f for f in c["fields"] if f["result"] == "wrong"]
        self.assertEqual([f["field"] for f in wrong], ["amount"], "the second row's amount; its owner isn't on record, so not compared")
        s = P.summarize([{"kind": "house", "mode": "clairic-image", "pages": 1, "dollars": 0.001, "seconds": 0.5, "compare": c}])
        k = s[("house", "clairic-image")]
        self.assertEqual(k["fields"]["amount"], [1, 0, 1])
        self.assertEqual(len(k["high_conf_wrong"]), 1, "a wrong value at confidence ≥ 0.99 is listed")
        md = P.report(s)
        self.assertIn("1 missed", md)
        self.assertIn("| amount | 1 | 0 | 1 | 50.0% |", md)


if __name__ == "__main__":
    unittest.main()
