#!/usr/bin/env python3
"""Tests for tools/build_scotus.py with short excerpts in the layout of the
Court's and the Senate's official pages. Standard library only.

    python3 tools/test_build_scotus.py
"""
import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_scotus as B  # noqa: E402

MEMBERS = """<table><tbody>
<tr><th scope="row"></th><td><a href="biographies.aspx#JRoberts">Roberts, John G., Jr.</a></td><td>Maryland</td><td>Bush, G. W.</td><td>September 29, 2005</td><td>&nbsp;</td></tr>
<tr><th scope="row"></th><td><a href="biographies.aspx#XFormer">Former, Example A.</a></td><td>Ohio</td><td>Example</td><td>January 1, 1990</td><td>June 30, 2010</td></tr>
<tr><th scope="row"></th><td><a href="biographies.aspx#ACBarrett">Barrett, Amy Coney</a></td><td>Indiana</td><td>Trump</td><td>October 27, 2020</td><td>&nbsp;</td></tr>
</tbody></table>"""

BIOS = """<a name="JRoberts"></a><p>John G. Roberts, Jr., Chief Justice of the United States, was born in Buffalo, New York, January 27, 1955.
He married Jane Sullivan in 1996 and they have two children. He served as a law clerk for Judge Henry J. Friendly of the U.S. Court of Appeals.
Nominated as Chief Justice of the United States by President George W. Bush, he assumed that office on September 29, 2005.</p>"""

SENATE = """<tr><td nowrap="true">Roberts, John G., Jr.</td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td>O'Connor</td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td nowrap="true"><a href="https://www.congress.gov/nomination/109th-congress/786">Jul 29, 2005</a></td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td nowrap="true"></td><td>W</td></tr>
<tr><td nowrap="true">Roberts, John G., Jr.</td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td>Rehnquist</td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td nowrap="true"><a href="https://www.congress.gov/nomination/109th-congress/801">Sep 6, 2005</a></td><td background="/x/vert_content_break.gif"><img src="/x/vert_content_break.gif"></td><td nowrap="true">78-22&nbsp; No. &nbsp;<A href="https://www.senate.gov/vote_109_1_00245.htm">245</A></td><td>C</td></tr>"""

SLIP = """<tr>
<td style="text-align: center;">12</td><td style="text-align: center;">1/09/26</td><td>24-5438</td>
<td><a href='/opinions/25pdf/24-5438_o7kq.pdf' target='_blank' title="Section 2244(b)(1) does not apply to federal prisoners.">Bowe v. United States</a></td>
<td>SS</td><td><span>607/1</span></td></tr>"""

GRANTED = """24-1016    CFX   RISEANDSHINE CORP. V. PEPSICO, INC.
                 Court: USCA-2                            Granted: 6/29/26


25-238)1   CFX   VIRAMONTES V. COOK COUNTY
25-566)2   CFX   GRANT V. HIGGINS
                 Court: 1USCA-7; 2USCA-2                  Granted: 6/30/26
                 Argument Date: 12/2/26
"""

QP = """24-1287 EXAMPLE V. EXAMPLE
QUESTION PRESENTED:

       Whether the example statute authorizes the example
action.


THE PETITION FOR A WRIT OF CERTIORARI IS GRANTED.
"""


