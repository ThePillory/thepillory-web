// node --import ./test/sql-stub.mjs --test test/money-visibility.test.mjs
// Campaign money made more visible (docs/funding.md, "The money line" and "Filings as events"):
// the official page's one line for every official with money data, FEC and Cal-Access reports as
// events in This week and the weekly email, and the bill page's count of organizations that
// lobbied and gave. The same rules for everyone, and the wording rules: facts only, never a donor's
// name, "$0", "voted with", "bought", "paid for" or any score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { federalMoneyLine, stateMoneyLine, localMoneyLine, moneyLine, giversLine } from "../../../functions/_lib/money-line.js";
import { fecFilingRows, calAccessFilingRows, filingEvents, filingSentence, periodWords, FEC_REPORT_TYPES } from "../src/funding/filings.js";
import { thisWeek } from "../../../functions/_lib/quick-home.js";
import { buildEditions } from "../src/email/edition.js";
import { weekOf } from "../src/email/schedule.js";
import { wordingProblems } from "../src/promises/check.js";

const MIG = new URL("../migrations/", import.meta.url);

// Words that would tie money to a vote, rank people or judge them.
const BANNED = /voted with|\bbought\b|paid for|\bscore\b|\brank|\btop donor|\bowned\b|in the pocket|beholden|influence|\bswayed?\b|special interests?|dark money|\$0\b/i;
const clean = (s) => {
  assert.doesNotMatch(s, BANNED, s);
  assert.deepEqual(wordingProblems(s), [], s);
};

// ---------------------------------------------------------------------------
// 1. The official page's money line

test("money line: a member of Congress, from the FEC: raised, the PAC share and the largest industry (approximate)", () => {
  const line = federalMoneyLine({
    cycle: 2026,
    totals: { receipts: 2_412_345.4, pac: 603_086 },
    industries: [{ industry: "other", pac: 900_000, emp: 900_000 }, { industry: "health", pac: 120_000, emp: 30_000 }, { industry: "finance", pac: 50_000, emp: 60_000 }],
  });
  assert.equal(line, "Raised $2,412,345 in 2025–2026 · 25% from PACs · Largest industry (approximate): Health care");
  clean(line);
  // Unclassified money is never named as an industry; without one, the part is left out.
  assert.equal(federalMoneyLine({ cycle: 2026, totals: { receipts: 1000, pac: 0 }, industries: [{ industry: "other", pac: 1, emp: 1 }] }), "Raised $1,000 in 2025–2026 · 0% from PACs");
});

test("money line: no line without money (never $0)", () => {
  assert.equal(federalMoneyLine({ cycle: 2026, totals: { receipts: 0, pac: 0 } }), null);
  assert.equal(federalMoneyLine({ cycle: 2026, totals: null }), null);
  assert.equal(stateMoneyLine({ cycle: 2026, row: { raised: 0 }, industries: [] }), null);
  assert.equal(stateMoneyLine({ cycle: 2026, row: null, industries: [] }), null);
  assert.equal(localMoneyLine([{ officials: { A: ["x"] }, committees: { x: { contributions: 0 } } }], "A"), null);
  assert.equal(localMoneyLine([], "A"), null);
  assert.equal(moneyLine({ chamber: "us-house", name: "A" }, null), null);
  // The Cabinet and other appointed officials don't run campaigns: no line.
  assert.equal(moneyLine({ chamber: "us-executive", name: "A" }, { kind: "cabinet" }), null);
});

test("money line: a California official, from Cal-Access, and a county supervisor, from NetFile (itemized only)", () => {
  const ca = moneyLine({ chamber: "ca-assembly", name: "A" }, { kind: "state", money: { cycle: 2026, row: { raised: 845_000 }, industries: [{ industry: "labor", total: 90_000 }, { industry: "other", total: 400_000 }] } });
  assert.deepEqual(ca, { text: "Raised $845,000 in 2025–2026 · Largest industry (approximate): Labor unions", source: "statements filed with the California Secretary of State (Cal-Access)" });
  // The Governor and statewide officers are the same "state" money.
  assert.equal(moneyLine({ chamber: "ca-executive", name: "G" }, { kind: "state", money: { cycle: 2026, row: { raised: 10 }, industries: [] } }).text, "Raised $10 in 2025–2026");
  const docs = [{ officials: { "[Supervisor, District 2]": ["CLVS-1"] }, committees: { "CLVS-1": { contributions: 194, first: "2025-01-25", last: "2025-06-07" } } }];
  const sup = moneyLine({ chamber: "county-board", name: "[Supervisor, District 2]" }, { kind: "county", local: docs });
  assert.deepEqual(sup, { text: "Raised $194 in itemized contributions, Jan. 2025 to June 2025", source: "filings on the county's NetFile site" });
  for (const s of [ca.text, sup.text]) clean(s);
});

