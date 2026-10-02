// Unit tests for campaign funding (FEC) and lobbying (lda.gov) parsing, against
// FAKE responses shaped like the real ones. Run: node workers/sync/test/funding.test.mjs
import assert from "node:assert/strict";
import { currentCycle, candidateIdsFor, parseTotals, aggregatePacs, parseEmployers, parseOutside } from "../src/funding/fec.js";
import { classify, classifyCommittee, NOT_EMPLOYED, INDUSTRIES } from "../src/funding/industry.js";
import { billQueries, mentionPattern, mentionsIn, filingRow, congressYears } from "../src/funding/lobbying.js";
import { fecOptions, liveDistricts, priorityOf } from "../src/funding/sync.js";
import { fec, lda } from "./funding-fixtures.mjs";

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`ok   ${name}`);
};
const q = (o) => new URLSearchParams({ api_key: "k", ...o });

test("cycles and candidate IDs for the current office", () => {
  assert.equal(currentCycle(new Date("2025-03-01")), 2026);
  assert.equal(currentCycle(new Date("2026-10-02")), 2026);
  assert.deepEqual(candidateIdsFor(["S8WA00194", "H2WA01054"], "us-senate", "WA"), ["S8WA00194"]);
  assert.deepEqual(candidateIdsFor(["H8CA04152", "H6CA21135"], "us-house", "CA"), ["H8CA04152", "H6CA21135"]);
  assert.deepEqual(candidateIdsFor(["H8CA04152"], "us-house", "NV"), [], "another state's ID isn't used");
  assert.deepEqual(candidateIdsFor([], "us-senate", "OK"), []);
});

test("order and key: live communities' members first; funding's own FEC key", () => {
  assert.deepEqual(liveDistricts({ LIVE_HOUSE_DISTRICTS: "CA-5, ca-05,TX-x" }), [{ st: "CA", cd: "5" }, { st: "CA", cd: "5" }]);
  assert.deepEqual(liveDistricts({ CA_HOUSE_DISTRICT: "5" }), [{ st: "CA", cd: "5" }], "falls back to CA_HOUSE_DISTRICT");
  assert.deepEqual(priorityOf({}).binds, []);
  const p = priorityOf({ LIVE_HOUSE_DISTRICTS: "CA-5" });
  assert.deepEqual(p.binds, ["CA-5", "CA", "CA"]);
  assert.match(p.sql, /us-senate/);
  const own = fecOptions({ FEC_API_KEY: "fec", CONGRESS_API_KEY: "congress" });
  assert.equal(own.key, "fec");
  assert.equal(own.own, true);
  assert.equal(own.pace.intervalMs, 4000);
  const shared = fecOptions({ CONGRESS_API_KEY: "congress", FEC_MIN_INTERVAL_MS: "4000" });
  assert.equal(shared.key, "congress");
  assert.equal(shared.own, false);
  assert.equal(shared.pace.intervalMs, 8000, "half the pace when sharing the Congress.gov key");
});

test("totals: the FEC's own figures, split by source", () => {
  const t = parseTotals(fec("/candidate/H0CA12001/totals/", q({ cycle: "2026" })).body.results[0], "H0CA12001", 2026);
  assert.equal(t.receipts, 800000);
  assert.equal(t.individual_unitemized, 160000);
  assert.equal(t.individual_itemized, 360000);
  assert.equal(t.pac, 200000);
  assert.equal(t.party, 16000);
  assert.equal(t.self_funding, 60000, "the candidate's contributions and loans");
  assert.equal(t.other, 4000);
  assert.equal(t.source_url, "https://www.fec.gov/data/candidate/H0CA12001/?cycle=2026&election_full=false");
  assert.equal(parseTotals(undefined, "x", 2026), null);
});

test("PACs: summed by committee; memo entries left out, refunds counted; leadership PACs by FEC record", () => {
  const all = [];
  let last = null;
  for (;;) {
    const p = fec("/schedules/schedule_a/", q({ committee_id: "C00000003", line_number: "F3-11C", per_page: "100", ...(last || {}) })).body;
    all.push(...p.results);
    if (!p.pagination.last_indexes) break;
    last = p.pagination.last_indexes;
  }
  assert.equal(all.length, 122, "both pages");
  const pacs = aggregatePacs(all, "C00000003", 2026);
  assert.equal(pacs.length, 8, "the memo entry isn't a contributor");
  const bankers = pacs.find((p) => p.committee_id === "C90000001");
  assert.equal(bankers.total, 15 * 1000 - 500, "15 contributions less a $500 refund");
  assert.equal(bankers.count, 16);
  assert.equal(bankers.industry, "finance");
  assert.equal(pacs.find((p) => p.committee_id === "C90000006").industry, "leadership");
  assert.equal(pacs.find((p) => p.committee_id === "C90000004").industry, "labor");
  assert.ok(pacs[0].total >= pacs.at(-1).total, "largest first");
  assert.match(pacs[0].source_url, /line_number=F3-11C/);
});

