#!/usr/bin/env python3
"""Tests for tools/build_ca_campaign.py with a tiny fake Cal-Access export.

    python3 tools/test_build_ca_campaign.py

Standard library only. Every name and number here is invented.
"""
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ca_campaign as b  # noqa: E402

CVR_COLS = ["FILING_ID", "AMEND_ID", "REC_TYPE", "FORM_TYPE", "FILER_ID", "ENTITY_CD", "FILER_NAML", "FROM_DATE", "THRU_DATE", "RPT_DATE", "CAND_NAML", "CAND_NAMF"]
SMRY_COLS = ["FILING_ID", "AMEND_ID", "LINE_ITEM", "REC_TYPE", "FORM_TYPE", "AMOUNT_A", "AMOUNT_B", "AMOUNT_C", "ELEC_DT"]


def tsv(cols, rows):
    return "\t".join(cols) + "\r\n" + "".join("\t".join(str(r.get(c, "")) for c in cols) + "\r\n" for r in rows)


def cover(fid, amend, filer, entity, committee, frm, thru, last, first, form="F460"):
    return {"FILING_ID": fid, "AMEND_ID": amend, "REC_TYPE": "CVR", "FORM_TYPE": form, "FILER_ID": filer, "ENTITY_CD": entity, "FILER_NAML": committee,
            "FROM_DATE": f"{frm} 12:00:00 AM", "THRU_DATE": f"{thru} 12:00:00 AM", "RPT_DATE": f"{thru} 12:00:00 AM", "CAND_NAML": last, "CAND_NAMF": first}


def smry(fid, amend, line, amount, form="F460"):
    return {"FILING_ID": fid, "AMEND_ID": amend, "LINE_ITEM": line, "REC_TYPE": "SMRY", "FORM_TYPE": form, "AMOUNT_A": amount}


class Build(unittest.TestCase):
    def setUp(self):
        covers = [
            cover("1", "0", "900", "CTL", "Testgovernor for Governor 2022", "1/1/2026", "6/30/2026", "TESTGOVERNOR", "GLORIA"),
            # Filing 2: the amendment (1) replaces the original (0).
            cover("2", "0", "900", "CTL", "Testgovernor for Governor 2022", "7/1/2025", "12/31/2025", "Testgovernor", "Gloria"),
            cover("2", "1", "900", "CTL", "Testgovernor for Governor 2022", "7/1/2025", "12/31/2025", "Testgovernor", "Gloria"),
            # Before 2023: left out.
            cover("3", "0", "900", "CTL", "Testgovernor for Governor 2022", "1/1/2022", "6/30/2022", "Testgovernor", "Gloria"),
            # A namesake with another first name, a non-candidate committee, and another form: left out.
            cover("4", "0", "901", "CTL", "Harriet Testgovernor for Council", "1/1/2026", "6/30/2026", "Testgovernor", "Harriet"),
            cover("5", "0", "902", "RCP", "Friends of Testgovernor", "1/1/2026", "6/30/2026", "Testgovernor", "Gloria"),
            cover("6", "0", "900", "CTL", "Testgovernor for Governor 2022", "1/1/2026", "6/30/2026", "Testgovernor", "Gloria", form="F450"),
            # A middle initial in the file, "Leo Q. Testlieutenant".
            cover("7", "0", "910", "CAO", "Leo Testlieutenant for Lt. Governor 2026", "7/1/2026", "9/19/2026", "Testlieutenant", "Leo Q."),
        ]
        smrys = [smry("1", "0", "5", "0"), smry("1", "0", "11", "228831.95"), smry("1", "0", "16", "2521988.33"),
                 smry("2", "0", "5", "1"), smry("2", "1", "5", "120500"), smry("2", "1", "11", "5500.19"), smry("2", "1", "16", "2757658.42"),
                 smry("1", "0", "12", "999"), smry("7", "0", "5", "78700.58")]
        self.dir = tempfile.TemporaryDirectory()
        self.zip = Path(self.dir.name) / "export.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr("CalAccess/DATA/CVR_CAMPAIGN_DISCLOSURE_CD.TSV", tsv(CVR_COLS, covers))
            z.writestr("CalAccess/DATA/SMRY_CD.TSV", tsv(SMRY_COLS, smrys))
        self.officials = [
            {"office_key": "governor", "name": "Gloria Testgovernor"},
            {"office_key": "lieutenant-governor", "name": "Leo Q. Testlieutenant"},
            {"office_key": "controller", "name": "Nobody Hasfiled"},
        ]

    def tearDown(self):
        self.dir.cleanup()

    def test_statements(self):
        out = b.build(self.zip, self.officials)
        gov = out["governor"]["committees"]
        self.assertEqual([c["filer_id"] for c in gov], ["900"])
        reports = gov[0]["reports"]
        self.assertEqual([(r["filing_id"], r["amend_id"]) for r in reports], [("1", 0), ("2", 1)])
        self.assertEqual(reports[0], {
            "filing_id": "1", "amend_id": 0, "from": "2026-01-01", "thru": "2026-06-30", "filed": "2026-06-30",
            "contributions": 0.0, "expenditures": 228831.95, "cash_end": 2521988.33,
            "source_url": "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=1&amendid=0",
        })
        self.assertEqual(reports[1]["contributions"], 120500.0)  # the amendment's figure, not the original's
        self.assertEqual(gov[0]["source_url"], "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=900")
        ltg = out["lieutenant-governor"]["committees"]
        self.assertEqual([(c["filer_id"], len(c["reports"])) for c in ltg], [("910", 1)])
        self.assertEqual(ltg[0]["reports"][0]["contributions"], 78700.58)
        self.assertEqual(ltg[0]["reports"][0]["expenditures"], None)  # not reported: left empty, not zero
        self.assertEqual(out["controller"]["committees"], [])

    def test_names(self):
        self.assertEqual(b.name_parts("Shirley N. Weber"), ("shirley", "weber"))
        self.assertEqual(b.name_parts("Robert Smith Jr."), ("robert", "smith"))
        self.assertTrue(b.first_matches("tony", "tony"))
        self.assertTrue(b.first_matches("rob", "robert"))
        self.assertFalse(b.first_matches("harriet", "gloria"))
        self.assertEqual(b.iso("1/22/2000 12:00:00 AM"), "2000-01-22")
        self.assertIsNone(b.iso(""))


if __name__ == "__main__":
    unittest.main()
