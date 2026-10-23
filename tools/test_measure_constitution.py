#!/usr/bin/env python3
"""Tests for tools/measure_constitution.py's checks: quotes word for word from
the official text, the kind of change agreeing with the words and the label,
state provisions kept only when the official text cites them, U.S. provisions
only when it refers to the U.S. Constitution, California sections quoted from
the file, neutral lines. No network and no model; every text is invented.

    python3 tools/test_measure_constitution.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure_constitution as M  # noqa: E402

US = {
    "amend-15-sec-1": {"id": "amend-15-sec-1", "label": "Amendment XV, Section 1", "leaf": True, "text": "The right of citizens of the United States to vote shall not be denied or abridged by the United States or by any State on account of race, color, or previous condition of servitude."},
    "amend-15": {"id": "amend-15", "label": "Amendment XV", "leaf": False, "text": ""},
}
CA = {
    "ca-art-13a": {"id": "ca-art-13a", "label": "Article XIII A", "text": "", "source_url": "https://leginfo.example/ca-13a"},
    "ca-art-13a-sec-1": {"id": "ca-art-13a-sec-1", "label": "Article XIII A, Section 1", "text": "(a) The maximum amount of any ad valorem tax on real property shall not exceed One percent (1%) of the full cash value of such property.",
                         "source_url": "https://leginfo.example/ca-13a"},
}


def parts(text):
    return [{"name": "Official voter guide", "url": "https://sos.example/guide", "text": text}]


class Text(unittest.TestCase):
    def test_word_for_word(self):
        p = parts("This measure amends Section 1 of Article XIII A of the California\nConstitution and adds a section.")
        self.assertTrue(M.found_in("amends Section 1 of Article XIII A of the California Constitution", p))
        self.assertTrue(M.found_in("amends Section 1 of Article XIII A of the California Constitution", parts("This measure amends Section 1 of Article XIII A of the California Constitution")))
        self.assertIsNone(M.found_in("changes Section 1 of Article XIII A of the California Constitution", p), "a paraphrase isn't a quote")
        self.assertIsNone(M.found_in("short", p), "too short to mean anything")
        self.assertTrue(M.found_in("the voter’s “choice”", parts('the voter\'s "choice" here')), "curly and straight quotes alike")

    def test_label(self):
        self.assertEqual(M.label_changes({"title": "INCREASES STATE’S RAINY DAY FUND. LEGISLATIVE CONSTITUTIONAL AMENDMENT."}), "constitution")
        self.assertEqual(M.label_changes({"title": "IMPOSES ONE-TIME TAX. INITIATIVE CONSTITUTIONAL AMENDMENT AND STATUTE."}), "both")
        self.assertEqual(M.label_changes({"title": "AUTHORIZES BONDS. LEGISLATIVE STATUTE."}), "statute")
        self.assertEqual(M.label_changes({"title": "x", "kind": "Citizen-initiated constitutional amendment"}), "constitution")
        self.assertEqual(M.label_changes({"title": "x", "kind": "Constitutional convention question (required every 16 years)"}), "convention")
        self.assertIsNone(M.label_changes({"title": "Initiative Measure No. 1 concerns taxes.", "kind": "Initiative to the People"}))

    def test_citations(self):
        self.assertEqual(M.parse_citation("Article XIII A, Section 1"), ("XIII A", "1"))
        self.assertEqual(M.parse_citation("Section 20 of Article X"), ("X", "20"))
        self.assertEqual(M.parse_citation("Art. IX, § 26"), ("IX", "26"))
        self.assertEqual(M.parse_citation("Article IV"), ("IV", None))
        p = parts("AMENDING ARTICLE IX, CONSTITUTION OF ARIZONA, BY ADDING SECTION 26")
        self.assertTrue(M.cited_in("IX", "26", p))
        self.assertFalse(M.cited_in("IX", "2", p), "Section 2 isn't Section 26")
        self.assertFalse(M.cited_in("X", "26", p), "Article X isn't Article IX")
        self.assertTrue(M.cited_in("XIII A", "1", parts("amends Section 1 of Article XIII A")))
        self.assertFalse(M.cited_in("XIII", "1", parts("amends Section 1 of Article XIII A")), "Article XIII isn't Article XIII A")
        self.assertEqual(M.ca_section_id("XIII A", "1"), "ca-art-13a-sec-1")
        self.assertEqual(M.ca_section_id("XIII A", None), "ca-art-13a")

    def test_lines(self):
        self.assertEqual(M.clean_line("This measure amends this section.", "amends"), "This measure amends this section.")
        self.assertEqual(M.clean_line("This measure creates a tax under this section.", "involves"), "This measure creates a tax under this section.")
        self.assertEqual(M.clean_line("This measure would violate the right to vote.", "involves"), M.LINES["involves"], "loaded words: the fixed line")
        self.assertEqual(M.clean_line("Amends the section", "amends"), M.LINES["amends"], "not a sentence starting 'This measure'")


class Draft(unittest.TestCase):
    def check(self, m, text, draft, state="CA"):
        return M.check_draft(m, state, parts(text), draft, US, CA)

    def test_california(self):
        m = {"title": "CHANGES PROPERTY TAX LIMIT. INITIATIVE CONSTITUTIONAL AMENDMENT.", "source": "Official Voter Information Guide", "source_url": "https://sos.example/guide"}
        text = "CHANGES PROPERTY TAX LIMIT. INITIATIVE CONSTITUTIONAL AMENDMENT. This initiative measure amends Section 1 of Article XIII A of the California Constitution."
        changes, quotes, provs, notes = self.check(m, text, {
            "changes": "constitution",
            "changes_quotes": ["This initiative measure amends Section 1 of Article XIII A of the California Constitution."],
            "provisions": [
                {"doc": "state", "us_id": None, "state_citation": "Article XIII A, Section 1", "relation": "amends", "line": "This measure amends this section."},
                {"doc": "state", "us_id": None, "state_citation": "Article XIII B, Section 2", "relation": "involves", "line": "This measure involves this section."},
                {"doc": "us", "us_id": "amend-15-sec-1", "state_citation": None, "relation": "involves", "line": "This measure involves voting."},
            ]})
        self.assertEqual(changes, "constitution")
        self.assertEqual(len(quotes), 1)
        self.assertEqual([p["id"] for p in provs], ["ca-art-13a-sec-1"])
        self.assertEqual(provs[0]["quote"], CA["ca-art-13a-sec-1"]["text"], "quoted from the file, word for word")
        self.assertIn("doesn't cite", " ".join(notes), "Article XIII B isn't in the official text")
        self.assertIn("doesn't refer to the U.S. Constitution", " ".join(notes))

    def test_label_wins_and_unverified_quotes_go(self):
        m = {"title": "AUTHORIZES BONDS. LEGISLATIVE STATUTE."}
        changes, quotes, provs, notes = self.check(m, "AUTHORIZES BONDS. LEGISLATIVE STATUTE. This act adds Section 5 to the Government Code.", {
            "changes": "constitution", "changes_quotes": ["This act amends the constitution of the state"], "provisions": []})
        self.assertEqual(changes, "statute", "the official label wins")
        self.assertEqual(quotes[0][0], "LEGISLATIVE STATUTE.", "the label's own words, found in the official text")
        self.assertTrue(any("not found word for word" in n for n in notes))

    def test_other_state_linked_not_quoted(self):
        m = {"title": "Graduated Income Tax", "kind": "Citizen-initiated constitutional amendment"}
        text = "Amendment 87 proposes amending the Colorado Constitution to change Section 17 of Article X. It also refers to the Fourteenth Amendment to the U.S. Constitution."
        changes, quotes, provs, notes = self.check(m, text, {
            "changes": "constitution", "changes_quotes": ["Amendment 87 proposes amending the Colorado Constitution"],
            "provisions": [{"doc": "state", "us_id": None, "state_citation": "Article X, Section 17", "relation": "amends", "line": "This measure amends this section."},
                           {"doc": "us", "us_id": "amend-15", "state_citation": None, "relation": "cites", "line": "x"}]}, state="CO")
        self.assertEqual(changes, "constitution")
        self.assertEqual(provs[0]["label"], "Colorado Constitution, Article X, Section 17")
        self.assertEqual(provs[0]["quote"], "", "linked to the official text, not quoted, until Colorado's is loaded")
        self.assertEqual(provs[0]["url"], M.STATE_CONSTITUTION["CO"])
        self.assertEqual(len(provs), 1, "amend-15 isn't a quotable provision (not a leaf)")

    def test_unclear(self):
        changes, quotes, provs, notes = self.check({"title": "Initiative Measure No. 1 concerns taxes.", "kind": "Initiative to the People"}, "Initiative Measure No. 1 concerns taxes.",
                                                   {"changes": "statute", "changes_quotes": ["Initiative Measure No. 1 concerns taxes."], "provisions": []}, state="WA")
        self.assertEqual(quotes, [], "the words quoted don't say statute")
        self.assertEqual(changes, "unclear")
        self.assertTrue(any("must add or confirm" in n for n in notes))

    def test_pdf_punctuation(self):
        # PDF text breaks a dash and a line differently; the words are the same, and the page shows the source's own text.
        src = parts("Third —That Section 22 of Article XVI\nthereof is amended to read:")
        part, shown = M.locate("Third-That Section 22 of Article XVI thereof is amended to read:", src)
        self.assertEqual(shown, "Third -That Section 22 of Article XVI thereof is amended to read:")
        self.assertIsNone(M.locate("Third-That Section 23 of Article XVI thereof is amended to read:", src), "a different word isn't a quote")

    def test_new_article(self):
        m = {"title": "NEW RULES. LEGISLATIVE CONSTITUTIONAL AMENDMENT.", "links": {"text": "https://sos.example/text.pdf"}}
        text = "NEW RULES. LEGISLATIVE CONSTITUTIONAL AMENDMENT. Article XXIV is added to the California Constitution, to read:"
        _, _, provs, notes = self.check(m, text, {"changes": "constitution", "changes_quotes": [], "provisions": [
            {"doc": "state", "us_id": None, "state_citation": "Article XXIV", "relation": "adds", "line": "This measure adds this article."},
            {"doc": "state", "us_id": None, "state_citation": "Article XXIV", "relation": "amends", "line": "This measure amends this article."}]})
        self.assertEqual(len(provs), 1, "only the measure that adds it can name an article that isn't there yet")
        self.assertEqual((provs[0]["label"], provs[0]["new"], provs[0]["url"]), ("California Constitution, Article XXIV (new)", True, "https://sos.example/text.pdf"))

    def test_citation_forms(self):
        p = parts("AMENDING ARTICLE IX, CONSTITUTION OF ARIZONA, BY ADDING SECTION 26.")
        self.assertTrue(M.cited_in("IX", "26", p))
        self.assertFalse(M.cited_in("IX", "2", p))
        p = parts("This amends Article VII, Sections 4, 6 and 9 of the State Constitution.")
        self.assertTrue(all(M.cited_in("VII", n, p) for n in ("4", "6", "9")))
        self.assertFalse(M.cited_in("VII", "5", p))

    def test_excerpt(self):
        short, cut = M.excerpt("One. Two.")
        self.assertEqual((short, cut), ("One. Two.", False))
        long_text = "\n\n".join(["Paragraph " + "word " * 60] * 5)
        out, cut = M.excerpt(long_text, 500)
        self.assertTrue(cut and long_text.startswith(out))


if __name__ == "__main__":
    unittest.main()
