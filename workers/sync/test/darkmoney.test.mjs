// Tests for the dark-money layer (docs/funding.md): outside spenders' donors that
// are organizations, nonprofits' IRS figures, and electioneering communications.
// Every response here is FAKE, shaped like the FEC's and ProPublica's; names are
// placeholders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isContribution, namesAPerson, isLLC, orgKey, aggregateDonors, pickNonprofit, nonprofitRow, electioneeringRows, darkShare } from "../src/funding/darkmoney.js";
import { syncDarkMoney } from "../src/funding/darkmoney-sync.js";
import { currentCycle } from "../src/funding/fec.js";
import { darkMoneyFor, electioneeringFor, spenderDetails, electioneeringSection, nonprofitFacts } from "../../../functions/_lib/dark-money.js";

const CYCLE = currentCycle();
const SPENDER = "C00000001";
const r = (o) => ({ is_individual: false, entity_type: "ORG", contribution_receipt_date: `${CYCLE - 1}-06-01`, pdf_url: "https://docquery.fec.gov/cgi-bin/fecimg/?1", ...o });
const ROWS = [
  r({ contributor_name: "EXAMPLE SOCIAL WELFARE FUND", contributor_state: "VA", line_number: "17", receipt_type_full: "CONTRIBUTION", contribution_receipt_amount: 5000000 }),
  r({ contributor_name: "EXAMPLE BANK", contributor_state: "VA", line_number: "17", receipt_type_full: "INTEREST INCOME", contribution_receipt_amount: 300000 }),
  r({ contributor_name: "EXAMPLE MEDIA GROUP", contributor_state: "VA", line_number: "15", receipt_type_full: "MEDIA REFUND", contribution_receipt_amount: 900000 }),
  r({ contributor_name: "EXAMPLE CAPITAL LLC", contributor_state: "CA", line_number: "11AI", contribution_receipt_amount: 1000000 }),
  r({ contributor_name: "EXAMPLE CAPITAL LLC", contributor_state: "CA", line_number: "11AI", contribution_receipt_amount: 500000, contribution_receipt_date: `${CYCLE - 1}-09-01` }),
  r({ contributor_name: "EXAMPLE TRADE COUNCIL", contributor_state: "DC", line_number: "11AI", contribution_receipt_amount: 750000 }),
  r({ contributor_name: "EXAMPLE PAC", contributor_id: "C00000009", entity_type: "PAC", line_number: "11C", contribution_receipt_amount: 400000 }),
  r({ contributor_name: "EXAMPLE CONDUIT PAC", contributor_id: "C00000010", entity_type: "PAC", line_number: "11AI", memo_code: "X", contribution_receipt_amount: 999999 }),
  r({ contributor_name: "DOE FAMILY REVOCABLE TRUST", contributor_state: "TX", line_number: "11AI", contribution_receipt_amount: 250000 }),
  r({ contributor_name: "EXAMPLE BANK", contributor_state: "VA", line_number: "13", contribution_receipt_amount: 2000000 }),
];

test("only contributions count: never loans, refunds, interest, memo entries or a person's trust", () => {
  assert.ok(isContribution({ line_number: "11AI" }) && isContribution({ line_number: "11C" }) && isContribution({ line_number: "12" }));
  assert.ok(isContribution({ line_number: "17", receipt_type_full: "CONTRIBUTION" }));
  assert.ok(!isContribution({ line_number: "17", receipt_type_full: "INTEREST INCOME" }));
  assert.ok(!isContribution({ line_number: "13" }) && !isContribution({ line_number: "15" }));
  assert.ok(namesAPerson("DOE FAMILY REVOCABLE TRUST", "ORG") && namesAPerson("DOE, JANE", "ORG") && namesAPerson("ANYTHING", "IND"));
  assert.ok(!namesAPerson("EXAMPLE TRUST COMPANY", "ORG"));
  assert.ok(isLLC("EXAMPLE CAPITAL LLC") && isLLC("Example Services, L.L.C.") && !isLLC("EXAMPLE LAW, LLP"));
  assert.equal(orgKey("The Example Fund, Inc."), "EXAMPLE FUND");
  const { donors, counted } = aggregateDonors(ROWS, SPENDER, CYCLE);
  assert.deepEqual(donors.map((d) => [d.name, d.kind, d.total, d.count]), [
    ["EXAMPLE SOCIAL WELFARE FUND", "org", 5000000, 1],
    ["EXAMPLE CAPITAL LLC", "llc", 1500000, 2],
    ["EXAMPLE TRADE COUNCIL", "org", 750000, 1],
    ["EXAMPLE PAC", "committee", 400000, 1],
  ]);
  assert.equal(counted, 7650000);
  assert.equal(donors[3].source_url, "https://www.fec.gov/data/committee/C00000009/");
  assert.deepEqual([donors[1].first_date, donors[1].last_date], [`${CYCLE - 1}-06-01`, `${CYCLE - 1}-09-01`]);
  assert.equal(darkShare(6500000, 10000000), 65);
});

