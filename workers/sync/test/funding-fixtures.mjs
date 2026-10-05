// FAKE campaign finance (FEC API) and lobbying (lda.gov) responses for tests.
// The JSON shapes copy the real APIs; every name, ID and amount is invented.

// The public crosswalk of member IDs (unitedstates.github.io): bioguide → FEC IDs.
// T000005 has none (as for a newly appointed senator); T000003's older ID comes second.
export const legislators = [
  ["T000001", ["S0CA00001"]],
  ["T000002", ["S0CA00002"]],
  ["T000003", ["H0CA77001", "H8CA00009"]],
  ["T000004", ["H0CA12001"]],
  ["T000005", []],
  ["T000006", ["H0AK00001"]],
].map(([bioguide, fec]) => ({ id: { bioguide, fec }, name: { official_full: "[Test member]" }, terms: [] }));

const committeeFor = { P00000001: "C00000009", S0CA00001: "C00000001", S0CA00002: "C00000002", H0CA77001: "C00000003", H0CA12001: "C00000004", H0AK00001: "C00000006" };

const CURRENT = ((y) => (y % 2 ? y + 1 : y))(new Date().getUTCFullYear());

const totals = (cand, cycle) => {
  const scale = cycle === CURRENT ? 1 : 0.6; // the earlier period raised less
  const base = { S0CA00001: 4000000, S0CA00002: 2500000, H0CA77001: 1200000, H0CA12001: 800000, H0AK00001: 300000 }[cand] * scale;
  return {
    candidate_id: cand,
    cycle,
    receipts: base,
    disbursements: Math.round(base * 0.8),
    last_cash_on_hand_end_period: Math.round(base * 0.4),
    individual_unitemized_contributions: Math.round(base * 0.2),
    individual_itemized_contributions: Math.round(base * 0.45),
    other_political_committee_contributions: Math.round(base * 0.25),
    political_party_committee_contributions: Math.round(base * 0.02),
    candidate_contribution: cand === "H0CA12001" ? 50000 : 0,
    loans_made_by_candidate: cand === "H0CA12001" ? 10000 : 0,
    coverage_end_date: cycle === CURRENT ? `${cycle}-06-30T00:00:00` : `${cycle}-12-31T00:00:00`,
    last_report_type_full: "JULY QUARTERLY",
    last_report_year: cycle,
  };
};

// PAC contributions (Schedule A, line 11C). The House member's list has 120 rows,
// so it takes two pages; one memo entry and one refund are included.
const PAC_NAMES = [
  ["C90000001", "EXAMPLE BANKERS PAC", "Q", null],
  ["C90000002", "EXAMPLE HOSPITAL ASSOCIATION PAC", "Q", null],
  ["C90000003", "TEST FARM BUREAU PAC", "Q", null],
  ["C90000004", "EXAMPLE ELECTRICAL WORKERS UNION PAC", "N", null],
  ["C90000005", "TEST REALTORS POLITICAL ACTION COMMITTEE", "Q", null],
  ["C90000006", "[TEST MEMBER] LEADERSHIP FUND", "Q", "D"],
  ["C90000007", "SAMPLE WIDGET CO PAC", "Q", null],
  ["C90000008", "EXAMPLE TELECOM CABLE PAC", "Q", null],
];
function pacRows(committee) {
  const n = committee === "C00000003" ? 120 : 12;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [id, name, type, designation] = PAC_NAMES[i % PAC_NAMES.length];
    rows.push({
      committee_id: committee,
      contributor_id: id,
      contributor_name: name,
      contributor: { committee_id: id, name, committee_type: type, designation },
      contribution_receipt_amount: 1000 + (i % PAC_NAMES.length) * 250,
      memo_code: null,
      entity_type: "COM",
    });
  }
  rows.push({ committee_id: committee, contributor_id: "C90000001", contributor_name: "EXAMPLE BANKERS PAC", contributor: { committee_type: "Q" }, contribution_receipt_amount: -500, memo_code: null });
  rows.push({ committee_id: committee, contributor_id: "C90000009", contributor_name: "MEMO ENTRY PAC", contributor: { committee_type: "Q" }, contribution_receipt_amount: 99999, memo_code: "X" });
  return rows.sort((a, b) => b.contribution_receipt_amount - a.contribution_receipt_amount);
}

