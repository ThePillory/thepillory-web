// node workers/sync/test/disclosure.test.mjs
// Executive funding and disclosures: outside spenders, inaugural committees
// (Form 13), and OGE records. Fixtures follow the shape of real responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  donorsDisclosed, isPersonName, committeeTypes, pickInauguralCommittee, latestReports, parseForm13, form13Consistent,
  ogeRow, ogeNameMatches, nameParts, ogeKey,
} from "../src/funding/disclosure.js";

test("outside spenders: only non-committee filers (type I) are 'donors not disclosed'", () => {
  assert.equal(donorsDisclosed("I"), false);
  assert.equal(donorsDisclosed("O"), true); // super PAC
  assert.equal(donorsDisclosed("V"), true); // hybrid PAC
  assert.equal(donorsDisclosed(null), null);
  const rows = committeeTypes([{ committee_id: "C90000001", name: " Example Fund ", committee_type: "I", committee_type_full: "Independent expenditure filer (not a committee)" }, {}]);
  assert.deepEqual(rows.map((r) => [r.committee_id, r.name, r.committee_type]), [["C90000001", "Example Fund", "I"]]);
});

test("outside spenders: a person spending their own money isn't named", () => {
  assert.equal(isPersonName("DOE, JANE"), true);
  assert.equal(isPersonName("O'BRIEN, PAT Q."), true);
  assert.equal(isPersonName("EXAMPLE ACTION FUND, INC."), false);
  assert.equal(isPersonName("CITIZENS FOR EXAMPLE"), false);
  assert.equal(isPersonName("THE EXAMPLE CAUCUS DBA EXAMPLE VOTERS"), false);
});

test("inaugural: the committee that first filed in the 150 days before the term", () => {
  const results = [
    { committee_id: "C1", name: "EXAMPLE INAUGURAL COMMITTEE, INC.", first_file_date: "2024-11-15" },
    { committee_id: "C2", name: "58TH PRESIDENTIAL INAUGURAL COMMITTEE", first_file_date: "2016-11-29" },
    { committee_id: "C3", name: "INAUGURAL REUNION COMMITTEE", first_file_date: "2024-12-01" },
  ];
  assert.equal(pickInauguralCommittee(results, "2025-01-20").committee_id, "C1");
  assert.equal(pickInauguralCommittee(results, "2017-01-20").committee_id, "C2");
  assert.equal(pickInauguralCommittee(results, "2021-01-20"), null);
  assert.equal(pickInauguralCommittee(results, null), null);
});

test("inaugural: an amendment replaces the report it amends", () => {
  const filings = [
    { form_type: "F13", document_description: "POST INAUGURAL 2025", coverage_start_date: "2024-11-15", coverage_end_date: "2025-04-20", receipt_date: "2025-07-31T00:00:00", total_receipts: 100, amendment_indicator: "A", file_number: 2, pdf_url: "https://docquery.fec.gov/pdf/2.pdf", fec_url: "https://docquery.fec.gov/dcdev/posted/2.fec" },
    { form_type: "F13", document_description: "POST INAUGURAL 2025", coverage_start_date: "2024-11-15", coverage_end_date: "2025-04-20", receipt_date: "2025-08-07T00:00:00", total_receipts: 110, amendment_indicator: "A", file_number: 3, pdf_url: "https://docquery.fec.gov/pdf/3.pdf", fec_url: "https://docquery.fec.gov/dcdev/posted/3.fec" },
    { form_type: "F13", document_description: "POST INAUGURAL SUPPLEMENT 2025", coverage_start_date: "2025-04-21", coverage_end_date: "2025-07-19", receipt_date: "2025-08-07T00:00:00", total_receipts: 111, amendment_indicator: "A", file_number: 4, pdf_url: "https://docquery.fec.gov/pdf/4.pdf", fec_url: null },
    { form_type: "F3X", document_description: "not a Form 13", coverage_start_date: "2025-01-01" },
  ];
  const r = latestReports(filings);
  assert.deepEqual(r.map((x) => [x.report, x.file_number, x.total_receipts]), [["POST INAUGURAL 2025", "3", 110], ["POST INAUGURAL SUPPLEMENT 2025", "4", 111]]);
  assert.equal(r[0].fec_url, "https://docquery.fec.gov/dcdev/posted/3.fec");
});