test("employers: never a person; 'Retired' and 'None' aren't employers; classified by keyword", () => {
  const e = parseEmployers(fec("/schedules/schedule_a/by_employer/", q({ committee_id: "C00000003", cycle: "2026" })).body.results, "H0CA77001", 2026);
  assert.deepEqual(e.map((x) => x.employer), ["EXAMPLE REGIONAL MEDICAL CENTER", "TEST UNIVERSITY", "SAMPLE ALMOND GROWERS", "EXAMPLE CAPITAL PARTNERS", "ONE-PERSON CONSULTING LLC"]);
  assert.deepEqual(e.slice(0, 4).map((x) => x.industry), ["health", "education", "agriculture", "finance"]);
  for (const x of ["RETIRED", "NONE", "SELF EMPLOYED", "NOT PROVIDED", "INFORMATION REQUESTED", "NULL", "N/A"]) assert.ok(NOT_EMPLOYED.test(x), x);
});

test("outside spending: for and against, by spender", () => {
  const o = parseOutside(fec("/schedules/schedule_e/by_candidate/", q({ candidate_id: "H0CA77001", cycle: "2026" })).body.results, "H0CA77001", 2026);
  assert.deepEqual(o.map((x) => [x.name, x.support_oppose, x.total]), [["TEST FUTURE FUND", "O", 220000], ["EXAMPLE VOTERS ALLIANCE", "S", 150000], ["SAMPLE CITIZENS COMMITTEE", "O", 40000]]);
});

test("industries: fixed keyword rules, the same for everyone; unknown names aren't guessed", () => {
  assert.equal(classify("EXAMPLE PHARMACEUTICAL HEALTH CO"), "pharma", "the narrower rule wins");
  assert.equal(classify("EXAMPLE TEACHERS UNION"), "labor");
  assert.equal(classify("MORONGO BAND OF MISSION INDIANS"), "tribal");
  assert.equal(classify("ACME"), "other");
  assert.equal(classify(""), "other");
  assert.equal(classifyCommittee({ name: "ANY NAME", committee_type: "H" }), "leadership");
  assert.ok(Object.keys(INDUSTRIES).includes("other"));
});

test("lobbying: bill-number searches and whole-number matching", () => {
  assert.deepEqual(billQueries("H.R. 10"), ["H.R. 10", "H.R.10"]);
  assert.deepEqual(billQueries("S. 1071"), ["S. 1071", "S.1071"]);
  assert.deepEqual(congressYears(119), [2025, 2026]);
  const re = mentionPattern("H.R. 10");
  const found = (s) => [...s.matchAll(re)].map((m) => m[0]);
  assert.deepEqual(found("H.R. 10; H.R.10; HR 10; H.R. 100; H.R. 1010; H. Res. 10"), ["H.R. 10", "H.R.10", "HR 10"]);
  assert.deepEqual([..."S. 5; U.S. 5; Sec. 5; S 5".matchAll(mentionPattern("S. 5"))].map((m) => m[0]), ["S. 5", "S 5"]);
});

test("lobbying: older Congresses and other bills' titles are set aside", () => {
  const bill = { id: "us-119-hr-10", bill_number: "H.R. 10", title: "Test Bill Ten Act", session: "119" };
  const page1 = lda("/filings/", new URLSearchParams({ filing_specific_lobbying_issues: '"H.R. 10"', filing_year: "2025", page: "1", page_size: "25" })).body;
  const page2 = lda("/filings/", new URLSearchParams({ filing_specific_lobbying_issues: '"H.R. 10"', filing_year: "2025", page: "2", page_size: "25" })).body;
  assert.equal(page1.results.length, 25);
  assert.ok(page1.next && !page2.next);
  const matched = [...page1.results, ...page2.results].filter((f) => mentionsIn(f, bill, 119).length).map((f) => f.client.name);
  assert.deepEqual(matched, ["EXAMPLE RURAL BROADBAND ASSOCIATION", "TEST FARM BUREAU"]);
  const tight = lda("/filings/", new URLSearchParams({ filing_specific_lobbying_issues: '"H.R.10"', filing_year: "2025" })).body.results;
  assert.equal(mentionsIn(tight[0], bill, 119)[0].excerpt, "Broadband finance provisions in H.R.10.");
});

test("lobbying: report rows; the amount is the whole report's income or expenses", () => {
  const [f] = lda("/filings/", new URLSearchParams({ filing_specific_lobbying_issues: '"H.R.10"', filing_year: "2025" })).body.results;
  const r = filingRow(f);
  assert.equal(r.client_name, "EXAMPLE CAPITAL BANK");
  assert.equal(r.amount, 120000);
  assert.equal(r.amount_kind, "expenses");
  assert.equal(r.industry, "finance");
  assert.match(r.source_url, /^https:\/\/lda\.example\/filings\/public\/filing\//);
});

console.log(`\n${n} passed`);