const EMPLOYERS = [
  ["RETIRED", 90000, 300],
  ["NONE", 20000, 40],
  ["SELF EMPLOYED", 15000, 22],
  ["EXAMPLE REGIONAL MEDICAL CENTER", 12000, 6],
  ["TEST UNIVERSITY", 9000, 5],
  ["SAMPLE ALMOND GROWERS", 8000, 4],
  ["EXAMPLE CAPITAL PARTNERS", 7000, 3],
  ["ONE-PERSON CONSULTING LLC", 1500, 1],
];

const OUTSIDE = [
  ["C80000001", "EXAMPLE VOTERS ALLIANCE", "S", 150000, 12],
  ["C80000002", "TEST FUTURE FUND", "O", 220000, 20],
  ["C80000003", "SAMPLE CITIZENS COMMITTEE", "O", 40000, 3],
  // A group that files as a non-committee spender (donors not disclosed), and a person.
  ["C90000004", "EXAMPLE ISSUES FUND", "S", 90000, 4],
  ["C90000005", "DOE, JANE", "O", 12000, 2],
];
// FEC committee types of the spenders: O super PAC, V hybrid PAC, I non-committee spender.
const SPENDER_TYPES = { C80000001: "O", C80000002: "V", C80000003: "O", C90000004: "I", C90000005: "I" };

// The fake President's inaugural committee, its Form 13 reports, and the
// electronic report file (fields separated by \x1c, as the FEC posts them).
const thisYear = new Date().getUTCFullYear();
const termStart = `${thisYear - 1}-01-20`;
const INAUGURAL = { committee_id: "C00000999", name: "[TEST] EXAMPLE INAUGURAL COMMITTEE, INC.", committee_type: "X", first_file_date: `${thisYear - 2}-11-20`, last_file_date: `${thisYear - 1}-08-01` };
export function form13File() {
  const FS = "\x1c";
  const line = (entity, org, last, first, amount) => ["F132", "C00000999", `F132.${amount}`, "", "", entity, org, last, first, "", "", "", "1 TEST ST", "", "TESTVILLE", "CA", "90000", `${thisYear - 1}0110`, amount.toFixed(2), amount.toFixed(2), "", ""].join(FS);
  return [
    ["HDR", "FEC", "8.5", "Fixture"].join(FS),
    ["F13", "C00000999", "[TEST] EXAMPLE INAUGURAL COMMITTEE, INC."].join(FS),
    line("ORG", "EXAMPLE WIDGETS CORP", "", "", 1000000),
    line("ORG", "EXAMPLE WIDGETS CORP", "", "", 500000),
    line("ORG", "SAMPLE ENERGY LLC", "", "", 750000),
    line("ORG", "TEST BANK OF EXAMPLE", "", "", 250000),
    line("IND", "", "DOE", "JOHN", 100000),
    line("IND", "", "ROE", "JANE", 50000),
    line("IND", "", "POE", "SAM", 1000),
  ].join("\r\n");
}
const FILINGS = [
  { form_type: "F13", document_description: `POST INAUGURAL ${thisYear - 1}`, coverage_start_date: `${thisYear - 2}-11-20`, coverage_end_date: `${thisYear - 1}-04-20`, receipt_date: `${thisYear - 1}-04-20T00:00:00`, total_receipts: 2601000, amendment_indicator: "N", file_number: 9001, pdf_url: "https://docquery.fec.gov/pdf/test/9001.pdf", fec_url: "http://127.0.0.1:8788/fecfiles/9001.fec" },
  { form_type: "F13", document_description: `POST INAUGURAL SUPPLEMENT ${thisYear - 1}`, coverage_start_date: `${thisYear - 1}-04-21`, coverage_end_date: `${thisYear - 1}-07-19`, receipt_date: `${thisYear - 1}-08-01T00:00:00`, total_receipts: 2603000, amendment_indicator: "N", file_number: 9002, pdf_url: "https://docquery.fec.gov/pdf/test/9002.pdf", fec_url: null },
];

