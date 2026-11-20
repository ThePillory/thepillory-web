"""Tests for tools/load_agencies.py, with saved copies of each source (tools/fixtures/agencies/)."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_agencies as L  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "agencies"
fx = lambda n: (FX / n).read_text()
jfx = lambda n: json.loads(fx(n))


class Names(unittest.TestCase):
    def test_department_forms_match(self):
        self.assertEqual(L.norm_name("Agriculture Department"), L.norm_name("Department of Agriculture"))
        self.assertEqual(L.norm_name("DEPARTMENT OF THE INTERIOR"), L.norm_name("Interior Department"))
        self.assertNotEqual(L.norm_name("Labor Department"), L.norm_name("National Labor Relations Board"))

    def test_capitals_become_ordinary_words_unchanged(self):
        self.assertEqual(L.normal_case("SECRETARY OF LABOR"), "Secretary of Labor")
        self.assertEqual(L.normal_case("ANN MCDONALD-SMITH"), "Ann Mcdonald-Smith")
        self.assertEqual(L.normal_case("Already Mixed"), "Already Mixed")


class Matching(unittest.TestCase):
    def test_reordered_and_abbreviated_names(self):
        idx = L.name_index([{"id": "personnel-management-office", "name": "Personnel Management Office"},
                            {"id": "engineers-corps", "name": "Engineers Corps"},
                            {"id": "administrative-conference-of-the-united-states", "name": "Administrative Conference of the United States"}])
        self.assertEqual(L.unique_match(idx, "Office of Personnel Management"), "personnel-management-office")
        self.assertEqual(L.unique_match(idx, "Corps of Engineers - Civil Works"), "engineers-corps")
        self.assertEqual(L.unique_match(idx, "Administrative Conference of the U.S."), "administrative-conference-of-the-united-states")
        self.assertIsNone(L.unique_match(idx, "Office of Management"))


class Agencies(unittest.TestCase):
    rows = L.parse_fr_agencies(jfx("fr_agencies.json"))
    by = {r["id"]: r for r in rows}

    def test_kinds(self):
        self.assertEqual(self.by["agriculture-department"]["kind"], "department")
        self.assertEqual(self.by["forest-service"]["kind"], "sub-agency")
        self.assertEqual(self.by["forest-service"]["parent_id"], "agriculture-department")
        self.assertEqual(self.by["environmental-protection-agency"]["kind"], "independent")

    def test_description_word_for_word_and_sources(self):
        self.assertEqual(self.by["labor-department"]["description"],
                         "The Department of Labor fosters, promotes, and develops the welfare of the wage earners, job seekers, and retirees of the United States.")
        self.assertIsNone(self.by["administrative-conference-of-the-united-states"]["website"])  # not a link
        self.assertTrue(all(r["source_url"].startswith("https://www.federalregister.gov/agencies/") for r in self.rows))

    def test_slug_is_the_id(self):
        self.assertEqual(sorted(self.by), sorted(a["slug"] for a in jfx("fr_agencies.json")))


class Leaders(unittest.TestCase):
    agencies = L.parse_fr_agencies(jfx("fr_agencies.json"))
    noms = [{"id": "PN100-1", "description": "Pat Sample, of Ohio, to be Secretary of Labor.", "status": "confirmed", "latest_action": "Confirmed by the Senate by Yea-Nay Vote. 53 - 46.", "latest_on": "2025-03-10"},
            {"id": "PN200-1", "description": "Ann McDonald, of Montana, to be Chief of the Forest Service, Department of Agriculture.", "status": "confirmed", "latest_action": "Confirmed by the Senate by Voice Vote.", "latest_on": "2025-05-01"}]
    votes = [{"id": "us-senate-119-1-100", "subject": "Pat Sample, of Ohio, to be Secretary of Labor", "question": "On the Nomination", "result": "Nomination Confirmed"}]
    officials = [{"id": "bioguide:none-labor", "name": "Pat Sample"}]

    def rows(self):
        plum = L.parse_plum(fx("plum.csv"))
        return L.leader_rows(plum, L.name_index(self.agencies), self.noms, L.nomination_votes(self.votes, self.noms), self.officials)

    def test_pas_positions_only_with_acting_as_listed(self):
        rows, unmatched = self.rows()
        got = {(r["position"], r["name"], r["status"], r["placement"]) for r in rows}
        self.assertEqual(got, {("Secretary of Labor", "Pat Sample", "Filled", None),
                               ("Deputy Secretary of Labor", "", "Vacant", None),
                               ("Deputy Secretary of Labor", "Jane Example", "Filled", "PTDO"),
                               ("Chief of the Forest Service", "Ann Mcdonald", "Filled", None)})
        self.assertEqual(unmatched, ["DEPARTMENT OF THE MOON"])

    def test_confirmation_from_the_record(self):
        rows, _ = self.rows()
        sec = next(r for r in rows if r["position"] == "Secretary of Labor")
        self.assertEqual((sec["nomination_id"], sec["vote_id"], sec["confirm_note"], sec["since"], sec["official_id"]),
                         ("PN100-1", "us-senate-119-1-100", None, "2025-03-11", "bioguide:none-labor"))
        chief = next(r for r in rows if r["position"] == "Chief of the Forest Service")
        self.assertEqual((chief["agency_id"], chief["vote_id"], chief["confirm_note"]), ("forest-service", None, "Confirmed by the Senate by Voice Vote."))

    def test_two_matching_nominations_tie_to_none(self):
        twice = self.noms + [dict(self.noms[0], id="PN300-1")]
        self.assertIsNone(L.match_nomination("PAT", "SAMPLE", "SECRETARY OF LABOR", twice))


class Money(unittest.TestCase):
    def test_years_since_2017_with_a_figure(self):
        rows = L.money_rows("labor-department", "1601", jfx("usas_budgetary.json"))
        self.assertEqual([r["fy"] for r in rows], [2026, 2025])
        self.assertEqual(rows[0]["source_url"], "https://www.usaspending.gov/agency/1601?fy=2026")
        self.assertEqual(rows[1]["outlays"], 18700000000.0)

    def test_parts(self):
        oc = L.object_class_rows("labor-department", 2025, jfx("usas_object_class.json"))
        self.assertEqual(len(oc), 3)
        fn = L.function_rows("labor-department", 2025, jfx("usas_function.json"))
        self.assertEqual([(r["name"], r["parent"]) for r in fn][0], ("Training and Employment", "Education, Training, Employment, and Social Services"))

    def test_recipients_never_individuals(self):
        rows = L.recipient_rows("labor-department", 2025, "grants", jfx("usas_recipients.json"), jfx("usas_recipients_individuals.json"))
        self.assertEqual([(r["rank"], r["name"]) for r in rows], [(1, "STATE OF CALIFORNIA"), (2, "EXAMPLE TRAINING CORPORATION")])

    def test_recipient_request(self):
        b = L.recipient_body("Department of Labor", 2025, "contracts", individuals=True)
        self.assertEqual(b["filters"]["time_period"], [{"start_date": "2024-10-01", "end_date": "2025-09-30"}])
        self.assertEqual(b["filters"]["recipient_type_names"], ["individuals"])

    def test_code_map_one_match(self):
        agencies = L.parse_fr_agencies(jfx("fr_agencies.json"))
        m, un = L.usas_code_map([{"toptier_code": "1601", "agency_name": "Department of Labor"}, {"toptier_code": "999", "agency_name": "Office of Nothing"}], L.name_index(agencies))
        self.assertEqual((m, un), ({"1601": "labor-department"}, ["Office of Nothing"]))


class Oversight(unittest.TestCase):
    def test_reports_naming_an_agency_by_full_name(self):
        agencies = L.parse_fr_agencies(jfx("fr_agencies.json"))
        items = L.parse_gao_rss(fx("gao_reports.xml"))
        self.assertEqual([i["number"] for i in items], ["GAO-27-108458", "GAO-27-108401", "GAO-27-108300"])
        self.assertEqual(items[0]["published_on"], "2026-11-17")
        rows = L.report_rows(items, agencies)
        self.assertEqual(sorted((r["number"], r["agency_id"]) for r in rows),
                         [("GAO-27-108401", "environmental-protection-agency"), ("GAO-27-108401", "forest-service"), ("GAO-27-108458", "labor-department")])
        self.assertEqual(rows[0]["title"] if rows[0]["number"] == "GAO-27-108458" else "Workforce Programs: Department of Labor Should Improve Data on Grant Outcomes",
                         "Workforce Programs: Department of Labor Should Improve Data on Grant Outcomes")


class Rules(unittest.TestCase):
    def test_counts_and_latest(self):
        c = L.rule_count_rows("labor-department", jfx("fr_yearly.json"))
        self.assertEqual([(r["year"], r["rules"]) for r in c], [(2017, 31), (2025, 22), (2026, 18)])
        r = L.rule_rows("labor-department", jfx("fr_rules.json"))
        self.assertEqual([x["document_number"] for x in r], ["2026-21001"])


class Laws(unittest.TestCase):
    def test_by_subcommittee_title(self):
        mapping = json.loads(L.APPROPRIATIONS.read_text())
        bills = [{"id": "us-119-s-2587", "title": "Departments of Labor, Health and Human Services, and Education, and Related Agencies Appropriations Act, 2026"},
                 {"id": "us-119-hr-1", "title": "An act to provide for reconciliation"},
                 {"id": "us-119-s-2257", "title": "Legislative Branch Appropriations Act, 2026"}]
        rows = L.bill_rows(bills, mapping)
        self.assertEqual({r["bill_id"] for r in rows}, {"us-119-s-2587"})
        self.assertIn("labor-department", {r["agency_id"] for r in rows})

    def test_mapping_file_shape(self):
        for m in json.loads(L.APPROPRIATIONS.read_text()):
            self.assertTrue(m["subcommittee"] and m["titles"] and m["agencies"])


class Plan(unittest.TestCase):
    def test_only_changed_rows_are_written_and_gone_rows_pruned(self):
        old = {("labor-department", 2025): {"agency_id": "labor-department", "fy": 2025, "resources": 1.0, "obligations": 2.0, "outlays": 3.0, "source_url": "https://x"},
               ("labor-department", 2024): {"agency_id": "labor-department", "fy": 2024, "resources": 1.0, "obligations": 2.0, "outlays": 3.0, "source_url": "https://x"},
               ("labor-department", 2019): {"agency_id": "labor-department", "fy": 2019, "resources": 1.0, "obligations": 2.0, "outlays": 3.0, "source_url": "https://x"}}
        L.existing = lambda args, table, where="1": old
        new = [dict(old[("labor-department", 2025)]), dict(old[("labor-department", 2024)], outlays=4.0), {"agency_id": "labor-department", "fy": 2026, "resources": None, "obligations": None, "outlays": 5.0, "source_url": "https://x"}]
        p = L.Plan()
        p.add(None, "agency_money", new, prune_scope="all")
        t = p.tables["agency_money"]
        self.assertEqual((t["insert"], t["update"], t["delete"], t["writes"]), (1, 1, 1, 3))
        sql = "\n".join(p.statements)
        self.assertIn("IS NOT excluded.outlays", sql)  # an identical row is skipped by the upsert too
        self.assertIn("DELETE FROM agency_money", sql)
        self.assertNotIn("2025, ", sql.split("DELETE")[0])  # the unchanged row isn't sent
        # A second run with the same rows writes nothing.
        L.existing = lambda args, table, where="1": {(r["agency_id"], r["fy"]): r for r in new}
        p2 = L.Plan()
        p2.add(None, "agency_money", new, prune_scope="all")
        self.assertEqual((p2.writes, p2.statements), (0, []))


if __name__ == "__main__":
    unittest.main()
