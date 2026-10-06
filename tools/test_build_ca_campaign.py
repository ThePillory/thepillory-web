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

CVR_COLS = ["FILING_ID", "AMEND_ID", "REC_TYPE", "FORM_TYPE", "FILER_ID", "ENTITY_CD", "FILER_NAML", "FROM_DATE", "THRU_DATE", "RPT_DATE", "CAND_NAML", "CAND_NAMF", "OFFICE_CD", "JURIS_CD", "DIST_NO", "SUP_OPP_CD"]
RCPT_COLS = ["FILING_ID", "AMEND_ID", "FORM_TYPE", "ENTITY_CD", "CTRIB_NAML", "CTRIB_NAMF", "CTRIB_EMP", "CTRIB_OCC", "RCPT_DATE", "AMOUNT", "CMTE_ID", "MEMO_CODE"]
S496_COLS = ["FILING_ID", "AMEND_ID", "FORM_TYPE", "AMOUNT", "EXP_DATE"]
SMRY_COLS = ["FILING_ID", "AMEND_ID", "LINE_ITEM", "REC_TYPE", "FORM_TYPE", "AMOUNT_A", "AMOUNT_B", "AMOUNT_C", "ELEC_DT"]


def tsv(cols, rows):
    return "\t".join(cols) + "\r\n" + "".join("\t".join(str(r.get(c, "")) for c in cols) + "\r\n" for r in rows)


def cover(fid, amend, filer, entity, committee, frm, thru, last, first, form="F460", office="", dist="", sup=""):
    return {"FILING_ID": fid, "AMEND_ID": amend, "REC_TYPE": "CVR", "FORM_TYPE": form, "FILER_ID": filer, "ENTITY_CD": entity, "FILER_NAML": committee,
            "FROM_DATE": f"{frm} 12:00:00 AM", "THRU_DATE": f"{thru} 12:00:00 AM", "RPT_DATE": f"{thru} 12:00:00 AM", "CAND_NAML": last, "CAND_NAMF": first,
            "OFFICE_CD": office, "JURIS_CD": office if office in ("ASM", "SEN") else ("STW" if office else ""), "DIST_NO": dist, "SUP_OPP_CD": sup}