class Tests(unittest.TestCase):
    def test_current_justices_only(self):
        m = B.parse_members(MEMBERS)
        self.assertEqual([x["listed_name"] for x in m], ["Roberts, John G., Jr.", "Barrett, Amy Coney"], "a justice with a termination date is left out")
        self.assertEqual(B.justice_slug("Roberts, John G., Jr."), "john-roberts")
        self.assertEqual(B.justice_slug("Barrett, Amy Coney"), "amy-coney-barrett")
        self.assertEqual(B.official_name("Roberts, John G., Jr."), "John G. Roberts, Jr.")

    def test_biography_word_for_word_without_family(self):
        b = B.parse_bios(BIOS)["JRoberts"]["sentences"]
        self.assertIn("He served as a law clerk for Judge Henry J. Friendly of the U.S. Court of Appeals.", b, "an initial or U.S. doesn't end a sentence")
        self.assertFalse(any("married" in s or "children" in s for s in b))

    def test_senate_confirmation(self):
        s = B.parse_senate(SENATE)
        confirmed = [v for v in s.values() if v["result"] == "C"]
        self.assertEqual(len(s), 2, "both nominations kept, apart")
        self.assertEqual(confirmed[0]["vote"], "78-22")
        self.assertEqual(confirmed[0]["roll_call"], "245")
        self.assertEqual(confirmed[0]["predecessor"], "Rehnquist")

    def test_slip_list(self):
        r = B.parse_slip_list(SLIP)[0]
        self.assertEqual((r["date"], r["docket"], r["name"], r["author_code"]), ("2026-01-09", "24-5438", "Bowe v. United States", "SS"))
        self.assertEqual(r["summary"], "Section 2244(b)(1) does not apply to federal prisoners.")
        self.assertEqual(r["pdf"], "https://www.supremecourt.gov/opinions/25pdf/24-5438_o7kq.pdf")

    def test_lineup(self):
        p = ("KAVANAUGH, J., delivered the opinion of the Court, in which ROBERTS, C. J., and THOMAS, ALITO, and BARRETT, JJ., joined, "
             "and in which GORSUCH, J., joined as to Parts I and II. GORSUCH, J., filed an opinion concurring in part and dissenting in part. "
             "SOTOMAYOR, J., filed a dissenting opinion, in which KAGAN and JACKSON, JJ., joined. JACKSON, J., filed a dissenting opinion.")
        got = {x["justice"]: (x["roles"], x["wrote"]) for x in B.parse_lineup(p)["justices"]}
        self.assertEqual(got["Kavanaugh"], (["majority"], ["majority"]))
        self.assertEqual(got["Roberts"], (["majority"], []))
        self.assertEqual(got["Gorsuch"], (["concurring in part and dissenting in part", "majority in part"], ["concurring in part and dissenting in part"]))
        self.assertEqual(got["Kagan"], (["dissent"], []))
        self.assertEqual(got["Jackson"], (["dissent"], ["dissent"]))
        u = B.parse_lineup("BARRETT, J., delivered the opinion for a unanimous Court.")
        self.assertTrue(u["unanimous"])
        self.assertEqual(B.parse_lineup(""), [])

    def test_bound_volume_print(self):
        """The preliminary prints: mixed-case names, a page break inside the lineup, "fled" for "filed", counsel after it."""
        text = ("PRELIMINARY PRINT\nApplications for partial stays granted.\n\n  Barrett, J., delivered the opinion of the Court, in which Roberts,\n"
                "C. J., and Thomas, Alito, Gorsuch, and Kavanaugh, JJ., joined.\nThomas, J., fled a concurring opinion, in which Gorsuch, J., joined, post,\n"
                "836                      TRUMP v. CASA, INC.\n\n                                 Syllabus\n\n"
                "p. 862. So-\ntomayor, J., fled a dissenting opinion, in which Kagan and Jackson, JJ.,\njoined, post, p. 879.\n\n"
                "   Solicitor General Sauer argued the cause for applicants in\nall cases.\n")
        self.assertFalse(B.exact_text(text))
        p = B.lineup_paragraph(text)
        self.assertNotIn("argued", p)
        got = {x["justice"]: (x["roles"], x["wrote"]) for x in B.parse_lineup(p)["justices"]}
        self.assertEqual(got["Barrett"], (["majority"], ["majority"]))
        self.assertEqual(got["Thomas"], (["concurrence", "majority"], ["concurrence"]))
        self.assertEqual(got["Gorsuch"], (["concurrence", "majority"], []))
        self.assertEqual(got["Sotomayor"], (["dissent"], ["dissent"]), "a name split across lines, and 'fled'")
        self.assertEqual(got["Jackson"], (["dissent"], []))

    def test_lineup_paragraph_from_syllabus(self):
        text = "Held: The example rule applies.\nPp. 3-9.\n\n 1 F. 4th 1, reversed.\n\n   ROBERTS, C. J., delivered the opinion of the Court, in which all\nother Members joined.\n\nCite as: 607 U. S. ___ (2026)\n"
        self.assertEqual(B.lineup_paragraph(text), "ROBERTS, C. J., delivered the opinion of the Court, in which all other Members joined.")

    def test_provisions_named_with_their_sentence(self):
        text = "Syllabus. Fourth Amendment in the syllabus. Opinion of the Court\nThe Fourth Amendment protects the\nright of the people. Congress passed the law under the Commerce Clause. Nothing else."
        got = B.provisions_named(text, {"amend-4", "art-1-sec-8-cl-3"})
        self.assertEqual([p["id"] for p in got], ["amend-4", "art-1-sec-8-cl-3"])
        self.assertEqual(got[0]["quote"], "The Fourth Amendment protects the right of the people.")
        self.assertEqual(B.provisions_named("Opinion of the Court Article III courts", {"art-3", "art-2"})[0]["id"], "art-3", "Article III isn't Article II")

    def test_granted_and_qp(self):
        g = B.parse_granted(GRANTED)
        self.assertEqual(g[0]["dockets"], ["24-1016"])
        self.assertEqual(g[0]["argument_date"], "")
        self.assertEqual(g[1]["dockets"], ["25-238", "25-566"])
        self.assertEqual(g[1]["name"], "VIRAMONTES V. COOK COUNTY / GRANT V. HIGGINS")
        self.assertEqual(g[1]["argument_date"], "12/2/26")
        self.assertEqual(B.parse_qp(QP), ["Whether the example statute authorizes the example action."])

    def test_current_term_starts_first_monday_of_october(self):
        self.assertEqual(B.current_term(datetime.date(2026, 10, 2)), 2025)
        self.assertEqual(B.current_term(datetime.date(2026, 10, 5)), 2026)


if __name__ == "__main__":
    unittest.main()
