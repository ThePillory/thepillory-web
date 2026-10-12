#!/usr/bin/env python3
"""Tests for tools/govmoney.py and the loader's matching. Every table, page and statement here is FAKE, shaped like the real ones."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import govmoney as G  # noqa: E402
import load_gov_money as L  # noqa: E402

URL = "https://example.gov/table"

# Two pages of an enacted table: the second page has no header (facing page, other margins),
# a record whose text wraps, a requester list that wraps, and two requester cells (House, Senate).
TABLE = """                    EXAMPLE APPROPRIATIONS
                                                                                     Requestor(s)
 Agency     Account                  Project                                  Amount                           Origination
                                                                                         House        Senate

ED         Innovation               Example Learning Center, MD, for a        250,000                Senator A        S
                                      reading program

ED         Innovation               Example Clinic, CA, for equipment and    1,031,000   Member B     Senator C        H
                                      supplies
\f
ED      Innovation        Example Arts Group, VT, for a summer program            100,000               Senator D,       S
                                                                                                         Senator E

ED      Innovation        Example School District, NV, for laptops                 90,000   Member F                     H
"""


class Table(unittest.TestCase):
    def test_reads_every_record(self):
        rows = G.parse_table(TABLE, 2026, "lhhs", URL)
        self.assertEqual([r["amount"] for r in rows], [250000, 1031000, 100000, 90000])
        a, b, c, d = rows
        self.assertEqual(a["project"], "Example Learning Center, MD, for a reading program")
        self.assertEqual((a["state"], a["recipient"]), ("MD", "Example Learning Center"))
        self.assertEqual((a["house"], a["senate"], a["origination"]), ([], ["Senator A"], "S"))
        self.assertEqual((b["house"], b["senate"]), (["Member B"], ["Senator C"]))
        self.assertEqual(c["senate"], ["Senator D", "Senator E"])
        self.assertEqual((d["house"], d["state"], d["page"]), (["Member F"], "NV", 2))
        self.assertEqual(c["agency"], "ED")

    def test_thousands(self):
        t = TABLE.replace("EXAMPLE APPROPRIATIONS", "EXAMPLE APPROPRIATIONS\n [Dollars in thousands]")
        self.assertEqual(G.parse_table(t, 2026, "lhhs", URL)[0]["amount"], 250000 * 1000)

    def test_unreadable_tables_stay_links(self):
        with self.assertRaises(G.Unreadable):
            G.parse_table(TABLE.replace("Origination", "Notes"), 2026, "lhhs", URL)
        with self.assertRaises(G.Unreadable):
            G.parse_table("Origination\nnothing here", 2026, "lhhs", URL)

    def test_stray_mark_after_amount(self):
        t = TABLE.replace("1,031,000   Member B", "1,031,000‘  Member B")
        self.assertEqual(len(G.parse_table(t, 2026, "lhhs", URL)), 4)

    def test_record_naming_agency_and_project_is_not_a_header(self):
        line = "Environmental Protection Agency   STAG    CA     City of Example for Restoration Project    1,092,000   Member G      H"
        t = TABLE.replace("ED      Innovation        Example School District", line + "\n\nED      Innovation        Example School District")
        rows = G.parse_table(t, 2026, "lhhs", URL)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[3]["house"], ["Member G"])


class Names(unittest.TestCase):
    MEMBERS = G.Members([
        {"id": "a", "name": "Adam Smith", "last_name": "Smith", "chamber": "us-house", "state": "WA", "district_code": "9", "active": 1},
        {"id": "b", "name": "Adrian Smith", "last_name": "Smith", "chamber": "us-house", "state": "NE", "district_code": "3", "active": 1},
        {"id": "c", "name": "Example Moved", "last_name": "Moved", "chamber": "us-senate", "state": "CA", "district_code": None, "active": 1},
        {"id": "d", "name": "Example Barragán", "last_name": "Barragán", "chamber": "us-house", "state": "CA", "district_code": "44", "active": 1},
        {"id": "e", "name": "Austin Scott", "last_name": "Scott", "chamber": "us-house", "state": "GA", "district_code": "8", "active": 1},
        {"id": "f", "name": "David Scott", "last_name": "Scott", "chamber": "us-house", "state": "GA", "district_code": "13", "active": 1},
        {"id": "g", "name": "Bobby Scott", "last_name": "Scott", "chamber": "us-house", "state": "VA", "district_code": "3", "active": 1},
        {"id": "h", "name": "Lindsey Example", "last_name": "Example", "chamber": "us-senate", "state": "SC", "district_code": None, "active": 1},
    ])

    def test_district_settles_a_shared_last_name(self):
        self.assertEqual(self.MEMBERS.match_full("Adam", "Smith", "us-house", "WA09"), "a")
        self.assertEqual(self.MEMBERS.match_full("Adrian", "Smith", "us-house", "NE03"), "b")

    def test_member_who_changed_chambers(self):
        self.assertEqual(self.MEMBERS.match_full("Example", "Moved", "us-house", "CA30"), "c")

    def test_accents_and_states(self):
        self.assertEqual(self.MEMBERS.match_requester("Barragan", "house"), "d")
        self.assertEqual(self.MEMBERS.match_requester("Scott (VA)", "house"), "g")
        self.assertIsNone(self.MEMBERS.match_requester("Scott (GA)", "house"))  # two: never guessed
        self.assertEqual(self.MEMBERS.match_full("Austin", "Scott", "us-house", "GA"), "e")

    def test_split_first_name_rejoined(self):
        rows = [{"state": "GA", "house": ["Scott", "Austin (GA)", "Smith"], "senate": []}]
        L.who(rows, self.MEMBERS)
        self.assertEqual([(n, o) for _, n, o in rows[0]["_who"]], [("Scott, Austin (GA)", "e"), ("Smith", None)])

    def test_hyphen_wrapped_name(self):
        self.assertEqual(G._names("Example- Hyphen, Other"), ["Example-Hyphen", "Other"])

    def test_contacts(self):
        self.assertEqual(G.contact_member("Lindsey Example U.S. Senator", self.MEMBERS), ("h", "member"))
        self.assertEqual(G.contact_member("A. Staffer Chief of Staff, Office of Senator L. Example", self.MEMBERS), ("h", "office"))
        self.assertIsNone(G.contact_member("A. Reporter, Example Daily News", self.MEMBERS))


class Requests(unittest.TestCase):
    def test_tied_only_on_one_match(self):
        tables = [
            {"id": "x1", "fy": 2026, "recipient": "Example Water District", "project": "Pipes", "_who": [("house", "Smith", "a")]},
            {"id": "x2", "fy": 2026, "recipient": None, "project": "City of Example for Storm Drains", "_who": [("house", "Smith", "a")]},
            {"id": "x3", "fy": 2026, "recipient": "Twice Inc.", "project": "One", "_who": [("house", "Smith", "a")]},
            {"id": "x4", "fy": 2026, "recipient": "Twice", "project": "Two", "_who": [("house", "Smith", "a")]},
        ]
        reqs = [
            {"fy": 2026, "official_id": "a", "recipient": "The Example Water District"},
            {"fy": 2026, "official_id": "a", "recipient": "City of Example"},
            {"fy": 2026, "official_id": "a", "recipient": "Twice"},
            {"fy": 2026, "official_id": "b", "recipient": "Example Water District"},
        ]
        self.assertEqual(L.tie_requests(reqs, tables), 2)
        self.assertEqual([q["enacted_id"] for q in reqs], ["x1", "x2", None, None])


class Spreadsheets(unittest.TestCase):
    def test_house_requests(self):
        rows = [("Member Last Name", "Member First Name", "District", "Party", "Subcommittee", "Recipient", "Project Purpose", "Recipient Address", "Amount Requested", "Member Website"),
                ("Example", "Ann", "wa09", "X", "Labor, Health and Human Services, Education", "Example Clinic", "Equipment", "1 Main St", "1,000,000", '=HYPERLINK("https://example.house.gov/cpf","site")'),
                (None, None, None, None, None, None, None, None, None, None)]
        out = G.house_requests(rows, 2026, URL)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["district"], out[0]["subcommittee"], out[0]["amount_requested"], out[0]["member_url"]), ("WA09", "lhhs", 1000000.0, "https://example.house.gov/cpf"))

    def test_house_awards(self):
        rows = [("Appropriations Bill", "Agency", "Account", "State/Location", "Project", "Location/Recipient", "House Amount", "House Requestor(s)", "Party"),
                ("Labor, HHS, Education", "HHS", "HRSA", None, "Example Hospital, Exampletown, PA for equipment", None, 500000, "Smith, Jones", "X")]
        out = G.house_awards(rows, 2027, URL)
        self.assertEqual((out[0]["subcommittee"], out[0]["state"], out[0]["house"], out[0]["stage"]), ("lhhs", "PA", ["Smith", "Jones"], "house_committee"))


class Travel(unittest.TestCase):
    def test_house(self):
        page = """<table><tr><td data-label="Member Name"><a href="/gtimages/ST/2026/1.pdf">Example, Ann</a></td><td data-label="Filer Name">Ann Example</td>
          <td data-label="Travel Dates">1/7/2026 - 1/9/2026</td><td data-label="Destination">Las Vegas, NV</td><td data-label="Sponsor">Example Association</td></tr></table>"""
        r = G.house_travel(page)[0]
        self.assertEqual((r["member"], r["start"], r["end"], r["sponsor"]), ("Example, Ann", "2026-01-07", "2026-01-09", "Example Association"))
        self.assertTrue(r["url"].endswith("/gtimages/ST/2026/1.pdf"))

    def test_senate(self):
        xml = """<root><dbo.filer LastName="EXAMPLE" FirstName="ANN"><dbo.Office OfficeName="EXAMPLE, ANN"><dbo.Document BeginTravelDate="03/01/2025" EndTravelDate="03/03/2025">
          <dbo.Reports ReportTitle="Member Reimbursed Travel" DocURL="https://example.senate.gov/1.pdf"/></dbo.Document></dbo.Office></dbo.filer></root>"""
        r = G.senate_travel(xml)[0]
        self.assertTrue(r["member_trip"])
        self.assertEqual((r["start"], r["url"]), ("2025-03-01", "https://example.senate.gov/1.pdf"))


class Fara(unittest.TestCase):
    def test_item12(self):
        text = """Response to Item 12-Detail
 Foreign Principal                 Date          Contact                                   Method
 Example Embassy                   03/12/2026    Lindsey Example U.S. Senator              Phone Call
 Example Embassy                   04/20/2026    |A. Reporter, Example Daily               |Email
 Response to Item 13"""
        rows = G.item12_contacts(text)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {"principal": "Example Embassy", "date": "2026-03-12", "contact": "Lindsey Example U.S. Senator", "method": "Phone Call"})
        self.assertEqual(rows[1]["contact"], "A. Reporter, Example Daily")
        self.assertEqual(G.item12_contacts("no table"), [])


class Quarters(unittest.TestCase):
    def test_quarters(self):
        import datetime as d
        q = list(L.quarters(d.date(2025, 1, 1), d.date(2025, 5, 2)))
        self.assertEqual(q, [(d.date(2025, 1, 1), d.date(2025, 3, 31)), (d.date(2025, 4, 1), d.date(2025, 5, 2))])


if __name__ == "__main__":
    unittest.main()
