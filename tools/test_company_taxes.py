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


class Jurisdictions(unittest.TestCase):
    def test_only_named_countries_and_states_on_the_one_axis(self):
        rows = C.jurisdictions(INSTANCE, {"IE": "Ireland", "MX": "Mexico"}.get)
        self.assertEqual(rows, [
            {"period_end": "2025-12-31", "element": "IncomeTaxPaidStateAndLocalAfterRefundReceived", "jurisdiction": "stpr:CA", "name": "California", "amount": 40000000.0},
            {"period_end": "2025-12-31", "element": "IncomeTaxPaidForeignAfterRefundReceived", "jurisdiction": "country:IE", "name": "Ireland", "amount": 300000000.0},
        ])

    def test_an_unknown_country_code_is_left_out_rather_than_guessed(self):
        self.assertEqual([r["jurisdiction"] for r in C.jurisdictions(INSTANCE, lambda code: None)], ["stpr:CA"])


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
        cs = [{"cik": 1, "revenue": 50, "taxes_paid": 999}, {"cik": 2, "revenue": 900, "taxes_paid": 0}, {"cik": 3, "revenue": None}, {"cik": 4, "revenue": 900}]
        self.assertEqual([c["cik"] for c in C.largest(cs, 2)], [2, 4])
        self.assertEqual([c["cik"] for c in C.largest(cs, 10)], [2, 4, 1])


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