test("inaugural: Form 13 donations summed; individuals never named, organizations by name", () => {
  const FS = "\x1c";
  // The layout the FEC posts (format 8.4): field 4 blank, the entity type in field 5.
  const line = (entity, org, last, first, date, amount) => ["F132", "C00000001", "F132.1", "", "", entity, org, last, first, "", "", "", "1 Main St", "", "City", "ST", "00000", date, amount.toFixed(2), amount.toFixed(2), "", ""].join(FS);
  const text = [
    ["HDR", "FEC", "8.5", "Software"].join(FS),
    ["F13", "C00000001", "EXAMPLE INAUGURAL COMMITTEE"].join(FS),
    line("IND", "", "DOE", "JANE", "20250110", 500),
    line("IND", "", "ROE", "RICHARD", "20250111", 1500),
    line("ORG", "EXAMPLE CORP", "", "", "20250112", 1000000),
    line("ORG", "EXAMPLE CORP", "", "", "20250113", 250000),
    line("ORG", "OTHER LLC", "", "", "20250114", 50000),
    line("ORG", "UNITEMIZED TOTAL", "", "", "20250115", 435.43),
    ["F132", "C00000001", "F132.9", "", "", "PAC", "EXAMPLE PAC", "", "", "", "", "", "", "", "", "", "", "20250116", "5000.00", "5000.00", "", ""].join(FS),
    ["F133", "C00000001", "F133.1", "", "", "ORG", "OTHER LLC", "", "", "", "", "", "", "", "", "", "", "20250201", "500.00", ""].join(FS),
  ].join("\r\n");
  const p = parseForm13(text);
  assert.deepEqual(p.individuals, { count: 2, total: 2000 });
  assert.deepEqual(p.organizations.map((o) => [o.name, o.total, o.count]), [["EXAMPLE CORP", 1250000, 2], ["OTHER LLC", 50000, 1], ["EXAMPLE PAC", 5000, 1]]);
  assert.deepEqual(p.refunds, { count: 1, total: 500 });
  assert.equal(p.other.total, 435.43);
  assert.equal(p.total, 1307435.43);
  // No individual's name anywhere in the result.
  assert.ok(!JSON.stringify(p).includes("DOE") && !JSON.stringify(p).includes("ROE"));
  assert.equal(form13Consistent(p, 1307435.43), true);
  assert.equal(form13Consistent(p, 2000000), false);
  assert.equal(form13Consistent(parseForm13(""), 100), false);
});

test("OGE: a linked document, a request-only record, and an amended one", () => {
  const pdf = ogeRow({
    type: "<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/ABC/$FILE/Doe%2C%20Jane%20finalEA.pdf'>Ethics Agreement</a>",
    name: "Doe, Jane Q", agency: "Department of Examples", title: "Secretary of Examples", level: "n/a", docDate: "2025-02-03T04:06:43", amended: "",
  });
  assert.equal(pdf.kind, "ethics");
  assert.equal(pdf.doc_type, "Ethics Agreement");
  assert.equal(pdf.added_on, "2025-02-03");
  assert.match(pdf.document_url, /^https:\/\/extapps2\.oge\.gov\/.*finalEA\.pdf$/);
  assert.equal(pdf.request_url, null);
  const req = ogeRow({ type: "278 Transaction (<a href='https://extapps2.oge.gov/201/Presiden.nsf/201%20Request?OpenForm&Filer=Doe'>Request this Document</a>)", name: "Doe, Jane Q", agency: "Department of Examples", title: "Secretary of Examples", docDate: "2026-03-06T04:30:54" });
  assert.equal(req.doc_type, "278 Transaction");
  assert.equal(req.kind, "financial");
  assert.equal(req.document_url, null);
  assert.match(req.request_url, /201%20Request\?OpenForm&Filer=Doe$/);
  const amended = ogeRow({ type: "<a href='https://extapps2.oge.gov/x.pdf'>Certification of Ethics Agreement Compliance</a> (Amended 01/15/2026)", name: "Doe, Jane Q", docDate: "2026-01-10T00:00:00" });
  assert.equal(amended.amended_on, "01/15/2026");
  assert.equal(amended.doc_type, "Certification of Ethics Agreement Compliance");
  assert.equal(amended.kind, "ethics");
  assert.notEqual(ogeKey(pdf), ogeKey(req));
  assert.equal(ogeRow({ type: "", name: "x" }), null);
});

