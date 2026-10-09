#!/usr/bin/env python3
"""Tests for tools/load_state_votes.py with a tiny fake Open States session file.

    python3 tools/test_load_state_votes.py

Standard library only. Every name, bill and vote here is invented.
"""
import csv
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_state_votes as L  # noqa: E402


def table(rows):
    f = io.StringIO()
    w = csv.DictWriter(f, list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    return f.getvalue()


def fake_zip(folder):
    """A session file as Open States' bulk_export writes it (Django .values() columns)."""
    base = "tx/89/tx_89"
    files = {
        "README": "Open States Data Export\n\nState: tx\nSession: 89\nGenerated At: 2026-10-01 05:00:00\nCSV Format Version: 2.1\n",
        f"{base}_bills.csv": table([
            {"id": "ocd-bill/b1", "identifier": "HB 1", "title": "Relating to an example fund.", "classification": "['bill']", "subject": "[]",
             "session_identifier": "89", "jurisdiction": "Texas", "organization_classification": "lower"},
            {"id": "ocd-bill/b2", "identifier": "SB 2", "title": "Relating to an example board.", "classification": "['bill']", "subject": "[]",
             "session_identifier": "89", "jurisdiction": "Texas", "organization_classification": "upper"},
            {"id": "ocd-bill/b3", "identifier": "HB 3", "title": "No source.", "classification": "['bill']", "subject": "[]",
             "session_identifier": "89", "jurisdiction": "Texas", "organization_classification": "lower"},
        ]),
        f"{base}_bill_sources.csv": table([
            {"id": "1", "bill_id": "ocd-bill/b1", "url": "https://capitol.example.gov/HB1", "note": ""},
            {"id": "2", "bill_id": "ocd-bill/b2", "url": "https://capitol.example.gov/SB2", "note": ""},
        ]),
        f"{base}_organizations.csv": table([
            {"id": "ocd-organization/lower", "name": "House", "classification": "lower", "parent_id": ""},
            {"id": "ocd-organization/upper", "name": "Senate", "classification": "upper", "parent_id": ""},
            {"id": "ocd-organization/cmte", "name": "Finance", "classification": "committee", "parent_id": "ocd-organization/upper"},
        ]),
        f"{base}_votes.csv": table([
            {"id": "ocd-vote/1111", "identifier": "", "motion_text": "Third Reading", "motion_classification": "['passage']", "start_date": "2025-04-01",
             "result": "pass", "organization_id": "ocd-organization/lower", "bill_id": "ocd-bill/b1", "bill_action_id": "", "jurisdiction": "Texas", "session_identifier": "89"},
            {"id": "ocd-vote/2222", "identifier": "", "motion_text": "Do pass", "motion_classification": "[]", "start_date": "2025-03-01",
             "result": "fail", "organization_id": "ocd-organization/cmte", "bill_id": "ocd-bill/b2", "bill_action_id": "", "jurisdiction": "Texas", "session_identifier": "89"},
            {"id": "ocd-vote/3333", "identifier": "", "motion_text": "Motion to adjourn", "motion_classification": "[]", "start_date": "2025-03-02",
             "result": "pass", "organization_id": "ocd-organization/lower", "bill_id": "", "bill_action_id": "", "jurisdiction": "Texas", "session_identifier": "89"},
            {"id": "ocd-vote/4444", "identifier": "", "motion_text": "Third Reading", "motion_classification": "['passage']", "start_date": "2025-03-03",
             "result": "pass", "organization_id": "ocd-organization/lower", "bill_id": "ocd-bill/b3", "bill_action_id": "", "jurisdiction": "Texas", "session_identifier": "89"},
        ]),
        f"{base}_vote_people.csv": table([
            {"id": "1", "vote_event_id": "ocd-vote/1111", "option": "yes", "voter_name": "Ada Alpha", "voter_id": "ocd-person/aaaa", "note": ""},
            {"id": "2", "vote_event_id": "ocd-vote/1111", "option": "excused", "voter_name": "Bea Beta", "voter_id": "ocd-person/bbbb", "note": ""},
            {"id": "3", "vote_event_id": "ocd-vote/1111", "option": "no", "voter_name": "Former Member", "voter_id": "ocd-person/zzzz", "note": ""},
            {"id": "4", "vote_event_id": "ocd-vote/1111", "option": "yes", "voter_name": "Ada Alpha", "voter_id": "ocd-person/aaaa", "note": ""},
            {"id": "5", "vote_event_id": "ocd-vote/2222", "option": "no", "voter_name": "Gamma", "voter_id": "", "note": ""},
        ]),
        f"{base}_vote_counts.csv": table([
            {"id": "1", "vote_event_id": "ocd-vote/1111", "option": "yes", "value": "120"},
            {"id": "2", "vote_event_id": "ocd-vote/1111", "option": "no", "value": "25"},
            {"id": "3", "vote_event_id": "ocd-vote/1111", "option": "excused", "value": "4"},
        ]),
        f"{base}_vote_sources.csv": table([{"id": "1", "vote_event_id": "ocd-vote/1111", "url": "https://journals.example.gov/day45.pdf", "note": ""}]),
    }
    path = Path(folder) / "tx_89_csv_AbC123.zip"
    with zipfile.ZipFile(path, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return path


OFFICIALS = {
    "ocd-person/aaaa": {"k": L.stable_key("openstates:ocd-person/aaaa"), "chamber": "tx-lower", "last_name": "Alpha"},
    "ocd-person/bbbb": {"k": L.stable_key("openstates:ocd-person/bbbb"), "chamber": "tx-lower", "last_name": "Beta"},
    "ocd-person/gggg": {"k": L.stable_key("openstates:ocd-person/gggg"), "chamber": "tx-upper", "last_name": "Gamma"},
}


class LoaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tables, self.generated = L.read_tables(fake_zip(self.tmp.name))
        self.rows = L.build("TX", "89", self.tables, OFFICIALS)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_same_keys_as_the_worker(self):
        # stableKey() in workers/sync/src/states.js gives these (checked with node).
        self.assertEqual(L.stable_key("tx-ocd-vote/1111"), 243118297724161)
        self.assertEqual(L.stable_key("openstates:ocd-person/aaaa"), 2837591691952820)

    def test_bills_and_votes_as_the_source_states_them(self):
        self.assertEqual(self.generated, "2026-10-01 05:00:00")
        self.assertEqual(sorted(b["id"] for b in self.rows["bills"]), ["tx-89-hb-1", "tx-89-sb-2"])
        v = {x["id"]: x for x in self.rows["votes"]}
        third = v["tx-ocd-vote/1111"]
        self.assertEqual((third["chamber"], third["vote_type"], third["result"], third["question"]), ("tx-lower", "final_passage", "Passed", "Third Reading"))
        self.assertEqual(third["totals"], [120, 25, 0, 4])
        self.assertEqual(third["source_url"], "https://journals.example.gov/day45.pdf")
        # A committee vote: the committee's chamber, labeled committee; no totals stated -> none.
        cmte = v["tx-ocd-vote/2222"]
        self.assertEqual((cmte["chamber"], cmte["vote_type"], cmte["result"], cmte["totals"]), ("tx-upper", "committee", "Failed", [None, None, None, None]))
        self.assertEqual(cmte["source_url"], "https://capitol.example.gov/SB2", "no vote source: the bill's")
        # Left out and counted: a vote on no bill, and a vote on a bill without a source.
        self.assertEqual(self.rows["stats"]["votes_without_bill"], 1)
        self.assertEqual(self.rows["stats"]["votes_on_bills_without_source"], 1)

    def test_positions_for_current_members_only(self):
        a, b, g = (OFFICIALS[x]["k"] for x in ("ocd-person/aaaa", "ocd-person/bbbb", "ocd-person/gggg"))
        k1, k2 = L.stable_key("tx-ocd-vote/1111"), L.stable_key("tx-ocd-vote/2222")
        self.assertIn((k1, a, 0, None), self.rows["positions"])
        self.assertIn((k1, b, 3, "excused"), self.rows["positions"], "the source's word is kept when it isn't the usual one")
        self.assertIn((k2, g, 1, None), self.rows["positions"], "no person id: a unique last name in the chamber")
        self.assertEqual(len([p for p in self.rows["positions"] if p[0] == k1 and p[1] == a]), 1, "one position a member")
        self.assertEqual(self.rows["stats"]["positions_not_current_members"], 1)

    def test_statements_skip_votes_already_loaded(self):
        stmts, new_votes, new_positions = L.statements(self.rows)
        self.assertEqual((new_votes, new_positions), (2, 3))
        self.assertTrue(stmts[0].startswith("INSERT INTO bills"))
        self.assertIn("'Relating to an example fund.'", stmts[0])
        stmts, new_votes, new_positions = L.statements(self.rows, frozenset({"tx-ocd-vote/1111"}))
        self.assertEqual((new_votes, new_positions), (1, 1))
        self.assertEqual(L.lit("O'Neil"), "'O''Neil'")

    def test_sign_in_can_keep_cookies(self):
        # A helper named `http` once hid the http module, and sign-in failed before any request.
        self.assertTrue(hasattr(L.http, "cookiejar"))

    def test_the_signed_in_list_and_which_sessions(self):
        page = """<h2 class="heading">Texas</h2><ul>
          <li><a href="https://data.openstates.org/csv/latest/tx_88_csv_Old1.zip">
            Texas 88th Legislature (2023)</a> (updated 2023-06-27)</li>
          <li><a href="https://data.openstates.org/csv/latest/tx_89_csv_New1.zip">
            Texas 89th Legislature (2025)</a> (updated 2025-08-05)</li>
          <li><a href="https://data.openstates.org/csv/latest/tx_892_csv_New2.zip">
            Texas 89th Legislature, 2nd Called Session (2025)</a> (updated 2026-10-08)</li>
          <li><a href="https://data.openstates.org/csv/latest/ny_2025-2026_csv_Ny1.zip">2025-2026 Regular Session</a> (updated 2026-10-01)</li></ul>"""
        links = L.session_links(page)
        self.assertEqual([(x["st"], x["session"], x["updated"]) for x in links][:2], [("TX", "88", "2023-06-27"), ("TX", "89", "2025-08-05")])
        self.assertEqual([x["session"] for x in L.choose(links, ["TX"], 2025)], ["89", "892"])
        self.assertEqual([x["session"] for x in L.choose(links, ["NY", "TX"], 2025)], ["2025-2026", "89", "892"])


class LinkingTests(unittest.TestCase):
    def test_a_vote_linked_through_its_bill_action(self):
        tables = {
            "bills": [{"id": "ocd-bill/b1", "identifier": "HB 1", "title": "T", "organization_classification": "lower"}],
            "bill_sources": [{"bill_id": "ocd-bill/b1", "url": "https://capitol.example.gov/HB1"}],
            "bill_actions": [{"id": "act-1", "bill_id": "ocd-bill/b1"}],
            "votes": [
                {"id": "ocd-vote/1", "bill_id": "", "bill_action_id": "act-1", "motion_text": "Passage", "motion_classification": "['passage']",
                 "start_date": "2025-04-01", "result": "pass", "organization_id": ""},
                {"id": "ocd-vote/2", "bill_id": "ocd-bill/elsewhere", "bill_action_id": "", "motion_text": "Passage", "motion_classification": "[]",
                 "start_date": "2025-04-01", "result": "pass", "organization_id": ""},
            ],
            "vote_people": [], "vote_counts": [], "vote_sources": [], "organizations": [],
        }
        rows = L.build("TX", "89", tables, {})
        self.assertEqual([v["id"] for v in rows["votes"]], ["tx-ocd-vote/1"])
        self.assertEqual(rows["stats"]["votes_bill_not_in_file"], 1)
        self.assertEqual(rows["stats"]["sample_missing_bill_id"], "ocd-bill/elsewhere")

    def test_a_session_label_without_a_year(self):
        links = [
            {"st": "IL", "session": "103rd", "label": "103rd General Assembly", "updated": "2025-01-14", "url": "a"},
            {"st": "IL", "session": "104th", "label": "104th General Assembly", "updated": "2026-10-08", "url": "b"},
            {"st": "IL", "session": "102nd", "label": "102nd General Assembly", "updated": "2023-01-10", "url": "c"},
        ]
        self.assertEqual([x["session"] for x in L.choose(links, ["IL"], 2025)], ["104th"])


if __name__ == "__main__":
    unittest.main()
