// node workers/sync/test/history.test.mjs
// The Time Machine's parsers: Congress by year, House Clerk roll calls, Cabinet
// nominations, FEC totals by period, and who held a seat on a date.
// Every name and number here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { congressOfYear, clerkDate, houseLegis, parseHouseRoll, cabinetPosition, fecCycles, holderOn, holdersInYear } from "../src/history/parse.js";

test("the Congress and session for a year", () => {
  assert.deepEqual(congressOfYear(2001), { congress: 107, session: 1 });
  assert.deepEqual(congressOfYear(2002), { congress: 107, session: 2 });
  assert.deepEqual(congressOfYear(2025), { congress: 119, session: 1 });
});

test("Clerk dates and bill numbers", () => {
  assert.equal(clerkDate("5-Mar-2008"), "2008-03-05");
  assert.equal(clerkDate("nonsense"), null);
  assert.deepEqual(houseLegis("H R 1424"), { type: "HR", number: "1424" });
  assert.deepEqual(houseLegis("H RES 12"), { type: "HRES", number: "12" });
  assert.equal(houseLegis("QUORUM"), null);
});

const ROLL = `<?xml version="1.0"?><rollcall-vote><vote-metadata>
<majority>D</majority><congress>110</congress><session>2nd</session><chamber>U.S. House of Representatives</chamber>
<rollcall-num>101</rollcall-num><legis-num>H R 1424</legis-num><vote-question>On Passage</vote-question>
<vote-type>YEA-AND-NAY</vote-type><vote-result>Passed</vote-result><action-date>5-Mar-2008</action-date>
<vote-desc>Example Act</vote-desc>
<vote-totals><totals-by-vote><total-stub>Totals</total-stub><yea-total>268</yea-total><nay-total>148</nay-total><present-total>0</present-total><not-voting-total>16</not-voting-total></totals-by-vote></vote-totals>
</vote-metadata><vote-data>
<recorded-vote><legislator name-id="A000001" sort-field="Example" unaccented-name="Example" party="D" state="CA" role="legislator">Example</legislator><vote>Yea</vote></recorded-vote>
<recorded-vote><legislator name-id="B000002" sort-field="Sample" unaccented-name="Sample" party="R" state="CA" role="legislator">Sample</legislator><vote>Nay</vote></recorded-vote>
</vote-data></rollcall-vote>`;

test("a House roll call: question, result, totals and each member's vote", () => {
  const r = parseHouseRoll(ROLL);
  assert.equal(r.congress, 110);
  assert.equal(r.session, 2);
  assert.equal(r.roll, 101);
  assert.equal(r.question, "On Passage");
  assert.equal(r.result, "Passed");
  assert.equal(r.date, "2008-03-05");
  assert.equal(r.amendment, false);
  assert.deepEqual(r.totals, { yea: 268, nay: 148, present: 0, not_voting: 16 });
  assert.deepEqual(r.members, [{ bioguide: "A000001", vote: "Yea" }, { bioguide: "B000002", vote: "Nay" }]);
  assert.equal(parseHouseRoll("<html>not found</html>"), null);
});

test("Cabinet offices from nomination descriptions; other posts are not Cabinet", () => {
  assert.equal(cabinetPosition("Jane Example, of Ohio, to be Secretary of Energy."), "Secretary of Energy");
  assert.equal(cabinetPosition("John Sample, of Texas, to be Attorney General, vice Someone Else, resigned."), "Attorney General");
  assert.equal(cabinetPosition("Pat Placeholder, of Iowa, to be Deputy Secretary of Energy."), null);
  assert.equal(cabinetPosition("Lee Example, of Utah, to be Secretary of the Air Force."), null);
});

test("FEC totals by two-year period", () => {
  const rows = fecCycles({ results: [
    { cycle: 2008, receipts: 1000.5, disbursements: 900, last_cash_on_hand_end_period: 100.5, coverage_end_date: "2008-12-31T00:00:00" },
    { cycle: null, receipts: 5 },
  ] });
  assert.deepEqual(rows, [{ cycle: 2008, receipts: 1000.5, disbursements: 900, cash_on_hand: 100.5, coverage_end: "2008-12-31" }]);
  assert.deepEqual(fecCycles(null), []);
});

test("who held a seat on a date and during a year", () => {
  const terms = [
    { name: "First Example", start: "2003-01-03", end: "2007-01-03" },
    { name: "Second Example", start: "2007-01-04", end: "2013-01-03" },
  ];
  assert.deepEqual(holderOn(terms, "2005-06-01").map((t) => t.name), ["First Example"]);
  assert.deepEqual(holdersInYear(terms, 2007).map((t) => t.name), ["First Example", "Second Example"]);
  assert.deepEqual(holdersInYear(terms, 2000), []);
});