test("an IRS record is matched by exact name and state, one match only", () => {
  const orgs = [
    { ein: 1, name: "Example Social Welfare Fund", state: "VA", subseccd: 4 },
    { ein: 2, name: "Example Social Welfare Fund", state: "WA", subseccd: 3 },
    { ein: 3, name: "Example Social Welfare Fund Foundation", state: "VA", subseccd: 3 },
  ];
  assert.deepEqual(pickNonprofit(orgs, "EXAMPLE SOCIAL WELFARE FUND", "VA"), { ein: "1", subsection: 4, state: "VA", name: "Example Social Welfare Fund" });
  assert.equal(pickNonprofit(orgs, "EXAMPLE SOCIAL WELFARE FUND", null), null, "two with that name: no guess");
  assert.equal(pickNonprofit(orgs, "EXAMPLE FUND", "VA"), null);
});

test("ProPublica's 990 figures and FEC electioneering rows, as filed", () => {
  const n = nonprofitRow({
    organization: { ein: 1, name: "Example Social Welfare Fund", subsection_code: 4, state: "VA" },
    filings_with_data: [
      { tax_prd: 202212, tax_prd_yr: 2022, totrevenue: 5, totfuncexpns: 6, pdf_url: "https://example.org/2022.pdf" },
      { tax_prd: 202312, tax_prd_yr: 2023, totrevenue: 66828024, totfuncexpns: 14149543, pdf_url: "https://example.org/2023.pdf" },
    ],
  });
  assert.deepEqual([n.ein, n.subsection, n.tax_year, n.period_end, n.revenue, n.expenses, n.filing_url], ["1", 4, 2023, "2023-12", 66828024, 14149543, "https://example.org/2023.pdf"]);
  const e = electioneeringRows([{ sub_id: 9, committee_id: "C30000001", committee_name: "EXAMPLE ALLIANCE INC", candidate_id: "S0XX00001", calculated_candidate_share: 833.33, disbursement_amount: 2500, disbursement_date: "2026-09-18", public_distribution_date: "2026-09-19", file_number: 77, pdf_url: "https://docquery.fec.gov/cgi-bin/fecimg/?9" }], 2026);
  assert.deepEqual([e[0].amount, e[0].distribution_date, e[0].file_number], [833.33, "2026-09-19", 77]);
});

