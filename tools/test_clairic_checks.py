#!/usr/bin/env python3
"""Tests for tools/test_clairic.py: the fields asked for, reading answers into
rows, comparing them with the record field by field, the comment span check,
notification dates from the text layer, prices around December 1, and the
report. No network and no model: answers are written by hand in the response
shape the Clairic pilot saw. Every name is invented. Standard library only.

    python3 tools/test_clairic_checks.py
"""
import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_clairic as C  # noqa: E402


def a(value, conf=0.99, span=None):
    return {"value": value, "confidence": conf, **({"span": span} if span else {})}


WANT = [
    {"n": 1, "asset": "Example Corp Common Stock", "ticker": "EXC", "type": "Purchase", "date": "2026-03-02", "notified": "2026-03-10", "amount": "$1,001 - $15,000", "owner": "Spouse"},
    {"n": 2, "asset": "Sample Municipal Bond", "ticker": None, "type": "Sale", "date": "2026-03-04", "notified": "2026-03-10", "amount": "$15,001 - $50,000", "owner": "Self"},
]


class Fields(unittest.TestCase):
    def test_numbered_fields(self):
        f = C.row_fields("trades", 2)
        self.assertEqual(len(f), 1 + 2 * 7)
        self.assertEqual(f["r02.notified"]["type"], "date")
        self.assertIn("ticker", f["r01.ticker"]["instructions"])
        for name in f:
            self.assertRegex(name, r"^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$")

    def test_body_sends_pages_and_their_text(self):
        b = C.body(C.COMMENT_FIELD, [b"png1", b"png2"], "page text")
        self.assertEqual(b["state"], "page text")
        self.assertEqual(len(b["images"]), 2)
        self.assertTrue(b["options"]["return_state_text"])


class Compare(unittest.TestCase):
    def test_trades_field_by_field(self):
        answers = {
            "r01.asset": a("Example Corp Common Stock (EXC) [ST]"), "r01.ticker": a("(EXC)"), "r01.type": a("P"), "r01.date": a("2026-03-02"),
            "r01.notified": a("2026-03-11"), "r01.amount": a("$1,001 - $15,000"), "r01.owner": a("SP"),
            "r02.asset": a("Sample Municipal Bond"), "r02.ticker": a(None), "r02.type": a("S"), "r02.date": a(None, 0.4),
            "r02.notified": a("2026-03-10"), "r02.amount": a("$15,001 - $50,000"), "r02.owner": a(None),
            "r03.asset": a("Invented Holding"),
        }
        got = C.rows_from("trades", answers, 3, None)
        c = C.compare_rows("trades", got, WANT)
        self.assertEqual((c["truth"], c["found"], c["missed"], c["invented"]), (2, 2, 0, 1))
        res = {(f["field"], f["want"]): f["result"] for f in c["fields"]}
        self.assertEqual(res[("ticker", "EXC")], "exact")
        self.assertEqual(res[("ticker", None)], "exact")  # no ticker on record, none given
        self.assertEqual(res[("type", "Purchase")], "exact")
        self.assertEqual(res[("notified", "2026-03-10")], "exact")
        self.assertEqual(res[("date", "2026-03-04")], "null")
        self.assertEqual(res[("owner", "Self")], "exact")  # a blank owner is Self, as the form says
        self.assertEqual(res[("owner", "Spouse")], "exact")
        wrong = [f for f in c["fields"] if f["field"] == "notified" and f["want"] == "2026-03-10" and f["got"] == "2026-03-11"]
        self.assertEqual(wrong[0]["result"], "wrong")

    def test_networth_lines(self):
        got = C.rows_from("networth", {"r01.name": a("Example Fund"), "r01.value": a("$15,001 - $50,000"), "r02.name": a("Mortgage, Example Bank"), "r02.value": a("$100,001 - $250,000")}, 2, None)
        c = C.compare_rows("networth", got, [{"name": "Example Fund", "value": "$15,001 - $50,000"}, {"name": "Mortgage, Example Bank", "value": "$250,001 - $500,000"}])
        self.assertEqual([f["result"] for f in c["fields"]], ["exact", "exact", "exact", "wrong"])

    def test_comment_must_be_a_span(self):
        text = "Public comment: Members of the public may address the Board on any item.  Written comments may be emailed."
        want = "Members of the public may address the Board on any item. Written comments may be emailed."
        start = text.index("Members")
        ok = C.answer(a(text[start:], span=[start, len(text)]), text)
        self.assertEqual(C.compare_comment(ok, want)["fields"][0]["result"], "exact")
        part = C.answer(a("Written comments may be emailed.", span=[text.index("Written"), len(text)]), text)
        self.assertEqual(C.compare_comment(part, want)["fields"][0]["result"], "part")
        unspanned = C.answer(a("Members of the public may speak."), text)
        self.assertEqual(C.compare_comment(unspanned, want)["fields"][0]["result"], "not a span")
        bad_span = C.answer(a("Members of the public", span=[0, 5]), text)
        self.assertEqual(C.compare_comment(bad_span, want)["fields"][0]["result"], "not a span")
        self.assertEqual(C.compare_comment(C.answer(a(None), text), want)["fields"][0]["result"], "null")
        self.assertEqual(C.compare_comment(C.answer(a(None), text), None)["fields"][0]["result"], "exact")

    def test_notification_dates_from_the_text_layer(self):
        text = "SP Example Corp Common Stock (EXC) [ST] P 03/02/2026 03/10/2026 $1,001 - $15,000\n   F S: New\nSample Municipal Bond S 03/04/2026 03/10/2026 $15,001 - $50,000\n"
        self.assertEqual(C.notification_dates(text), ["2026-03-10", "2026-03-10"])


class Report(unittest.TestCase):
    def test_prices_around_december_1(self):
        self.assertEqual(C.price_per_m(datetime.date(2026, 11, 30)), 0.10)
        self.assertEqual(C.price_per_m(datetime.date(2026, 12, 1)), 0.24)

    def test_summary_and_report(self):
        got = C.rows_from("networth", {"r01.name": a("Example Fund", 0.999), "r01.value": a("$1,001 - $15,000", 0.7)}, 1, None)
        c = C.compare_rows("networth", got, [{"name": "Example Fund", "value": "$15,001 - $50,000"}, {"name": "Other Fund", "value": "None (or less than $1,001)"}])
        s = C.summarize([{"pages": 2, "calls": 1, "tokens": 1_000_000, "seconds": 1.5, "compare": c}])
        self.assertEqual((s["missed"], s["invented"]), (1, 0))
        md = C.report("networth", s, "ai_usage step `x`: 1 call, $0.01.", day=datetime.date(2026, 12, 2))
        self.assertIn("| name | 1 | 0 | 0 | 100.0% |", md)
        self.assertIn("| value | 0 | 1 | 0 | 0.0% |", md)
        self.assertIn("$0.1000 at $0.10 a million", md)
        self.assertIn("$0.2400 at $0.24 a million", md)
        self.assertIn("this run at $0.24", md)
        self.assertIn("Confidence of wrong answers: 1 answers · mean 0.700", md)
        self.assertIn("Current Claude cost for this task", md)

    def test_no_permission_message_is_one_line_and_names_the_permission(self):
        self.assertNotIn("\n", C.NO_PERMISSION)
        self.assertIn('"Workers AI: Read"', C.NO_PERMISSION)


if __name__ == "__main__":
    unittest.main()
