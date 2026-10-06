// FAKE responses for the executive branch, shaped like the real ones
// (congress-legislators' executive.json, whitehouse.gov's Cabinet page, the
// Federal Register API, Congress.gov actions and nominations, leginfo's bill
// history, gov.ca.gov's feed and posts). Every name and number is invented.

const thisYear = new Date().getUTCFullYear();
const termStart = `${thisYear - 1}-01-20`;
const termEnd = `${thisYear + 3}-01-20`;

export const executive = [
  {
    id: { govtrack: 900001, fec: ["P00000001"] },
    name: { first: "Testa", middle: "Q.", last: "Presidente" },
    terms: [
      { type: "prez", start: "2001-01-20", end: "2005-01-20", party: "Example Party", how: "election" },
      { type: "prez", start: termStart, end: termEnd, party: "Example Party", how: "election" },
    ],
  },
  {
    id: { govtrack: 900002, bioguide: "T000002", fec: ["S0CA00002"] },
    name: { first: "Vicky", last: "Vicepresidente", official_full: "Vicky Vicepresidente" },
    terms: [{ type: "viceprez", start: termStart, end: termEnd, party: "Example Party", how: "election" }],
  },
  {
    id: { govtrack: 900003 },
    name: { first: "Former", last: "Presidentperson" },
    terms: [{ type: "prez", start: "2005-01-20", end: termStart, party: "Sample Party", how: "election" }],
  },
];

const member = (name, title) => `
<div class="wp-block-group"><h2 class="wp-block-heading has-text-align-center"><strong>${name}</strong></h2>

<hr class="wp-block-separator has-alpha-channel-opacity" />

<h3 class="wp-block-heading has-text-align-center"><strong>${title}</strong></h3></div>
<p>[FAKE TEST BIO] ${name} served in many roles. This is not a title.</p>`;

export const cabinetHtml = `<html><body><header><h2>Menu</h2></header><main><h1>The Cabinet</h1>
${[
  ["Alex Testsecretary", "Secretary of State"],
  ["Blair Example", "Secretary of the Treasury"],
  ["Casey Sample", "Attorney General"],
  ["Devon Fakename", "Secretary of the Interior"],
  ["Emery Placeholder", "Secretary of Agriculture"],
  ["Finley Testcase", "Secretary of Commerce"],
  ["Gray Mockperson", "Secretary of Labor"],
  ["Harper Dummy", "Director of the Office of Management and Budget"],
  ["Indigo Notreal", "Administrator of the Environmental Protection Agency"],
].map(([n, t]) => member(n, t)).join("\n")}
</main><footer><h2 class="wp-block-whitehouse-footer__menu-heading">About</h2><h3>Subscribe to the newsletter</h3></footer></body></html>`;

// Federal Register: executive orders for the fake president, newest first.
export function fr(q) {
  if (q.get("conditions[president][]") !== "testa-presidente") return { count: 0, results: [], next_page_url: null };
  const doc = (n, day, title) => ({
    executive_order_number: n,
    title,
    signing_date: `${thisYear}-03-${day}`,
    publication_date: `${thisYear}-03-${String(Number(day) + 3).padStart(2, "0")}`,
    document_number: `${thisYear}-0${n}`,
    html_url: `https://www.federalregister.gov/documents/${thisYear}/03/${day}/${thisYear}-0${n}/test-order-${n}`,
    pdf_url: `https://www.govinfo.gov/content/pkg/FR-TEST/pdf/${thisYear}-0${n}.pdf`,
    citation: `91 FR ${1000 + n}`,
  });
  return { count: 2, results: [doc(99902, "12", "Testing the Federal Register Reader [FAKE]"), doc(99901, "05", "Establishing a Test Order &amp; Its Title [FAKE]")], next_page_url: null };
}