// ---------------------------------------------------------------------------
// The step, against a small D1

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE funding_outside (official_id TEXT, cycle INTEGER, committee_id TEXT, name TEXT, support_oppose TEXT, total REAL, count INTEGER, source_url TEXT);
    CREATE TABLE fec_committees (committee_id TEXT PRIMARY KEY, name TEXT, committee_type TEXT, committee_type_full TEXT, source_url TEXT NOT NULL, checked_at TEXT);`);
  sqlite.exec(readFileSync(new URL("../migrations/0030_dark_money.sql", import.meta.url), "utf8"));
  sqlite.exec(`INSERT INTO funding_outside VALUES ('m1', ${CYCLE}, '${SPENDER}', 'EXAMPLE SUPER PAC', 'S', 2000000, 4, 'https://www.fec.gov/'),
                                                  ('m1', ${CYCLE}, 'C90000002', 'EXAMPLE NONPROFIT ACTION', 'O', 300000, 2, 'https://www.fec.gov/');
    INSERT INTO fec_committees (committee_id, name, committee_type, source_url) VALUES ('${SPENDER}', 'EXAMPLE SUPER PAC', 'O', 'https://www.fec.gov/'),
                                                                                      ('C90000002', 'EXAMPLE NONPROFIT ACTION', 'I', 'https://www.fec.gov/');`);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { sqlite, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

function fake(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/v1/, "").replace(/^\/nonprofits\/api\/v2/, "");
  if (p === "/electioneering/") {
    return u.searchParams.get("min_date").startsWith(String(CYCLE - 1))
      ? { pagination: { pages: 1 }, results: [{ sub_id: 1, committee_id: "C30000001", committee_name: "EXAMPLE ALLIANCE INC", candidate_id: "H0XX00001", calculated_candidate_share: 50000, disbursement_date: `${CYCLE}-09-18`, public_distribution_date: `${CYCLE}-09-19`, file_number: 77, pdf_url: "https://docquery.fec.gov/cgi-bin/fecimg/?77" }] }
      : { pagination: { pages: 1 }, results: [] };
  }
  if (p === "/filings/") return { results: [{ file_number: 77, committee_id: "C30000001", total_receipts: 0, pdf_url: "https://docquery.fec.gov/pdf/77.pdf" }] };
  if (p.startsWith("/committee/") && p.endsWith("/totals/")) return { results: [{ receipts: 10000000 }] };
  if (p.startsWith("/committee/")) return { results: [{ state: p.includes("C90000002") ? "DC" : "VA", name: null }] };
  if (p === "/schedules/schedule_a/") return { results: ROWS, pagination: { last_indexes: null } };
  if (p === "/search.json") {
    const q = u.searchParams.get("q");
    if (q === "EXAMPLE SOCIAL WELFARE FUND") return { organizations: [{ ein: 111, name: "Example Social Welfare Fund", state: "VA", subseccd: 4 }] };
    if (q === "EXAMPLE TRADE COUNCIL") return { organizations: [{ ein: 222, name: "Example Trade Council", state: "DC", subseccd: 6 }] };
    if (q === "EXAMPLE NONPROFIT ACTION") return { organizations: [{ ein: 333, name: "Example Nonprofit Action", state: "DC", subseccd: 4 }] };
    return { organizations: [] };
  }
  const org = /^\/organizations\/(\d+)\.json$/.exec(p);
  if (org) return { organization: { ein: Number(org[1]), name: `Example Org ${org[1]}`, subsection_code: org[1] === "222" ? 6 : 4, state: "DC" }, filings_with_data: [{ tax_prd: 202412, tax_prd_yr: 2024, totrevenue: 1000, totfuncexpns: 900, pdf_url: "https://example.org/f.pdf" }] };
  throw new Error(`unexpected ${url}`);
}

const budget = { paced: async (db, key, pace, url) => ({ json: async () => fake(url) }) };

test("dark-money step: electioneering, IRS records, donors labeled, the share, nonprofits", async () => {
  const db = d1();
  const r = await syncDarkMoney({ FEC_API_KEY: "test", FEC_API_BASE: "https://api.open.fec.gov/v1", PROPUBLICA_API_BASE: "https://projects.propublica.org/nonprofits/api/v2" }, db, budget);
  assert.equal(r.status, "ok", r.message);
  const donors = db.sqlite.prepare("SELECT name, kind, ein, total FROM outside_donors ORDER BY total DESC").all().map((d) => [d.name, d.kind, d.ein, d.total]);
  assert.deepEqual(donors, [
    ["EXAMPLE SOCIAL WELFARE FUND", "c4", "111", 5000000],
    ["EXAMPLE CAPITAL LLC", "llc", null, 1500000],
    ["EXAMPLE TRADE COUNCIL", "c6", "222", 750000],
    ["EXAMPLE PAC", "committee", null, 400000],
  ]);
  const read = db.sqlite.prepare("SELECT receipts, dark_total, truncated FROM outside_donor_reads").get();
  assert.deepEqual([read.receipts, read.dark_total, read.truncated], [10000000, 7250000, 0]);
  assert.equal(db.sqlite.prepare("SELECT ein FROM fec_committees WHERE committee_id = 'C90000002'").get().ein, "333");
  // 111 and 222 (donors) and 333 (a spender); the Form 9 filer has no IRS match, so none is guessed.
  assert.deepEqual(db.sqlite.prepare("SELECT ein FROM nonprofits ORDER BY ein").all().map((n) => n.ein), ["111", "222", "333"]);
  assert.equal(db.sqlite.prepare("SELECT ein FROM fec_committees WHERE committee_id = 'C30000001'").get().ein, null);
  assert.equal(db.sqlite.prepare("SELECT donations FROM electioneering_filings WHERE file_number = 77").get().donations, 0);
  // A second run the same day has nothing to do.
  assert.equal((await syncDarkMoney({ FEC_API_KEY: "test" }, db, budget)).status, "skipped");

  // The page: donors labeled and linked, the share in one plain line, the nonprofit's 990 with "don't list donors".
  const dm = await darkMoneyFor(db, [SPENDER, "C90000002"], CYCLE);
  const html = spenderDetails({ committee_id: SPENDER, name: "EXAMPLE SUPER PAC" }, dm, CYCLE);
  assert.match(html, /Who funds EXAMPLE SUPER PAC/);
  assert.match(html, /<strong>73% of this group's reported money came from organizations that don't disclose their own donors\.<\/strong>/);
  assert.match(html, /EXAMPLE CAPITAL LLC<\/a> <span class="chip chip--gray chip--sm">LLC<\/span>/);
  assert.match(html, /href="https:\/\/apps\.irs\.gov\/app\/eos\/details\/\?ein=000000111"/);
  assert.match(html, /href="https:\/\/www\.fec\.gov\/data\/committee\/C00000009\/"/);
  assert.match(html, /501\(c\)\(6\)/);
  assert.match(html, /doesn't list its donors/);
  assert.doesNotMatch(html, /DOE|TRUST|EXAMPLE BANK|MEDIA GROUP/, "no person's trust, no interest, no refunds");
  const nonprofitSpender = spenderDetails({ committee_id: "C90000002", name: "EXAMPLE NONPROFIT ACTION" }, dm, CYCLE);
  assert.match(nonprofitSpender, /is a 501\(c\)\(4\) nonprofit\. Its IRS Form 990 for 2024: revenue \$1,000, total spending \$900, political spending not read yet/);

  // Electioneering on the member's or candidate's page.
  const e = await electioneeringFor(db, ["H0XX00001"], CYCLE);
  const ec = electioneeringSection(e, "Alex Example");
  assert.match(ec, /Electioneering communications/);
  assert.match(ec, /EXAMPLE ALLIANCE INC<\/a> <span class="chip chip--gray chip--sm">No donors reported<\/span>/);
  assert.match(ec, /\$50,000/);
  assert.match(ec, /aired (Sep|September) 19, \d{4}/);
  assert.doesNotMatch(ec, /\b(supports?|opposes?|attacks?)\b/i, "no side is assigned to an ad");
  assert.match(electioneeringSection(await electioneeringFor(db, ["S0ZZ00009"], CYCLE), "Robin Example"), /No electioneering communications naming Robin Example/);
});

test("a nonprofit's Schedule C: political spending as filed and the political organizations it paid", () => {
  const html = nonprofitFacts({ ein: "111", name: "Example Social Welfare Fund", subsection: 4, tax_year: 2024, revenue: 106804171, expenses: 162489768, political: 58400000, political_read: "schedule_c", recipients: JSON.stringify([{ name: "EXAMPLE SUPER PAC", amount: 58400000 }]), filing_url: "https://example.org/full", source_url: "https://example.org" });
  assert.match(html, /revenue \$106,804,171, total spending \$162,489,768, political spending \$58,400,000 \(Schedule C\)/);
  assert.match(html, /payments to political organizations: EXAMPLE SUPER PAC \$58,400,000/);
  assert.match(html, /doesn't list its donors/);
  assert.match(nonprofitFacts({ ein: "1", name: "X", subsection: 6, political_read: "no_schedule_c" }), /no political spending reported \(no Schedule C filed\)/);
});
