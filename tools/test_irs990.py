#!/usr/bin/env python3
"""Tests for tools/irs990.py and the SQL tools/load_nonprofits.py writes. The XML is a FAKE return shaped like the IRS's e-file schema."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import irs990  # noqa: E402
import load_nonprofits as L  # noqa: E402

RETURN = """<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile" returnVersion="2024v5.0">
  <ReturnHeader>
    <TaxPeriodEndDt>2024-12-31</TaxPeriodEndDt>
    <PreparerFirmGrp><PreparerFirmName><BusinessNameLine1Txt>EXAMPLE ACCOUNTANTS LLP</BusinessNameLine1Txt></PreparerFirmName></PreparerFirmGrp>
    <ReturnTypeCd>990</ReturnTypeCd>
    <Filer><EIN>000000001</EIN><BusinessName><BusinessNameLine1Txt>EXAMPLE SOCIAL WELFARE FUND</BusinessNameLine1Txt></BusinessName></Filer>
    <TaxYr>2024</TaxYr>
  </ReturnHeader>
  <ReturnData>
    <IRS990><PoliticalCampaignActyInd>1</PoliticalCampaignActyInd><CYTotalRevenueAmt>1000000</CYTotalRevenueAmt><CYTotalExpensesAmt>900000</CYTotalExpensesAmt></IRS990>
    <IRS990ScheduleC>
      <PoliticalExpendituresAmt>250000</PoliticalExpendituresAmt>
      <Section527PoliticalOrgGrp><OrganizationBusinessName><BusinessNameLine1Txt>EXAMPLE  ACTION FUND</BusinessNameLine1Txt></OrganizationBusinessName><EIN>000000002</EIN><PaidInternalFundsAmt>200000</PaidInternalFundsAmt></Section527PoliticalOrgGrp>
    </IRS990ScheduleC>
  </ReturnData>
</Return>"""


class Read(unittest.TestCase):
    def test_figures_as_filed(self):
        r = irs990.read_return(RETURN)
        self.assertEqual(r["name"], "EXAMPLE SOCIAL WELFARE FUND")  # the filer, not the preparer
        self.assertEqual((r["return_type"], r["tax_year"], r["period_end"]), ("990", 2024, "2024-12-31"))
        self.assertEqual((r["revenue"], r["expenses"], r["political"]), (1000000.0, 900000.0, 250000.0))
        self.assertTrue(r["schedule_c"])
        self.assertEqual(r["recipients"], [{"name": "EXAMPLE ACTION FUND", "ein": "000000002", "amount": 200000.0}])

    def test_no_schedule_c(self):
        x = RETURN.split("<IRS990ScheduleC>")[0] + RETURN.split("</IRS990ScheduleC>")[1]
        r = irs990.read_return(x)
        self.assertFalse(r["schedule_c"])
        self.assertIsNone(r["political"])
        self.assertEqual(r["recipients"], [])


class Sql(unittest.TestCase):
    def test_writes_what_was_read(self):
        got = irs990.read_return(RETURN)
        sql = L.sql_for("1", {"OBJECT_ID": "202500000000000001"}, got)
        self.assertIn("political_read = 'schedule_c'", sql)
        self.assertIn("political = 250000,", sql)
        self.assertIn("https://projects.propublica.org/nonprofits/organizations/1/202500000000000001/full", sql)
        self.assertIn(json.dumps([{"name": "EXAMPLE ACTION FUND", "ein": "000000002", "amount": 200000.0}]).replace("'", "''"), sql)

    def test_not_found_stays_a_link(self):
        self.assertIn("political_read = 'not_read'", L.sql_for("1", None, None))


if __name__ == "__main__":
    unittest.main()
