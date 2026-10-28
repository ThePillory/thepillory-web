#!/usr/bin/env python3
"""Tests for tools/measure_conflicts.py: the Legislative Analyst's figure on
other propositions on the same ballot (as the guide's page carries it), the
official summary's conflict line, and the "sections" format. Standard library
only.

    python3 tools/test_measure_conflicts.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure_conflicts as C  # noqa: E402

NUMS = ["1", "40", "41", "42"]
P40 = ('<p><strong><em>State Costs.</em></strong> These costs would be paid from the new revenues&#46;</p>'
       '<center><img src="/img/40/prop-40-fig-1.jpg" alt="Proposition 40 Figure 1. Potential Interactions With Other Propositions: '
       'If Proposition 41 or 42 on this same ballot receive more yes votes than Proposition 40, then Propostion 40 could be stopped '
       'from becoming law even if it gets yes votes from a majority of voters. This is because the courts could find that Proposition 41 or 42 conflict with 40."></center>'
       '<ul><li>Proposition 1</li><li>Proposition 41</li></ul>')
P41 = ('<center><img src="/img/41/prop&#45;41&#45;fig&#45;1&#46;jpg" alt="Proposition 41 Figure 1&#46; If Proposition 41 receives more “yes” votes '
       'than Proposition 40 on this same ballot&#44; then Proposition 40 could be stopped from becoming law even if it gets yes votes '
       'from a majority of voters&#46; This is because the courts could find that Proposition 41 conflicts with Proposition 40&#46;"  /></center>')
URL = "https://voterguide.sos.ca.gov/propositions/40/analysis.htm"
VOID = "States that other voter-approved measures appearing on the same ballot are void if they conflict with this measure and this measure receives more affirmative votes."


class Analysis(unittest.TestCase):
    def test_figure_text_word_for_word_with_the_measures_it_names(self):
        [c] = C.ca_analysis_conflicts(P40, "40", NUMS, URL)
        self.assertEqual(c["title"], "Potential Interactions With Other Propositions")
        self.assertTrue(c["text"].startswith("If Proposition 41 or 42 on this same ballot receive more yes votes than Proposition 40, then Propostion 40"),
                        "as printed, the guide's own spelling kept")
        self.assertEqual(c["measures"], ["prop-41", "prop-42"])
        self.assertEqual(c["source_url"], URL)

    def test_entities_and_no_title(self):
        [c] = C.ca_analysis_conflicts(P41, "41", NUMS, URL)
        self.assertNotIn("title", c)
        self.assertEqual(c["measures"], ["prop-40"])
        self.assertTrue(c["text"].startswith("If Proposition 41 receives more “yes” votes than Proposition 40 on this same ballot, then"))
        self.assertTrue(c["text"].endswith("conflicts with Proposition 40."))

    def test_the_menu_of_propositions_and_earlier_measures_are_not_conflicts(self):
        page = '<p>Voters approved Proposition 30 in 2012 to temporarily increase income tax rates.</p><ul><li>Proposition 41</li></ul>'
        self.assertEqual(C.ca_analysis_conflicts(page, "3", NUMS, URL), [])

    def test_numbers(self):
        self.assertEqual(C.proposition_numbers("If Proposition 41 or 42 on this same ballot"), ["41", "42"])
        self.assertEqual(C.proposition_numbers("Propositions 40, 41, and 42"), ["40", "41", "42"])


class Fallback(unittest.TestCase):
    def test_the_summary_line_only_when_the_analysis_names_no_measure(self):
        ts = "https://voterguide.sos.ca.gov/propositions/41/title-summary.htm"
        both = C.ca_conflicts("41", P41, URL, ["Prohibits new taxes.", VOID], ts, NUMS)
        self.assertEqual([c["source"] for c in both], [C.ANALYST], "the analysis first")
        only = C.ca_conflicts("41", "<p>No figure.</p>", URL, ["Prohibits new taxes.", VOID], ts, NUMS)
        self.assertEqual(only, [{"text": VOID, "measures": [], "source": "Attorney General's official title and summary", "source_url": ts}])

    def test_no_conflict_language_no_entry(self):
        self.assertEqual(C.ca_conflicts("1", "<p>Bonds for housing.</p>", URL, ["Authorizes bonds."], URL, NUMS), [])


class Sections(unittest.TestCase):
    def test_a_paragraph_about_the_same_ballot_naming_another_measure(self):
        a = {"id": "amendment-81", "label": "Amendment 81", "source_url": "https://example.gov/book",
             "sections": [{"by": "Legislative Council Staff", "paragraphs": [
                 {"h": "Other measures"}, "If Amendment 81 and Proposition KK on this same ballot both pass, the one with more votes prevails.", "Unrelated."]}]}
        kk = {"id": "proposition-kk", "label": "Proposition KK", "sections": []}
        [c] = C.sections_conflicts(a, [a, kk])
        self.assertEqual(c["measures"], ["proposition-kk"])
        self.assertEqual(c["source"], "Legislative Council Staff")
        self.assertEqual(C.sections_conflicts(kk, [a, kk]), [])


if __name__ == "__main__":
    unittest.main()