test("OGE: names match by last name and first name, not by last name alone", () => {
  assert.deepEqual(nameParts("Robert F. Kennedy Jr."), { first: "robert", last: "kennedy" });
  assert.equal(ogeNameMatches("Kennedy, Robert F", "Robert F. Kennedy Jr."), true);
  assert.equal(ogeNameMatches("Kennedy, Joseph P", "Robert F. Kennedy Jr."), false);
  assert.equal(ogeNameMatches("Chavez-DeRemer, Lori", "Lori Chavez-DeRemer"), true);
  assert.equal(ogeNameMatches("Doe, Jane", "Jane Doe"), true);
  assert.equal(ogeNameMatches("Doe, Jan", "Janet Doe"), true); // first name abbreviated
  assert.equal(ogeNameMatches("Doe", "Jane Doe"), false);
  assert.equal(ogeNameMatches("Muñoz, José", "Jose Munoz"), true);
});

test("FPPC: a Form 700 is kept when the name and the office both match", async () => {
  const { fppcRows, fppcSearchBody, fppcPdfUrl, fppcParse } = await import("../src/funding/disclosure.js");
  const { fppcSearch } = await import("./executive-fixtures.mjs");
  assert.deepEqual(fppcSearchBody("Testgovernor").searchFieldQueryInfos[0], { queryField: "FilerLastName", queryType: "Exact Match", filterValue: "Testgovernor" });
  const docs = fppcParse(fppcSearch(fppcSearchBody("Testgovernor"))).documents;
  const rows = fppcRows(docs, { name: "Gloria Testgovernor", office: "Governor" });
  // Three statements filed as Governor; not the board-only one, not the namesake.
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.position === "Governor" && r.agency === "Governor"));
  assert.equal(rows[0].doc_type, "Form 700, Annual");
  assert.equal(rows[2].amended, true);
  assert.ok(rows[0].filed_on > rows[1].filed_on);
  // "State Controller" matches a position listed as "Controller", and the reverse.
  const ctl = fppcRows([{ indexID: "X", filer: { lastName: "Doe", firstName: "Jan" }, filingInfo: {}, filingPositions: [{ agency: "Controller", position: "Controller", filingType: "Annual", filingYear: 2025 }] }], { name: "Jan Doe", office: "State Controller" });
  assert.equal(ctl.length, 1);
  // A Lieutenant Governor's statement isn't the Governor's.
  assert.equal(fppcRows([{ indexID: "Y", filer: { lastName: "Doe", firstName: "Jan" }, filingInfo: {}, filingPositions: [{ agency: "Lieutenant Governor", position: "Lieutenant Governor" }] }], { name: "Jan Doe", office: "Governor" }).length, 0);
  const url = fppcPdfUrl(rows[0].index_id, rows[0].pdf);
  assert.match(url, /^https:\/\/form700search\.fppc\.ca\.gov\/Home\/GetRedactedFormPdf\?indexID=C5CCD568-/);
  assert.match(url, /fileNameInfo\.Position=Governor/);
  assert.deepEqual(fppcParse('{"documents":[]}'), { documents: [] });
});