// Congress.gov: the bill list (updated bills), each bill's actions, nominations.
const la = (actionDate, text) => ({ actionDate, text });
export const congressExec = {
  "/bill/119": {
    bills: [
      { congress: 119, type: "HR", number: "10", title: "Test Bill Ten Act", latestAction: la("2025-09-20", "Became Public Law No: 119-99.") },
      { congress: 119, type: "HR", number: "20", title: "Test Bill Twenty Act of 2026 ($1 test)", latestAction: la("2025-10-01", "Vetoed by President.") },
      { congress: 119, type: "S", number: "30", title: "Test Senate Bill Thirty", latestAction: la("2025-10-02", "Presented to President.") },
      { congress: 119, type: "HR", number: "50", title: "Test Voice Vote Law Act", latestAction: la("2025-08-01", "Became Public Law No: 119-88.") },
      { congress: 119, type: "HRES", number: "5", title: "A resolution", latestAction: la("2025-03-01", "Resolution agreed to in House.") },
      { congress: 119, type: "HR", number: "77", title: "Test Referred Bill", latestAction: la("2025-02-01", "Referred to the Committee on Testing.") },
    ],
    pagination: { count: 6 },
  },
  "/bill/119/hr/10/actions": {
    actions: [
      { actionCode: "E40000", actionDate: "2025-09-20", text: "Became Public Law No: 119-99.", type: "President" },
      { actionCode: "36000", actionDate: "2025-09-20", text: "Became Public Law No: 119-99.", type: "BecameLaw" },
      { actionCode: "E30000", actionDate: "2025-09-20", text: "Signed by President.", type: "President" },
      { actionCode: "28000", actionDate: "2025-09-15", text: "Presented to President.", type: "President" },
      { actionCode: "H8D000", actionDate: "2025-06-01", text: "On passage Passed by the Yeas and Nays: 300 - 120.", type: "Floor" },
    ],
  },
  "/bill/119/hr/20/actions": {
    actions: [
      { actionDate: "2025-10-03", text: "Veto message received in House.", type: "Veto" },
      { actionDate: "2025-10-01", text: "Vetoed by President.", type: "Veto" },
      { actionDate: "2025-09-25", text: "Presented to President.", type: "President" },
    ],
  },
  "/bill/119/s/30/actions": { actions: [{ actionDate: "2025-10-02", text: "Presented to President.", type: "President" }] },
  "/bill/119/hr/50/actions": {
    actions: [
      { actionDate: "2025-08-01", text: "Became Public Law No: 119-88.", type: "BecameLaw" },
      { actionDate: "2025-08-01", text: "Signed by President.", type: "President" },
      { actionDate: "2025-07-28", text: "Presented to President.", type: "President" },
    ],
  },
  "/nomination/119": {
    nominations: [
      {
        citation: "PN9001", congress: 119, number: 9001, partNumber: "00", nominationType: { isCivilian: true },
        description: "Pat Nominee, of California, to be an Assistant Secretary of Testing, vice Old Holder, resigned. [FAKE]",
        organization: "Department of Testing", receivedDate: `${thisYear}-02-10`,
        latestAction: { actionDate: `${thisYear}-04-01`, text: "Confirmed by the Senate by Voice Vote." },
      },
      {
        citation: "PN9002", congress: 119, number: 9002, partNumber: "00", nominationType: { isCivilian: true },
        description: "Robin Candidate, of Oregon, to be Ambassador to Exampleland. [FAKE]",
        organization: "Department of State", receivedDate: `${thisYear}-03-15`,
        latestAction: { actionDate: `${thisYear}-03-16`, text: "Received in the Senate and referred to the Committee on Foreign Relations." },
      },
      {
        citation: "PN9003", congress: 119, number: 9003, partNumber: "00", nominationType: { isCivilian: false, isMilitary: true },
        description: "The following named officers for appointment in the Test Army. [FAKE]",
        organization: "Army", receivedDate: `${thisYear}-03-01`, latestAction: { actionDate: `${thisYear}-03-02`, text: "Confirmed by the Senate." },
      },
    ],
    pagination: { count: 3 },
  },
};

// leginfo: bill history, newest first, as the real table lays it out.
const row = (d, a) => `
                                        <tr>
                                            <td class="columnField" style="text-align:left">${d}</td>
                                            <td class="columnField" style="text-align:left">${a}</td>
                                        </tr>`;