test("money line: the official page shows it bold, body size, linked to the Funding tab, in Quick mode's card too", () => {
  const src = readFileSync(new URL("../../../functions/reps/[[path]].js", import.meta.url), "utf8");
  assert.match(src, /<p class="summary-line money-glance"><a href="#funding">\$\{esc\(glance\.text\)\} ›<\/a><\/p>/);
  assert.match(src, /\["Money", glance \? `<a class="money-glance" href="#funding"/);
  const css = readFileSync(new URL("../../../assets/pillory.css", import.meta.url), "utf8");
  const rule = css.match(/\.money-glance, \.money-glance a \{([^}]*)\}/);
  assert.ok(rule, "the .money-glance rule");
  assert.match(rule[1], /font-size: var\(--fs-body\)/);
  assert.match(rule[1], /font-weight: 700/);
  assert.match(rule[1], /color: var\(--text\)/); // no color of its own: never green or red
});

// ---------------------------------------------------------------------------
// 2. Filings as events

const FEC_FILINGS = [
  // The October Quarterly, filed, then amended: the amendment wins.
  { form_type: "F3", report_type: "Q3", report_type_full: "OCTOBER QUARTERLY", coverage_start_date: "2026-07-01T00:00:00", coverage_end_date: "2026-09-30T00:00:00", receipt_date: "2026-10-15T00:00:00", total_receipts: 410_000.5, total_disbursements: 220_000, file_number: 1001, pdf_url: "https://docquery.fec.gov/pdf/1001.pdf" },
  { form_type: "F3", report_type: "Q3", report_type_full: "OCTOBER QUARTERLY", coverage_start_date: "2026-07-01", coverage_end_date: "2026-09-30", receipt_date: "2026-11-02", total_receipts: 412_500, total_disbursements: 221_000, file_number: 1050, pdf_url: "https://docquery.fec.gov/pdf/1050.pdf" },
  { form_type: "F3", report_type: "12G", report_type_full: "PRE-GENERAL", coverage_start_date: "2026-10-01", coverage_end_date: "2026-10-14", receipt_date: "2026-10-22", total_receipts: 50_000, total_disbursements: 90_000, file_number: 1040, pdf_url: "https://docquery.fec.gov/pdf/1040.pdf" },
  // Not a regular report: a 48-hour notice and a termination report are left out.
  { form_type: "F6", report_type: "48", coverage_start_date: "2026-10-20", coverage_end_date: "2026-10-20", receipt_date: "2026-10-21", total_receipts: 5000 },
  { form_type: "F3", report_type: "TER", coverage_start_date: "2026-10-01", coverage_end_date: "2026-10-31", receipt_date: "2026-11-05", total_receipts: 1 },
];

test("FEC: the latest version of each quarterly and pre/post-election report, as the report states it", () => {
  const rows = fecFilingRows(FEC_FILINGS, "bioguide:X", "C001");
  assert.equal(rows.length, 2);
  const q3 = rows.find((r) => r.period_end === "2026-09-30");
  assert.deepEqual(q3, { official_id: "bioguide:X", agency: "FEC", committee_id: "C001", period_start: "2026-07-01", period_end: "2026-09-30", report: "OCTOBER QUARTERLY", raised: 412_500, spent: 221_000, filed: "2026-11-02", source_url: "https://docquery.fec.gov/pdf/1050.pdf" });
  assert.ok(!FEC_REPORT_TYPES.has("48") && !FEC_REPORT_TYPES.has("TER") && FEC_REPORT_TYPES.has("Q1") && FEC_REPORT_TYPES.has("30G"));
});

const CA_ENTRY = {
  name: "Governor",
  committees: [
    { filer_id: "100", name: "Committee A", reports: [
      { filing_id: "1", amend_id: 0, from: "2026-01-01", thru: "2026-06-30", filed: "2026-07-31", contributions: 0, expenditures: 228_831.95, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=1&amendid=0" },
      { filing_id: "1", amend_id: 1, from: "2026-01-01", thru: "2026-06-30", filed: "2026-08-10", contributions: 0, expenditures: 228_900, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=1&amendid=1" },
    ] },
    { filer_id: "200", name: "Committee B", reports: [
      { filing_id: "2", amend_id: 0, from: "2026-01-01", thru: "2026-06-30", filed: "2026-07-30", contributions: 12_000, expenditures: 1_000, source_url: "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=2&amendid=0" },
      { filing_id: "3", amend_id: 0, from: "2026-07-01", thru: "2026-09-30", filed: null, contributions: 1, expenditures: 1, source_url: "https://cal-access.sos.ca.gov/x" },
    ] },
  ],
};

test("Cal-Access: each statement with a filed date, an amendment replacing the statement it amends", () => {
  const rows = calAccessFilingRows("ca:gov", CA_ENTRY);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.committee_id === "100").spent, 228_900);
  assert.equal(rows.find((r) => r.committee_id === "100").filed, "2026-08-10");
  assert.deepEqual(calAccessFilingRows("x", null), []);
});

test("the sentence: who, raised and spent as reported, the period, the agency; several committees combined", () => {
  assert.equal(periodWords("2026-07-01", "2026-09-30"), "July 1 to September 30, 2026");
  assert.equal(periodWords("2025-10-01", "2026-03-31"), "October 1, 2025 to March 31, 2026");
  const fec = filingEvents(fecFilingRows(FEC_FILINGS, "bioguide:X", "C001").map((r) => ({ ...r, name: "[Member of Congress]", slug: "member" })));
  assert.deepEqual(fec.map((e) => e.text), [
    "[Member of Congress]'s campaign reported raising $412,500 and spending $221,000, July 1 to September 30, 2026 (FEC).",
    "[Member of Congress]'s campaign reported raising $50,000 and spending $90,000, October 1 to October 14, 2026 (FEC).",
  ]);
  assert.equal(fec[0].href, "https://docquery.fec.gov/pdf/1050.pdf");
  const ca = filingEvents(calAccessFilingRows("ca:gov", CA_ENTRY).map((r) => ({ ...r, name: "[Governor]", slug: "governor" })));
  assert.equal(ca.length, 1);
  assert.equal(ca[0].text, "[Governor]'s campaign committees reported raising $12,000 and spending $229,900, January 1 to June 30, 2026 (Cal-Access).");
  // Two committees' statements: the official's Funding tab lists each one.
  assert.equal(ca[0].href, "/reps/governor/#funding");
  // A figure the report doesn't state is left out, never shown as $0; with neither, no sentence.
  assert.equal(filingSentence("A", "FEC", "2026-01-01", "2026-03-31", { raised: 5, spent: null, count: 1 }), "A's campaign reported raising $5, January 1 to March 31, 2026 (FEC).");
  assert.equal(filingSentence("A", "FEC", "2026-01-01", "2026-03-31", { raised: null, spent: null, count: 1 }), null);
  for (const e of [...fec, ...ca]) clean(e.text);
});

test("This week: a filing is one item under the fixed rule (final actions first, then newest)", () => {
  const filings = [{ official_id: "s1", date: "2026-11-02", text: "[Senator]'s campaign reported raising $1 and spending $2, July 1 to September 30, 2026 (FEC).", href: "https://docquery.fec.gov/pdf/1.pdf", agency: "FEC" }];
  const outcomes = [{ bill_id: "us-119-hr-1", bill_number: "H.R. 1", title: "An Act", outcome: "signed", action_date: "2026-10-01", level: "federal" }];
  const votes = [{ bill_id: "us-119-hr-2", bill_number: "H.R. 2", bill_title: "Another", chamber: "us-house", result: "Passed", vote_date: "2026-10-30", level: "federal" }];
  const items = thisWeek({ stateName: "California", outcomes, votes, filings });
  assert.deepEqual(items.map((i) => i.date), ["2026-10-01", "2026-11-02", "2026-10-30"]);
  assert.equal(items[1].text, filings[0].text);
  assert.equal(items[1].href, filings[0].href);
});

function d1(sqlite) {
  const wrap = (sql, binds = []) => {
    const st = sqlite.prepare(sql);
    return { bind: (...b) => wrap(sql, b), all: async () => ({ results: st.all(...binds), meta: {} }), first: async () => st.get(...binds) ?? null, run: async () => ({ meta: { changes: Number(st.run(...binds).changes) } }), _run: () => st.run(...binds) };
  };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._run()) };
}

test("the weekly email: the visitor's own reps' filings from the week, and nobody else's", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)");
  const off = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, office, level, chamber, body, district, source_url, last_verified, state, district_code, rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'https://example.org', '2026-11-01', ?, ?, ?)`
  );
  off.run("h4", "rep-four", "Rep Four", "U.S. Representative", "federal", "us-house", "us-house", "CA-4", "CA", "4", null);
  off.run("h5", "rep-five", "Rep Five", "U.S. Representative", "federal", "us-house", "us-house", "CA-5", "CA", "5", null);
  off.run("gov", "gov-ca", "Governor Person", "Governor", "state", "ca-executive", "ca-executive", null, "CA", null, 1);
  const filing = sqlite.prepare("INSERT INTO money_filings (official_id, agency, committee_id, period_start, period_end, report, raised, spent, filed, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  filing.run("h4", "FEC", "C4", "2026-10-15", "2026-11-03", "POST-GENERAL", 30_000, 45_000, "2026-11-10", "https://docquery.fec.gov/pdf/4.pdf");
  filing.run("h4", "FEC", "C4", "2026-07-01", "2026-09-30", "OCTOBER QUARTERLY", 1, 1, "2026-10-15", "https://docquery.fec.gov/pdf/3.pdf"); // filed before the week
  filing.run("h5", "FEC", "C5", "2026-10-15", "2026-11-03", "POST-GENERAL", 9, 9, "2026-11-10", "https://docquery.fec.gov/pdf/5.pdf"); // not this visitor's rep
  filing.run("gov", "Cal-Access", "100", "2026-07-01", "2026-10-17", null, 2_000, 3_000, "2026-11-09", "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=9&amendid=0");
  const files = { "/data/elections/dates.json": { states: {} } };
  const [e] = await buildEditions({ db: d1(sqlite), loadJson: async (p) => files[p] ?? null, week: weekOf("2026-11-15"), today: "2026-11-15" }, [{ key: "x", sub: { level: "exact", st: "CA", cd: "4" } }]);
  const items = e.sections.flatMap((s) => (s.groups || []).flatMap((g) => g.items.map((i) => ({ ...i, rep: g.name }))));
  const reports = items.filter((i) => /reported raising/.test(i.text));
  assert.deepEqual(reports.map((i) => [i.rep, i.text, i.href]), [
    ["Rep Four", "Rep Four's campaign reported raising $30,000 and spending $45,000, October 15 to November 3, 2026 (FEC).", "https://docquery.fec.gov/pdf/4.pdf"],
    ["Governor Person", "Governor Person's campaign reported raising $2,000 and spending $3,000, July 1 to October 17, 2026 (Cal-Access).", "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=9&amendid=0"],
  ]);
  for (const i of reports) clean(i.text);
});

// ---------------------------------------------------------------------------
// 3. Bill pages

test("bill page: one line counting organizations that lobbied and gave, linked to Follow the money", () => {
  assert.equal(giversLine(0), "");
  assert.equal(giversLine(null), "");
  assert.equal(giversLine(12), '<p class="summary-line money-glance"><a href="#money">12 organizations that lobbied on this bill also gave to members of Congress ›</a></p>');
  assert.match(giversLine(1), />1 organization that lobbied on this bill also gave to members of Congress ›</);
  assert.match(giversLine(3, { california: true }), />3 organizations that lobbied on this bill also gave to California legislators ›</);
  clean(giversLine(3).replace(/<[^>]+>/g, ""));
  // Follow the money is the fold the line opens.
  const src = readFileSync(new URL("../../../functions/laws/[[path]].js", import.meta.url), "utf8");
  assert.match(src, /fold\("money", "Money"/);
  assert.match(src, /extra: giversLine\(/);
});

test("the wording rules hold in every new source file", () => {
  for (const f of ["../../../functions/_lib/money-line.js", "../src/funding/filings.js"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    assert.doesNotMatch(text, /voted with|\bbought\b|paid for|\bscore\b/i, f);
  }
});