def rcpt(fid, entity, last, first, emp, occ, day, amount, cmte="", memo="", form="A", amend="0"):
    return {"FILING_ID": fid, "AMEND_ID": amend, "FORM_TYPE": form, "ENTITY_CD": entity, "CTRIB_NAML": last, "CTRIB_NAMF": first, "CTRIB_EMP": emp,
            "CTRIB_OCC": occ, "RCPT_DATE": f"{day} 12:00:00 AM", "AMOUNT": amount, "CMTE_ID": cmte, "MEMO_CODE": memo}


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
            # Assembly District 8: the incumbent (district written "08"), a challenger, and an old 2023 candidate.
            cover("20", "0", "800", "CAO", "Ada Testassembly for Assembly 2026", "1/1/2026", "6/30/2026", "Testassembly", "Ada", office="ASM", dist="08"),
            cover("21", "0", "801", "CTL", "Ada Testassembly Officeholder", "1/1/2025", "6/30/2025", "Testassembly", "Ada", office="ASM", dist="8"),
            cover("22", "0", "802", "CAO", "Bo Challenger for Assembly", "1/1/2026", "6/30/2026", "Challenger", "Bo", office="ASM", dist="8"),
            cover("23", "0", "803", "CAO", "Old Candidate for Assembly", "1/1/2023", "6/30/2023", "Gone", "Old", office="ASM", dist="8"),
            # Form 496 independent expenditures: for and against the incumbent, one with no district, one for the Lt. Governor's race.
            cover("30", "0", "700", "RCP", "Example Jobs Coalition", "", "3/1/2026", "Ada Testassembly", "", form="F496", office="ASM", dist="8", sup="S"),
            cover("31", "0", "701", "RCP", "Example Taxpayers Group", "", "3/2/2026", "Testassembly", "Ada", form="F496", office="ASM", dist="08", sup="O"),
            cover("32", "0", "700", "RCP", "Example Jobs Coalition", "", "3/3/2026", "ADA TESTASSEMBLY", "", form="F496", office="ASM", sup="S"),
            cover("33", "0", "702", "RCP", "Example Statewide Fund", "", "3/4/2026", "Leo Testlieutenant", "", form="F496", office="LTG", sup="S"),
            # A namesake in a city race isn't the Lt. Governor.
            cover("34", "0", "703", "RCP", "City Fund", "", "3/5/2026", "Leo Testlieutenant", "", form="F496", office="CCM", sup="S"),
        ]
        smrys = [smry("1", "0", "5", "0"), smry("1", "0", "11", "228831.95"), smry("1", "0", "16", "2521988.33"),
                 smry("2", "0", "5", "1"), smry("2", "1", "5", "120500"), smry("2", "1", "11", "5500.19"), smry("2", "1", "16", "2757658.42"),
                 smry("1", "0", "12", "999"), smry("7", "0", "5", "78700.58"),
                 smry("20", "0", "5", "50000"), smry("20", "0", "11", "20000"), smry("21", "0", "5", "1000"), smry("22", "0", "5", "3000")]
        receipts = [
            # Individuals: only totals and employers come through. Three people at one employer.
            rcpt("20", "IND", "Doe", "Jane", "Example Hospital", "Nurse", "2/1/2026", "500"),
            rcpt("20", "IND", "Roe", "Rick", "EXAMPLE HOSPITAL.", "Doctor", "2/2/2026", "1500"),
            rcpt("20", "IND", "Poe", "Pat", "Example Hospital", "Nurse", "2/3/2026", "2500"),
            rcpt("20", "IND", "Moe", "Max", "Retired", "Retired", "2/4/2026", "100"),
            # An organization, a memo entry (left out), a transfer from her own officeholder committee (left out),
            # and a non-monetary contribution on Schedule C (left out).
            rcpt("20", "OTH", "Example Builders Inc", "", "", "", "2/5/2026", "4900"),
            rcpt("20", "COM", "Example Teachers Union PAC", "", "", "", "2/6/2026", "4900", cmte="1234"),
            rcpt("20", "IND", "Doe", "Jane", "Example Hospital", "Nurse", "2/7/2026", "999", memo="X"),
            rcpt("20", "COM", "Ada Testassembly Officeholder", "", "", "", "2/8/2026", "7000", cmte="801"),
            rcpt("20", "IND", "Doe", "Jane", "Example Hospital", "Nurse", "2/9/2026", "300", form="C"),
            # Refunds are negative rows: they net against totals and never show as negative.
            rcpt("20", "IND", "Zoe", "Zed", "Refunded Shop", "Owner", "2/10/2026", "-200"),
            rcpt("20", "COM", "Example Refunded PAC", "", "", "", "2/11/2026", "400"),
            rcpt("20", "COM", "Example Refunded PAC", "", "", "", "2/12/2026", "-400"),
            # The 2025 statement: the 2025-2026 period too.
            rcpt("21", "IND", "Doe", "Jane", "Example Hospital", "Nurse", "3/1/2025", "250"),
        ]
        s496 = [{"FILING_ID": "30", "AMEND_ID": "0", "FORM_TYPE": "F496", "AMOUNT": "12000", "EXP_DATE": "2/28/2026 12:00:00 AM"},
                {"FILING_ID": "31", "AMEND_ID": "0", "FORM_TYPE": "F496", "AMOUNT": "8000", "EXP_DATE": "3/1/2026 12:00:00 AM"},
                {"FILING_ID": "32", "AMEND_ID": "0", "FORM_TYPE": "F496", "AMOUNT": "3000", "EXP_DATE": "3/2/2026 12:00:00 AM"},
                {"FILING_ID": "33", "AMEND_ID": "0", "FORM_TYPE": "F496", "AMOUNT": "50000", "EXP_DATE": "3/3/2026 12:00:00 AM"},
                {"FILING_ID": "34", "AMEND_ID": "0", "FORM_TYPE": "F496", "AMOUNT": "999", "EXP_DATE": "3/4/2026 12:00:00 AM"}]
        self.dir = tempfile.TemporaryDirectory()
        self.zip = Path(self.dir.name) / "export.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr("CalAccess/DATA/CVR_CAMPAIGN_DISCLOSURE_CD.TSV", tsv(CVR_COLS, covers))
            z.writestr("CalAccess/DATA/SMRY_CD.TSV", tsv(SMRY_COLS, smrys))
            z.writestr("CalAccess/DATA/RCPT_CD.TSV", tsv(RCPT_COLS, receipts))
            z.writestr("CalAccess/DATA/S496_CD.TSV", tsv(S496_COLS, s496))
        self.officials = [
            {"office_key": "governor", "name": "Gloria Testgovernor"},
            {"office_key": "lieutenant-governor", "name": "Leo Q. Testlieutenant"},
            {"office_key": "controller", "name": "Nobody Hasfiled"},
        ]

    def tearDown(self):
        self.dir.cleanup()

    def test_statements(self):
        out = b.build(self.zip, self.officials)["officials"]
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

    def test_legislators_by_seat(self):
        seats = b.build(self.zip, self.officials)["seats"]
        names = [p["name"] for p in seats["ASM-8"]]
        self.assertEqual(sorted(names), ["Ada Testassembly", "Bo Challenger"], "the 2023-only candidate is left out")
        ada = next(p for p in seats["ASM-8"] if p["name"] == "Ada Testassembly")
        self.assertEqual(sorted(c["filer_id"] for c in ada["committees"]), ["800", "801"])
        c = ada["cycles"]["2025-2026"]
        self.assertEqual((c["raised"], c["spent"], c["statements"]), (51000.0, 20000.0, 2))
        # Individuals: totals and employers only, the memo entry, Schedule C and self-transfer left out.
        self.assertEqual(c["individuals"], {"total": 500 + 1500 + 2500 + 100 + 250 - 200.0, "count": 5})
        self.assertNotIn("REFUNDED SHOP", [e["employer"] for e in c["employers"]], "a refund alone isn't an employer")
        hospital = next(e for e in c["employers"] if e["employer"] == "EXAMPLE HOSPITAL")
        self.assertEqual((hospital["total"], hospital["count"], hospital["occupation"]), (4750.0, 4, "NURSE"))
        self.assertEqual([o["name"] for o in c["organizations"]], ["Example Builders Inc", "Example Teachers Union PAC"])
        self.assertEqual(c["organizations"][1]["kind"], "committee")
        text = str(c)
        for person in ("Doe", "Roe", "Poe", "Moe", "Zoe", "Jane", "Rick"):
            self.assertNotIn(person, text, "no individual's name anywhere")
        # Independent expenditures: by spender, for and against; the report without a district still found her.
        ie = {(x["spender"], x["support_oppose"]): x for x in c["ie"]}
        self.assertEqual(ie[("Example Jobs Coalition", "support")]["total"], 15000.0)
        self.assertEqual(ie[("Example Jobs Coalition", "support")]["filings"], 2)
        self.assertEqual(ie[("Example Taxpayers Group", "oppose")]["total"], 8000.0)
        self.assertEqual(ie[("Example Taxpayers Group", "oppose")]["race"], "State Assembly")

    def test_statewide_money(self):
        ltg = b.build(self.zip, self.officials)["officials"]["lieutenant-governor"]
        ie = ltg["cycles"]["2025-2026"]["ie"]
        self.assertEqual([(x["spender"], x["total"], x["race"]) for x in ie], [("Example Statewide Fund", 50000.0, "Lieutenant Governor")], "the city race namesake is left out")

    def test_finish_industries(self):
        import json, subprocess
        raw = {"source": "x", "export_modified": None, "generated": "2026-10-06", "since": "2023-01-01", **b.build(self.zip, self.officials)}
        path = Path(self.dir.name) / "raw.json"
        out = Path(self.dir.name) / "out.json"
        path.write_text(json.dumps(raw))
        subprocess.run(["node", str(Path(__file__).resolve().parent / "ca_campaign_finish.mjs"), str(path), str(out)], check=True, capture_output=True)
        doc = json.loads(out.read_text())
        c = next(p for p in doc["seats"]["ASM-8"] if p["name"] == "Ada Testassembly")["cycles"]["2025-2026"]
        self.assertEqual(c["employers"], [{"employer": "EXAMPLE HOSPITAL", "industry": "health", "total": 4750.0, "count": 4}])
        self.assertEqual(c["not_employed"], {"total": 100.0, "count": 1})
        inds = {i["industry"]: i["total"] for i in c["industries"]}
        self.assertEqual(inds["health"], 4750.0)
        self.assertEqual(inds["labor"], 4900.0)
        self.assertEqual(inds["construction"], 4900.0)

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