const history = (rows) => `<html><body><div id="header">nav</div><table id="billhistory" width="100%"><thead><tr><th>Date</th><th>Action</th></tr></thead><tbody>${rows.map(([d, a]) => row(d, a)).join("")}
</tbody></table></body></html>`;
export const leginfoHistory = {
  "202520260AB101": history([
    ["09/30/25", "Chaptered by Secretary of State - Chapter 321, Statutes of 2025."],
    ["09/30/25", "Approved by the Governor."],
    ["09/10/25", "Enrolled and presented to the Governor at  3 p.m."],
    ["08/30/25", "Read third time. Passed. Ordered to the Assembly. (Ayes 30. Noes 9. Page 2000.)."],
  ]),
};

// California state executive offices, as data/state-executive-officials.json.
export const stateExecutiveFile = {
  officials: [
    { office_key: "governor", rank: 1, office: "Governor", name: "Gloria Testgovernor", term_start: "2019-01-07", term_end: "2027-01-04", source_url: "https://example.org/ca/governor", last_verified: "2026-10-01" },
    { office_key: "lieutenant-governor", rank: 2, office: "Lieutenant Governor", name: "Leo Testlieutenant", source_url: "https://example.org/ca/ltg", last_verified: "2026-10-01" },
    { office_key: "controller", rank: 5, office: "State Controller", name: "", source_url: "", last_verified: "" },
  ],
};

// gov.ca.gov: the "Executive orders" feed (two pages, then empty) and posts.
const item = (p, title, day, slug) => `<item>
		<title>${title}</title>
		<link>http://127.0.0.1:8788/govca/${thisYear}/09/${day}/${slug}/</link>
		<pubDate>Fri, ${day} Sep ${thisYear} 15:08:17 +0000</pubDate>
		<category><![CDATA[Executive orders]]></category>
		<guid isPermaLink="false">https://www.gov.ca.gov/?p=${p}</guid>
		<description><![CDATA[<p>[FAKE]</p>]]></description>
	</item>`;
export function govFeed(page) {
  if (page === 1) return `<?xml version="1.0"?><rss><channel><title>Executive orders</title>${item(1001, "Governor issues executive order on test readiness [FAKE]", "18", "eo-test")}${item(1002, "Governor proclaims state of emergency in Test County [FAKE]", "11", "proclamation-test")}</channel></rss>`;
  if (page === 2) return `<?xml version="1.0"?><rss><channel><title>Executive orders</title>${item(1003, "Governor announces test appointments [FAKE]", "02", "other-test")}</channel></rss>`;
  return `<?xml version="1.0"?><rss><channel><title>Executive orders</title></channel></rss>`;
}
export const govPosts = {
  "eo-test": `<html><body><p>[FAKE] Read the executive order <a href="https://www.gov.ca.gov/wp-content/uploads/${thisYear}/09/FINAL-N-9-26-TEST-EO-SIGNED.pdf">here</a>.</p></body></html>`,
  "proclamation-test": `<html><body><p>[FAKE] <a href="https://www.gov.ca.gov/wp-content/uploads/${thisYear}/09/Test-County-SOE-Proclamation.pdf">Proclamation</a></p></body></html>`,
  "other-test": `<html><body><p>[FAKE] No document.</p></body></html>`,
};