/** The FEC API: path without the version prefix, and the query. Null: 404. */
export function fec(path, q) {
  if (!q.get("api_key")) return { status: 403, body: { error: { code: "API_KEY_MISSING" } } };
  let m = /^\/candidate\/(\w+)\/committees\/$/.exec(path);
  if (m) {
    const id = committeeFor[m[1]];
    return { status: 200, body: { results: id ? [{ committee_id: id, name: `[TEST] COMMITTEE ${id}`, designation: "P" }] : [], pagination: { count: id ? 1 : 0, pages: 1 } } };
  }
  m = /^\/candidate\/(\w+)\/totals\/$/.exec(path);
  if (m) {
    const cycle = parseInt(q.get("cycle"), 10);
    // The Alaska member has no filings for the earlier period.
    if (m[1] === "H0AK00001" && cycle !== CURRENT) return { status: 200, body: { results: [], pagination: { count: 0, pages: 1 } } };
    return { status: 200, body: { results: [totals(m[1], cycle)], pagination: { count: 1, pages: 1 } } };
  }
  if (path === "/schedules/schedule_a/") {
    if (q.get("line_number") !== "F3-11C") return { status: 400, body: { message: "fixture: expected line 11C" } };
    const all = pacRows(q.get("committee_id"));
    const after = q.get("last_index");
    const start = after ? parseInt(after, 10) : 0;
    const per = parseInt(q.get("per_page") || "20", 10);
    const page = all.slice(start, start + per);
    return {
      status: 200,
      body: {
        results: page,
        pagination: { count: all.length, per_page: per, last_indexes: start + per < all.length ? { last_index: String(start + per), last_contribution_receipt_amount: String(page.at(-1).contribution_receipt_amount) } : null },
      },
    };
  }
  if (path === "/schedules/schedule_a/by_employer/") {
    return { status: 200, body: { results: EMPLOYERS.map(([employer, total, count]) => ({ employer, total, count, committee_id: q.get("committee_id"), cycle: +q.get("cycle") })), pagination: { count: EMPLOYERS.length, page: 1, pages: 1 } } };
  }
  if (path === "/schedules/schedule_e/by_candidate/") {
    const cand = q.get("candidate_id");
    const rows = cand === "H0CA77001" || cand === "S0CA00001" || cand === "P00000001" ? OUTSIDE : [];
    return { status: 200, body: { results: rows.map(([committee_id, committee_name, support_oppose_indicator, total, count]) => ({ candidate_id: cand, committee_id, committee_name, support_oppose_indicator, total, count, cycle: +q.get("cycle") })), pagination: { count: rows.length, page: 1, pages: 1 } } };
  }
  if (path === "/committees/") {
    if (q.get("q") === "inaugural") return { status: 200, body: { results: [INAUGURAL, { committee_id: "C00000998", name: "OLD INAUGURAL COMMITTEE", committee_type: "X", first_file_date: "2000-12-01" }], pagination: { count: 2, pages: 1 } } };
    const ids = q.getAll("committee_id");
    return { status: 200, body: { results: ids.filter((id) => SPENDER_TYPES[id]).map((id) => ({ committee_id: id, name: (OUTSIDE.find((o) => o[0] === id) || [])[1], committee_type: SPENDER_TYPES[id], committee_type_full: SPENDER_TYPES[id] === "I" ? "Independent expenditure filer (not a committee)" : "Super PAC (Independent Expenditure-Only)" })), pagination: { count: ids.length, pages: 1 } } };
  }
  if (path === "/filings/" && q.get("committee_id") === "C00000999") return { status: 200, body: { results: FILINGS, pagination: { count: FILINGS.length, pages: 1 } } };
  return null;
}

