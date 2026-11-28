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


class Fixes(unittest.TestCase):
    """What the first runs showed (Nov 28): a type code counted as a wrong asset, slots sized for the page."""

    def test_asset_without_its_type_code_is_the_same_asset(self):
        self.assertEqual(C.same("trades", "asset", "ConocoPhillips (COP) [ST]", "ConocoPhillips (COP)"), "exact")
        self.assertEqual(C.same("trades", "asset", "Example Labs, Inc. Class A\n(EXL) [ST]", "Example Labs, Inc. Class A (EXL)"), "exact")
        self.assertEqual(C.same("trades", "asset", "Other Corp (OTH) [ST]", "Example Corp (EXC)"), "wrong")
        got = C.rows_from("trades", {"r01.asset": a("Example Corp Common Stock (EXC) [ST]")}, 1, None)
        self.assertEqual(C.compare_rows("trades", got, WANT[:1])["found"], 1)

    def test_slots_from_the_pages_own_text(self):
        trades = "SP Example Corp (EXC) [ST] P 03/02/2026 03/10/2026 $1,001 - $15,000\nSample Bond S 03/04/2026 03/10/2026 $15,001 - $50,000\n"
        self.assertEqual(C.slots_for("trades", trades), 5)
        self.assertEqual(C.slots_for("trades", "I CERTIFY that the statements are true."), 0)
        page = "Example Fund   $1,001 - $15,000\nSample Account   None (or less than $1,001)\nAnother   Over $50,000,000\nHeading only\n"
        self.assertEqual(C.slots_for("networth", page), 6)
        self.assertEqual(C.slots_for("networth", "\n".join(["X $1,001 - $15,000"] * 80)), C.MAX_SLOTS)

    def test_networth_one_page_a_call_and_pages_without_rows_skipped(self):
        import types
        calls = []

        def fake(account, token, payload):
            calls.append(len(payload["images"]))
            return {"answers": {}, "usage": {"input_tokens": 10}}, 0.1
        real, C.call = C.call, fake
        try:
            args = types.SimpleNamespace(task="networth")
            r = C.read_doc(args, "a", "t", {"id": "x", "want": []}, [(b"p", "Cover page"), (b"p", "Fund $1,001 - $15,000"), (b"p", "Loan $15,001 - $50,000")])
        finally:
            C.call = real
        self.assertEqual(calls, [1, 1])
        self.assertEqual(r["skipped_pages"], 1)


class Scanned(unittest.TestCase):
    """Clairic as the second reading of a scanned 278-T: rows paired by printed number, the four cells."""

    def test_compare_with_published_rows_and_the_first_reading(self):
        got = C.rows_from("scanned", {
            "r01.n": a("1"), "r01.asset": a("Example Fund See Endnote"), "r01.type": a("Purchase"), "r01.date": a("7/22/2026"), "r01.amount": a("$1,001 - $15,000"),
            "r02.n": a("2"), "r02.asset": a("Sample Corp"), "r02.type": a("Sale"), "r02.date": a("7/23/2026"), "r02.amount": a("$15,001 - $50,000"),
            "r03.n": a("9"), "r03.asset": a("Not On The Form"), "r03.type": a("Sale"), "r03.date": a("7/24/2026"), "r03.amount": a("$1,001 - $15,000"),
        }, 3, None)
        published = [{"n": 1, "asset": "Example Fund", "type": "Purchase", "date": "2026-07-22", "amount": "$1,001 - $15,000"}]
        first = [{"n": 1, "description": "Example Fund", "type": "Purchase", "date": "7/22/2026", "amount": "$1,001 - $15,000"},
                 {"n": 2, "description": "Sample Corp", "type": "Sale", "date": "7/24/2026", "amount": "$15,001 - $50,000"}]
        first = [{**r, "asset": r["description"]} for r in first]
        c = C.compare_scanned(got, published, first)
        self.assertEqual((c["truth"], c["found"], c["missed"], c["invented"]), (1, 1, 0, 1))
        self.assertEqual([f["result"] for f in c["fields"]], ["exact"] * 4)  # the endnote marker isn't part of the asset
        self.assertEqual((c["first_rows"], c["agree_first"], c["published_in_first"], c["agree_published"]), (2, 1, 1, 1))  # row 2: dates differ

    def test_first_model(self):
        self.assertEqual(C.first_model('["model-a", "model-b"]'), "model-a")
        self.assertEqual(C.first_model("model-a, model-b"), "model-a")
        self.assertIsNone(C.first_model(None))

    def test_the_sites_own_comment_reader(self):
        import json
        import shutil
        import subprocess
        if not shutil.which("node"):
            self.skipTest("node isn't installed")
        page = "AGENDA\nPublic comment: You may submit written comments by e-mail to the Clerk no later than 4:00 pm on the day before the meeting.\nCall to order."
        r = subprocess.run(["node", str(Path(C.__file__).resolve().parent / "comment_reference.mjs")], input=json.dumps([page]), capture_output=True, text=True, check=True)
        self.assertIn("no later than 4:00 pm", json.loads(r.stdout))


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