// data/ca-campaign.json, as tools/build_ca_campaign.py writes it from the Cal-Access export.
export const caCampaignFile = {
  _readme: "FAKE TEST DATA",
  source: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
  export_modified: "Mon, 05 Oct 2026 08:54:52 GMT",
  generated: "2026-10-05",
  officials: {
    governor: {
      name: "Gloria Testgovernor",
      committees: [
        {
          filer_id: "9000001", name: "Testgovernor for Governor 2022 [FAKE]", source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=9000001",
          reports: [
            { filing_id: "8000002", amend_id: 0, from: `${thisYear}-01-01`, thru: `${thisYear}-06-30`, filed: `${thisYear}-07-31`, contributions: 0, expenditures: 228831.95, cash_end: 2521988.33, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=8000002&amendid=0" },
            { filing_id: "8000001", amend_id: 1, from: `${thisYear - 1}-07-01`, thru: `${thisYear - 1}-12-31`, filed: `${thisYear}-02-02`, contributions: 120500, expenditures: 5500.19, cash_end: 2757658.42, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=8000001&amendid=1" },
          ],
        },
      ],
    },
    "lieutenant-governor": { name: "Leo Testlieutenant", committees: [] },
  },
  seats: {
    // Test Assemblymember Delta (Assembly District 99 in the Open States fixture) and a challenger.
    "ASM-99": [
      {
        name: "Test Assemblymember Delta",
        committees: [{ filer_id: "9000099", name: "Delta for Assembly 2026 [FAKE]", source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=9000099",
          reports: [{ filing_id: "8000099", amend_id: 0, from: `${thisYear}-01-01`, thru: `${thisYear}-06-30`, filed: `${thisYear}-07-31`, contributions: 51000, expenditures: 20000, cash_end: 31000, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=8000099&amendid=0" }] }],
        cycles: {},
      },
      { name: "Bo Challenger", committees: [], cycles: {} },
    ],
  },
};
const fakeCycle = {
  raised: 51000, spent: 20000, statements: 1,
  individuals: { total: 4850, count: 5 }, not_employed: { total: 100, count: 1 },
  industries: [{ industry: "labor", total: 4900 }, { industry: "health", total: 4750 }, { industry: "other", total: 900 }],
  employers: [{ employer: "EXAMPLE HOSPITAL [FAKE]", industry: "health", total: 4750, count: 4 }],
  organizations: [{ name: "Example Teachers Union PAC [FAKE]", kind: "committee", industry: "labor", total: 4900, count: 1, filer_id: "1234" }],
  ie: [
    { spender: "Example Jobs Coalition [FAKE]", filer_id: "700", support_oppose: "support", race: "State Assembly", total: 15000, filings: 2, first: `${thisYear}-02-28`, last: `${thisYear}-03-02`, source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=700" },
    { spender: "Example Taxpayers Group [FAKE]", filer_id: "701", support_oppose: "oppose", race: "State Assembly", total: 8000, filings: 1, first: `${thisYear}-03-01`, last: `${thisYear}-03-01`, source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=701" },
  ],
};
const cycleName = `${thisYear - (thisYear % 2 ? 0 : 1)}-${thisYear + (thisYear % 2)}`;
caCampaignFile.seats["ASM-99"][0].cycles[cycleName] = fakeCycle;
caCampaignFile.officials.governor.cycles = { [cycleName]: { ...fakeCycle, raised: 120500, spent: 234332.14, statements: 2, ie: [] } };

// The FPPC's Form 700 search (/Home/SearchDocuments, answered as a JSON string of JSON).
export function fppcSearch(body) {
  const last = (((body || {}).searchFieldQueryInfos || [])[0] || {}).filterValue;
  const doc = (indexID, first, filedDate, positions, isAmendment = false) => ({ indexID, filer: { lastName: last, firstName: first }, filingInfo: { noReportableInterests: false, isAmendment, filedDate }, filingPositions: positions, hits: {} });
  const pos = (agency, position, filingType, filingYear) => ({ agency, position, filingType, filingYear, dueDate: "03/02/2026" });
  const docs =
    last === "Testgovernor"
      ? [
          doc("C5CCD568-1380-4357-9384-E97BC6E2B450", "Gloria", `${thisYear}-03-02T13:41:17`, [pos("Governor", "Governor", "Annual", thisYear - 1), pos("Example Authority", "Governing Board", "Annual", thisYear - 1)]),
          doc("67864095-2591-4232-97C4-17B849652E4B", "Gloria", `${thisYear - 1}-03-03T00:00:00`, [pos("Governor", "Governor", "Annual", thisYear - 2)]),
          doc("B37CAE95-1B9E-427F-B942-C32C89721B72", "Gloria", `${thisYear - 2}-08-29T00:00:00`, [pos("Governor", "Governor", "Annual", thisYear - 3)], true),
          // The same person filing only for a board, and a namesake: neither is listed.
          doc("CE60A69A-718A-40B9-A6F2-5E7B2DDBD081", "Gloria", `${thisYear - 1}-03-03T13:03:21`, [pos("Example Authority", "Governing Board", "Annual", thisYear - 2)]),
          doc("1710494C-D4C8-4F78-9967-D1AE278EAE3B", "Harriet", `${thisYear}-03-31T13:30:56`, [pos("City of Example", "City/Town Council Member", "Annual", thisYear - 1)]),
        ]
      : [];
  return JSON.stringify({ documents: docs, took: 12 });
}
