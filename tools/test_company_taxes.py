#!/usr/bin/env python3
"""Tests for tools/build_company_taxes.py. Every fact, filing and company here is FAKE, shaped like EDGAR's."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_company_taxes as C  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def fact(start, end, val, accn, filed, fy, form="10-K", fp="FY"):
    return {"start": start, "end": end, "val": val, "accn": accn, "filed": filed, "fy": fy, "form": form, "fp": fp}


class Years(unittest.TestCase):
    def test_annual_10k_facts_only_since_2019(self):
        fs = [
            fact("2023-01-01", "2023-12-31", 10, "a-1", "2024-02-01", 2023),
            fact("2023-10-01", "2023-12-31", 3, "a-1", "2024-02-01", 2023),           # a quarter
            fact("2023-01-01", "2023-12-31", 9, "q-1", "2024-05-01", 2024, "10-Q"),  # not a 10-K
            fact("2017-01-01", "2017-12-31", 7, "a-0", "2018-02-01", 2017),          # before 2019
        ]
        self.assertEqual([f["val"] for f in C.annual(fs)], [10])

    def test_a_restatement_replaces_the_value_and_the_year_keeps_its_own_name(self):
        # A retailer's year ending in January: its own 10-K calls it fiscal 2024; next year's 10-K restates it.
        fs = [
            fact("2024-02-04", "2025-02-01", 100, "orig", "2025-03-20", 2024),
            fact("2024-02-04", "2025-02-01", 90, "restated", "2026-03-19", 2025),
        ]
        self.assertEqual(C.by_year(fs)["2025-02-01"], {"val": 90, "accn": "restated", "start": "2024-02-04", "fy": 2024})

    def test_each_year_is_named_by_its_own_10k_not_a_later_one(self):
        # Shaped like Tesla's: 2019 and 2020 reach the facts only through later 10-Ks (fiscal 2021's), which
        # once named all three years "2021". Each year takes its own 10-K's name, or the company's rule.
        fs = [
            fact("2019-01-01", "2019-12-31", 1, "k21", "2022-02-07", 2021),
            fact("2020-01-01", "2020-12-31", 2, "k21", "2022-02-07", 2021),
            fact("2021-01-01", "2021-12-31", 3, "k21", "2022-02-07", 2021),
            fact("2021-01-01", "2021-12-31", 3, "k23", "2024-01-29", 2023),
            fact("2023-01-01", "2023-12-31", 5, "k23", "2024-01-29", 2023),
        ]
        by = C.by_year(fs)
        self.assertEqual({e: v["fy"] for e, v in by.items()}, {"2019-12-31": None, "2020-12-31": None, "2021-12-31": 2021, "2023-12-31": 2023})
        ys = C.company_years({"IncomeTaxesPaidNet": {"units": {"USD": fs}}})
        self.assertEqual([y["fy"] for y in ys], [2019, 2020, 2021, 2023])
        # A retailer's year ending in January is named for the year it starts.
        r = C.name_years([{"period_end": "2025-02-01", "fy": 2024}, {"period_end": "2024-02-03", "fy": None}])
        self.assertEqual([y["fy"] for y in r], [2024, 2023])

    def test_untagged_values_stay_empty_and_the_first_listed_element_wins(self):
        usd = lambda *fs: {"units": {"USD": list(fs)}}
        facts = {
            "IncomeTaxesPaidNet": usd(fact("2025-01-01", "2025-12-31", 500, "k25", "2026-02-10", 2025)),
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest": usd(fact("2025-01-01", "2025-12-31", 4000, "k25", "2026-02-10", 2025)),
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments": usd(
                fact("2025-01-01", "2025-12-31", 3900, "k25", "2026-02-10", 2025), fact("2024-01-01", "2024-12-31", 3500, "k24", "2025-02-10", 2024)),
            "IncomeTaxesPaid": usd(fact("2024-01-01", "2024-12-31", 640, "k24", "2025-02-10", 2024)),  # gross, before refunds: not used
            "Revenues": usd(fact("2025-01-01", "2025-12-31", 20000, "k25", "2026-02-10", 2025)),
        }
        ys = C.company_years(facts)
        self.assertEqual([y["period_end"] for y in ys], ["2024-12-31", "2025-12-31"])
        y24, y25 = ys
        self.assertNotIn("taxes_paid", y24)  # only the gross figure was tagged: left empty, never estimated
        self.assertEqual(y24["pretax"], 3500)
        self.assertEqual(y24["pretax_tag"], "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments")
        self.assertEqual((y25["taxes_paid"], y25["pretax"], y25["revenue"]), (500, 4000, 20000))
        self.assertEqual(y25["pretax_tag"], "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest")
        self.assertEqual(y25["src"], {"taxes_paid": "k25", "pretax": "k25", "revenue": "k25"})
        self.assertIsNone(y25.get("paid_federal"))
        self.assertEqual(C.latest(ys)["period_end"], "2025-12-31")

    def test_a_year_with_only_revenue_is_not_a_tax_year(self):
        facts = {"Revenues": {"units": {"USD": [fact("2025-01-01", "2025-12-31", 1, "k", "2026-02-01", 2025)]}}}
        self.assertEqual(C.company_years(facts), [])


INSTANCE = """<xbrl>
<xbrli:context id="c-tot"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="c-ie"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:IncomeTaxAuthorityAxis">country:IE</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="c-ca"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:IncomeTaxAuthorityAxis">stpr:CA</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="c-other"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:IncomeTaxAuthorityAxis">us-gaap:ForeignTaxJurisdictionOtherMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="c-two"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:IncomeTaxAuthorityAxis">country:MX</xbrldi:explicitMember><xbrldi:explicitMember dimension="us-gaap:TaxPeriodAxis">x:OldYearsMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<us-gaap:IncomeTaxPaidForeignAfterRefundReceived contextRef="c-tot" unitRef="usd" decimals="-6">900000000</us-gaap:IncomeTaxPaidForeignAfterRefundReceived>
<us-gaap:IncomeTaxPaidForeignAfterRefundReceived contextRef="c-ie" unitRef="usd" decimals="-6">300000000</us-gaap:IncomeTaxPaidForeignAfterRefundReceived>
<us-gaap:IncomeTaxPaidStateAndLocalAfterRefundReceived contextRef="c-ca" unitRef="usd" decimals="-6">40000000</us-gaap:IncomeTaxPaidStateAndLocalAfterRefundReceived>
<us-gaap:IncomeTaxPaidForeignAfterRefundReceived contextRef="c-other" unitRef="usd" decimals="-6">600000000</us-gaap:IncomeTaxPaidForeignAfterRefundReceived>
<us-gaap:IncomeTaxPaidForeignAfterRefundReceived contextRef="c-two" unitRef="usd" decimals="-6">5000000</us-gaap:IncomeTaxPaidForeignAfterRefundReceived>
<co:IncomeTaxPaidFederalStateAndLocalAfterRefundReceived contextRef="c-tot" unitRef="usd">1</co:IncomeTaxPaidFederalStateAndLocalAfterRefundReceived>
</xbrl>"""


def ctx(cid, member, start="2025-01-01", end="2025-12-31"):
    seg = f'<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:IncomeTaxAuthorityAxis">{member}</xbrldi:explicitMember></xbrli:segment>' if member else ""
    return (f'<xbrli:context id="{cid}"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier>{seg}</xbrli:entity>'
            f'<xbrli:period><xbrli:startDate>{start}</xbrli:startDate><xbrli:endDate>{end}</xbrli:endDate></xbrli:period></xbrli:context>')


def fact_xml(el, cid, val):
    return f'<us-gaap:{el} contextRef="{cid}" unitRef="usd" decimals="-6">{val}</us-gaap:{el}>'


# Shaped like Tesla's FY2025 10-K (CIK 1318605, 0001628280-26-003952), as the accuracy audit's section 9 printed it:
# federal and the total undimensioned; states as California plus a company-defined "Other states" member;
# foreign as China plus us-gaap's "Other countries" member; no state or foreign total.
TESLA = "<xbrl>" + "".join([
    ctx("d", None), ctx("ca", "stpr:CA"), ctx("os", "tsla:OtherStatesMember"), ctx("cn", "country:CN"), ctx("of", "us-gaap:ForeignTaxJurisdictionOtherMember"),
    fact_xml("IncomeTaxPaidFederalAfterRefundReceived", "d", 28000000),
    fact_xml("IncomeTaxPaidStateAndLocalAfterRefundReceived", "ca", 86000000),
    fact_xml("IncomeTaxPaidStateAndLocalAfterRefundReceived", "os", 65000000),
    fact_xml("IncomeTaxPaidForeignAfterRefundReceived", "cn", 751000000),
    fact_xml("IncomeTaxPaidForeignAfterRefundReceived", "of", 302000000),
    fact_xml("IncomeTaxesPaidNet", "d", 1232000000),
]) + "</xbrl>"

TESLA_LAB = """<link:linkbase>
<link:labelLink>
<link:loc xlink:type="locator" xlink:href="tsla-20251231.xsd#tsla_OtherStatesMember" xlink:label="loc_os"/>
<link:labelArc xlink:type="arc" xlink:from="loc_os" xlink:to="lab_os"/>
<link:label xlink:type="resource" xlink:label="lab_os" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="en-US">Other States [Member]</link:label>
<link:label xlink:type="resource" xlink:label="lab_os" xlink:role="http://www.xbrl.org/2003/role/terseLabel" xml:lang="en-US">Other states</link:label>
<link:loc xlink:type="locator" xlink:href="tsla-20251231.xsd#tsla_Revenue" xlink:label="loc_r"/>
</link:labelLink>
</link:linkbase>"""


class Jurisdictions(unittest.TestCase):
    def test_every_member_on_the_axis_is_read(self):
        rows = C.jurisdictions(INSTANCE, {"IE": "Ireland", "MX": "Mexico"}.get)
        self.assertEqual(rows, [
            {"period_end": "2025-12-31", "element": "IncomeTaxPaidStateAndLocalAfterRefundReceived", "jurisdiction": "stpr:CA", "name": "California", "amount": 40000000.0},
            {"period_end": "2025-12-31", "element": "IncomeTaxPaidForeignAfterRefundReceived", "jurisdiction": "country:IE", "name": "Ireland", "amount": 300000000.0},
            {"period_end": "2025-12-31", "element": "IncomeTaxPaidForeignAfterRefundReceived", "jurisdiction": "us-gaap:ForeignTaxJurisdictionOtherMember", "name": "Other countries", "amount": 600000000.0},
        ])  # the fact with a second dimension (c-two) stays out: it isn't one place's whole year

    def test_an_unknown_country_code_keeps_its_code_rather_than_a_guessed_name(self):
        rows = C.jurisdictions(INSTANCE, lambda code: None)
        self.assertEqual([r["name"] for r in rows], ["California", "IE", "Other countries"])

    def test_tesla_fy2025_every_place_and_the_company_label(self):
        self.assertEqual(C.custom_members(TESLA), {"tsla:OtherStatesMember"})
        labels = C.member_labels(TESLA_LAB)
        self.assertEqual(labels, {"tsla:OtherStatesMember": "Other states"})
        rows = C.jurisdictions(TESLA, {"CN": "China"}.get, labels)
        self.assertEqual([(r["jurisdiction"], r["name"], r["amount"]) for r in rows], [
            ("stpr:CA", "California", 86000000.0), ("tsla:OtherStatesMember", "Other states", 65000000.0),
            ("country:CN", "China", 751000000.0), ("us-gaap:ForeignTaxJurisdictionOtherMember", "Other countries", 302000000.0),
        ])
        # Without the label linkbase, the member's own name.
        self.assertEqual(C.jurisdictions(TESLA, {"CN": "China"}.get)[1]["name"], "Other states")
        year = {"period_end": "2025-12-31", "taxes_paid": 1232000000, "paid_federal": 28000000, "paid_state": None, "paid_foreign": None}
        b = C.breakdown(year, rows)
        self.assertEqual(b["parts"], {"federal": 28000000, "state": 151000000.0, "foreign": 1053000000.0})
        self.assertEqual(b["gap"], 0)

    def test_a_gap_is_reported_never_filled(self):
        rows = C.jurisdictions(TESLA, {"CN": "China"}.get)[:3]  # "Other countries" missing
        b = C.breakdown({"period_end": "2025-12-31", "taxes_paid": 1232000000, "paid_federal": 28000000}, rows)
        self.assertEqual(b["parts"]["foreign"], 751000000.0)
        self.assertEqual(b["gap"], 302000000)

    def test_totals_filed_as_members(self):
        xml = "<xbrl>" + "".join([
            ctx("t", None), ctx("dom", "us-gaap:DomesticCountryMember"), ctx("st", "us-gaap:StateAndLocalJurisdictionMember"), ctx("fo", "us-gaap:ForeignCountryMember"),
            fact_xml("IncomeTaxesPaidNet", "t", 100), fact_xml("IncomeTaxesPaidNet", "dom", 50), fact_xml("IncomeTaxesPaidNet", "st", 10), fact_xml("IncomeTaxesPaidNet", "fo", 40),
        ]) + "</xbrl>"
        rows = C.jurisdictions(xml, lambda c: None)
        self.assertEqual(C.breakdown({"period_end": "2025-12-31", "taxes_paid": 100}, rows), {"total": 100, "parts": {"federal": 50.0, "state": 10.0, "foreign": 40.0}, "gap": 0})

    def test_breakdown_filings_are_original_10ks_since_december_2024(self):
        sub = {"filings": {"recent": {"form": ["10-K/A", "10-K", "10-K", "10-Q"], "accessionNumber": ["a", "b", "c", "d"],
                                       "reportDate": ["2025-12-31", "2025-12-31", "2023-12-31", "2026-03-31"], "filingDate": ["", "", "", ""]}}}
        self.assertEqual(C.breakdown_filings(sub), {"b"})


class Writes(unittest.TestCase):
    def test_upsert_writes_only_changed_rows(self):
        sql = C.upsert("companies", ["cik", "name"], ["cik"], [{"cik": 1, "name": "Example Co"}])
        self.assertEqual(sql, ["INSERT INTO companies (cik, name) VALUES\n(1, 'Example Co') ON CONFLICT (cik) DO UPDATE SET name = excluded.name WHERE companies.name IS NOT excluded.name;"])

    def test_company_row_carries_the_latest_year_and_the_edgar_link(self):
        sub = {"name": "Example Holdings, Inc.", "tickers": ["EXH"], "sic": "3571", "sicDescription": "Electronic Computers",
               "fiscalYearEnd": "1231", "addresses": {"business": {"stateOrCountry": "CA"}}}
        ys = [{"period_end": "2024-12-31", "fy": 2024, "pretax": 5, "src": {}}, {"period_end": "2025-12-31", "fy": 2025, "taxes_paid": 2, "pretax": 7, "revenue": 70, "src": {}}]
        r = C.company_row(1234, sub, ys)
        self.assertEqual((r["name_key"], r["state"], r["latest_fy"], r["taxes_paid"], r["pretax"], r["revenue"]), ("example holdings", "CA", 2025, 2, 7, 70))
        self.assertEqual(r["source_url"], "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000001234&type=10-K")
        self.assertIsNone(C.business_state({"addresses": {"business": {"stateOrCountry": "D8"}}}))  # outside the U.S.


class Organizations(unittest.TestCase):
    def test_exact_name_with_one_company_or_a_confirmed_link_only(self):
        companies = [{"cik": 1, "name_key": "example holdings"}, {"cik": 2, "name_key": "twin"}, {"cik": 3, "name_key": "twin"}]
        found = {
            "lobbying": [{"name": "Example Holdings, Inc.", "year": 2024, "n": 2, "total": 100, "source_url": "https://lda.example/1"},
                         {"name": "EXAMPLE HOLDINGS INC", "year": 2025, "n": 1, "total": 50, "source_url": "https://lda.example/2"},
                         {"name": "Example Holdings Services LLC", "year": 2025, "n": 1, "total": 9, "source_url": "https://lda.example/3"},
                         {"name": "Twin Inc", "year": 2025, "n": 1, "total": 9, "source_url": "https://lda.example/4"}],
            "pac": [{"name": "Example Holdings Political Action Committee", "year": 2026, "n": 3, "total": 7000, "source_url": "https://fec.example/1"}],
        }
        rows = C.match_orgs(companies, found, {"example holdings political action committee": 1})
        got = sorted((r["kind"], r["org_name"], r["cik"], r["how"]) for r in rows)
        self.assertEqual(got, [
            ("lobbying", "EXAMPLE HOLDINGS INC", 1, "name"),
            ("lobbying", "Example Holdings, Inc.", 1, "name"),
            ("pac", "Example Holdings Political Action Committee", 1, "confirmed"),
        ])  # not the near name ("Services LLC"), not a name two companies share ("Twin")
        s = json.loads(next(r for r in rows if r["org_name"] == "Example Holdings, Inc.")["summary"])
        self.assertEqual((s["total"], s["count"], s["first"], s["last"], s["source_url"]), (100, 2, "2024", "2024", "https://lda.example/1"))


class Largest(unittest.TestCase):
    def test_by_latest_revenue_only_and_untagged_revenue_left_out(self):
        today = __import__("datetime").date(2026, 11, 10)
        cs = [{"cik": 1, "revenue": 50, "taxes_paid": 999, "latest_end": "2025-12-31"}, {"cik": 2, "revenue": 900, "taxes_paid": 0, "latest_end": "2026-06-30"},
              {"cik": 3, "revenue": None, "latest_end": "2025-12-31"}, {"cik": 4, "revenue": 900, "latest_end": "2025-12-31"},
              {"cik": 5, "revenue": 5000, "latest_end": "2022-12-31"}]  # stopped filing: not among them
        self.assertEqual([c["cik"] for c in C.largest(cs, 2, today)], [2, 4])
        self.assertEqual([c["cik"] for c in C.largest(cs, 10, today)], [2, 4, 1])


class NameKey(unittest.TestCase):
    def test_the_same_key_as_the_site(self):
        names = ["AMAZON COM INC", "Amazon.com, Inc.", "The Coca-Cola Company", "AT&T INC.", "Procter & Gamble Co", "Exxon Mobil Corporation"]
        js = subprocess.run(["node", "--input-type=module", "-e",
                             f"import {{ nameKey }} from '{ROOT}/functions/awards/index.js'; console.log(JSON.stringify({json.dumps(names)}.map(nameKey)))"],
                            capture_output=True, text=True)
        if js.returncode:
            self.skipTest(f"node not available: {js.stderr[:200]}")
        self.assertEqual([C.name_key(n) for n in names], json.loads(js.stdout))


if __name__ == "__main__":
    unittest.main()
