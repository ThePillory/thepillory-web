#!/usr/bin/env python3
"""Tests for tools/build_wa_measures.py with short invented excerpts in the
layout of Washington's official documents. Standard library only.

    python3 tools/test_build_wa_measures.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_wa_measures as W  # noqa: E402

LETTER = """NICK BROWN
ATTORNEY GENERAL OF WASHINGTON
July 14, 2026
Ballot Title
Statement of Subject: Initiative Measure No. IL99-001 concerns example
rules for testing.
Concise Description: This measure would change an example rule and
add another.
Should this measure be enacted into law? Yes [ ]

No [ ]

The Law as It Presently Exists
In Washington, an example statute sets several rules for testing. Those rules apply to every
example and are enforced by an example office that writes guidance for the people affected
by them, and the guidance is published each year by that office for everyone who asks for it.

ATTORNEY GENERAL OF WASHINGTON
July 14, 2026
Page 2
Example Records: People have the right to see example records within a reasonable period of time
that does not exceed thirty days.
Example Fees: Offices may charge a reasonable fee.
The Effect of the Proposed Measure if Approved
If approved, the measure would change the example rule. The change would apply to all
examples.
Sincerely,
s/Example Name
"""

PAGE = """22                                        Initiative Measure IL99-001
Argument for                                                       Argument against
Vote Yes to Keep Examples Fair                                     Vote No Because The Example Office
Examples deserve fair rules. This measure keeps them fair for      And Its Staff Oppose It
everyone and costs nothing to the state.                           The Example Office, Example Board and
Protecting Examples                                                Example Council warn this measure would be
Every example matters. Vote yes.                                   costly for everyone who uses it today.
Rebuttal of argument against                                       Rebuttal of argument for
The opposition is wrong about costs. Vote yes.                     The costs are real. Vote no.

Written by                                                         Written by
Ann Example, Teacher; Ben Sample, Parent and Writer, Olympia       Cal Test, President, Example Council; Dee Fake-
                                                                   Name, Retired Nurse
Contact: yes@example.org                                           Contact: no@example.org
"""

PAMPHLET = """Fiscal Impact Statement
Written by the Office of Financial Management

For more information visit www.ofm.wa.gov/ballot

Summary
If approved by voters, Initiative Measure No. IL99-001 would have no
fiscal impact on the state.

Initiative Measure IL99-001
General assumptions
"""


class Tests(unittest.TestCase):
    def test_ballot_title(self):
        bt = W.ballot_title(LETTER)
        self.assertEqual(bt["subject"], "Initiative Measure No. IL99-001 concerns example rules for testing.")
        self.assertEqual(bt["description"], "This measure would change an example rule and add another.")

    def test_explanatory_statement_paragraphs(self):
        ex = W.explanatory(LETTER)
        self.assertEqual(len(ex["present"]), 3, "a page break after a full sentence ends a paragraph; a 'Label:' starts one")
        self.assertTrue(ex["present"][0].startswith("In Washington, an example statute"))
        self.assertTrue(ex["present"][1].startswith("Example Records:") and ex["present"][1].endswith("thirty days."))
        self.assertEqual(ex["effect"], ["If approved, the measure would change the example rule. The change would apply to all examples."])

    def test_arguments_by_side_with_signers_and_no_contact(self):
        args = W.arguments(PAGE, "IL99-001")
        self.assertEqual([(a["kind"], a["side"]) for a in args], [("for", "supporters"), ("rebuttal_against", "opponents"), ("against", "opponents"), ("rebuttal_for", "supporters")])
        f, ra, a, rf = args
        self.assertEqual(f["paragraphs"][0], "Vote Yes to Keep Examples Fair", "the campaign's heading is its own paragraph")
        self.assertIn("Protecting Examples", f["paragraphs"])
        self.assertEqual(a["paragraphs"][0], "Vote No Because The Example Office And Its Staff Oppose It", "a two-line heading")
        self.assertTrue(a["paragraphs"][1].startswith("The Example Office, Example Board and Example Council warn"), "capitalized names after a heading stay in the body")
        self.assertEqual(ra["paragraphs"], ["The costs are real. Vote no."])
        self.assertEqual([s["name"] for s in f["signers"]], ["Ann Example", "Ben Sample"])
        self.assertEqual(a["signers"][1], {"name": "Dee Fake-Name", "title": "Retired Nurse"}, "a name broken across lines keeps its hyphen")
        self.assertFalse(any("example.org" in p for x in args for p in x["paragraphs"]), "contact lines are left out")

    def test_fiscal_summary_from_the_pamphlet(self):
        self.assertEqual(W.fiscal_summary(PAMPHLET, "IL99-001"), ["If approved by voters, Initiative Measure No. IL99-001 would have no fiscal impact on the state."])
        with self.assertRaises(SystemExit):
            W.fiscal_summary(PAMPHLET, "IL99-002")

    def test_word_for_word_or_nothing(self):
        W.check_quotes("IL99-001", "Every example\nmatters. Vote yes.", ["Every example matters."], "argument")
        with self.assertRaises(SystemExit):
            W.check_quotes("IL99-001", "Every example matters.", ["Every single example matters."], "argument")

    def test_damaged_ligatures_are_refused(self):
        self.assertTrue(W.DAMAGED.search("The e ective date"))
        self.assertTrue(W.DAMAGED.search("The eƯective date"))
        self.assertFalse(W.DAMAGED.search("The effective date of the office"))


if __name__ == "__main__":
    unittest.main()