// ---------------------------------------------------------------------------
// Office of Government Ethics: the disclosure search API (DataTables JSON).
const OGE_ROWS = [
  ["Presidente, Testa Q", "Office of the President", "President", "<a href='https://extapps2.oge.gov/test/presidente-278e.pdf'>Annual (OGE 278e)</a>", `${thisYear}-05-15T04:00:00`],
  ["Vicepresidente, Vicky", "Office of the Vice President", "Vice President", "<a href='https://extapps2.oge.gov/test/vicepresidente-278e.pdf'>Annual (OGE 278e)</a>", `${thisYear}-05-16T04:00:00`],
  ["Testsecretary, Alex", "Department of State", "Secretary of State", "<a href='https://extapps2.oge.gov/test/testsecretary-ea.pdf'>Ethics Agreement</a>", `${thisYear - 1}-01-10T04:00:00`],
  ["Testsecretary, Alex", "Department of State", "Secretary of State", "<a href='https://extapps2.oge.gov/test/testsecretary-nominee.pdf'>Nominee (OGE 278e)</a>", `${thisYear - 1}-01-10T04:00:00`],
  ["Testsecretary, Alex", "Department of State", "Secretary of State", "<a href='https://extapps2.oge.gov/test/testsecretary-cert.pdf'>Certification of Ethics Agreement Compliance</a> (Amended 03/02/" + thisYear + ")", `${thisYear - 1}-04-01T04:00:00`],
  ["Testsecretary, Alex", "Department of State", "Secretary of State", "278 Transaction (<a href='https://extapps2.oge.gov/201/Presiden.nsf/201%20Request?OpenForm&Filer=Testsecretary'>Request this Document</a>)", `${thisYear}-02-01T04:00:00`],
  // A different person with the same last name: not matched.
  ["Testsecretary, Morgan", "Department of Examples", "Deputy Assistant Secretary", "<a href='https://extapps2.oge.gov/test/other.pdf'>Nominee (OGE 278e)</a>", `${thisYear - 3}-06-01T04:00:00`],
];
export function oge(q) {
  const term = String(q.get("search[value]") || "").toLowerCase();
  const rows = OGE_ROWS.filter((r) => !term || r.join(" ").toLowerCase().includes(term));
  const start = parseInt(q.get("start") || "0", 10);
  const length = parseInt(q.get("length") || "10", 10);
  return {
    draw: parseInt(q.get("draw") || "0", 10),
    recordsTotal: OGE_ROWS.length,
    recordsFiltered: rows.length,
    data: rows.slice(start, start + length).map(([name, agency, title, type, docDate]) => ({ type, name, agency, title, level: "n/a", docDate, amended: "" })),
  };
}

// ---------------------------------------------------------------------------
// lda.gov

const filing = (n, client, description, desc, income, extra = {}) => ({
  url: `https://lda.example/api/v1/filings/f${n}/`,
  filing_uuid: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  filing_type: "Q1",
  filing_year: 2025,
  filing_period: "first_quarter",
  filing_period_display: "1st Quarter (Jan 1 - Mar 31)",
  filing_document_url: `https://lda.example/filings/public/filing/f${n}/print/`,
  income: income == null ? null : String(income),
  expenses: null,
  dt_posted: "2025-04-15T12:00:00-04:00",
  registrant: { id: 500 + n, name: `[TEST LOBBYING FIRM ${n}]` },
  client: { id: 900 + (extra.client_id || n), name: client, general_description: description },
  lobbying_activities: [{ general_issue_code: "TEC", description: desc }],
  ...extra,
});

// 27 reports for "H.R. 10" in 2025 (two pages of 25): 3 that mention this
// Congress's H.R. 10, and 24 that the checks set aside.
const HR10 = [
  filing(1, "EXAMPLE RURAL BROADBAND ASSOCIATION", "Telecommunications trade association", "H.R. 10, Test Bill Ten Act - grants for rural broadband and state scoring rules.", 40000),
  filing(2, "TEST FARM BUREAU", "Agriculture", "Rural connectivity; support for H.R. 10 (Test Bill Ten Act).", 25000),
  filing(3, "EXAMPLE CAPITAL BANK", "Banking", "Broadband finance provisions in H.R.10.", null, { expenses: "120000.00", income: null }),
  filing(4, "SAMPLE OLDER BILL COALITION", "Advocacy", "Reintroduction of the 118th Congress H.R. 10.", 10000),
  filing(5, "SAMPLE DIFFERENT TITLE GROUP", "Advocacy", "H.R. 10, Unrelated Widgets Modernization Act.", 10000),
  ...Array.from({ length: 22 }, (_, i) => filing(10 + i, `EXAMPLE NEAR MISS ${i}`, "Advocacy", `Issues related to H.R. 100${i} and appropriations.`, 5000)),
];

export function lda(path, q) {
  if (path !== "/filings/") return null;
  const phrase = String(q.get("filing_specific_lobbying_issues") || "").replace(/"/g, "");
  const year = parseInt(q.get("filing_year"), 10);
  const page = parseInt(q.get("page") || "1", 10);
  const size = Math.min(25, parseInt(q.get("page_size") || "25", 10));
  let all = [];
  if (year === 2025 && phrase === "H.R. 10") all = HR10.filter((f) => f.filing_uuid !== HR10[2].filing_uuid);
  if (year === 2025 && phrase === "H.R.10") all = [HR10[2]];
  const results = all.slice((page - 1) * size, page * size);
  const next = page * size < all.length ? `https://lda.example/api/v1/filings/?page=${page + 1}` : null;
  return { status: 200, body: { count: all.length, next, previous: null, results } };
}
