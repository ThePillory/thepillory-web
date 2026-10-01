// Unit tests for the nationwide pieces: district IDs from the Census geocoder
// and the ZIP data, the district cookie, and vote totals. FAKE inputs only.
//   node nationwide.test.mjs
import assert from "node:assert/strict";
import { districtsFromMatch, zipResult, cookieHeader } from "../../../functions/api/districts.js";
import { cleanDistricts, districtsFromCookie, repsWhere, describe, isCalaveras } from "../../../functions/_lib/districts.js";
import { sectionHeadings, condense } from "../src/analysis/billtext.js";
import { revisionMessage } from "../src/analysis/prompt.js";
import { houseTotals, directName, districtCode, senateTotals, stateTotals, matchPositions, totals } from "../src/rollcall.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
};

const geo = (cdKey, extra = {}) => ({
  geographies: {
    [cdKey]: [{ STATE: "48", BASENAME: "37", GEOID: "4837" }],
    "2024 State Legislative Districts - Upper": [{ STATE: "48", BASENAME: "14" }],
    "2024 State Legislative Districts - Lower": [{ STATE: "48", BASENAME: "49" }],
    Counties: [{ STATE: "48", GEOID: "48453", NAME: "Travis County" }],
    ...extra,
  },
});

test("address: districts of the Congress in session only", () => {
  const r = districtsFromMatch(geo("119th Congressional Districts"), 119);
  assert.deepEqual(r.districts, { st: "TX", cd: "37", su: "14", sl: "49", co: "48453" });
  const next = districtsFromMatch(geo("120th Congressional Districts"), 119);
  assert.equal(next.districts.cd, undefined, "a 120th-Congress district is not used for the 119th Congress");
});

test("address: at-large seats have no district number", () => {
  const r = districtsFromMatch({ geographies: { "119th Congressional Districts": [{ STATE: "02", BASENAME: "At Large" }], Counties: [{ STATE: "02", GEOID: "02020" }] } }, 119);
  assert.equal(r.districts.cd, "0");
  assert.equal(r.districts.st, "AK");
});

test("ZIP: one set of districts", () => {
  const r = zipResult([["CA", "5", "4", "8", "06009", 1]]);
  assert.equal(r.found, true);
  assert.deepEqual(r.districts, { st: "CA", cd: "5", su: "4", sl: "8", co: "06009" });
});

test("ZIP: split between districts asks the visitor", () => {
  const r = zipResult([["CA", "42", "33", "57", "06037", 0.6], ["CA", "37", "28", "57", "06037", 0.4]]);
  assert.equal(r.found, false);
  assert.equal(r.choices.length, 2);
});

test("ZIP: a split only by county (outside Calaveras) is one answer", () => {
  const r = zipResult([["TX", "10", "", "", "48453", 0.7], ["TX", "10", "", "", "48491", 0.3]]);
  assert.equal(r.found, true);
  assert.equal(r.districts.co, undefined);
});

test("ZIP: slivers under 2% aren't offered", () => {
  const r = zipResult([["CA", "5", "4", "8", "06009", 0.99], ["CA", "3", "4", "8", "06009", 0.01]]);
  assert.equal(r.found, true);
});

test("cookie: only well-formed district IDs survive", () => {
  assert.deepEqual(cleanDistricts({ st: "CA", cd: "05", su: "x", sl: "8", co: "06009", address: "1 Main St" }), { st: "CA", cd: "5", sl: "8", co: "06009" });
  assert.equal(cleanDistricts({ st: "ZZ" }), null);
  assert.deepEqual(cleanDistricts({ st: "NV", co: "06009" }), { st: "NV" }, "a county from another state is dropped");
  const header = cookieHeader({ st: "CA", cd: "5", co: "06009" });
  const request = { headers: new Map([["Cookie", `other=1; ${header.split(";")[0]}`]]) };
  request.headers.get = request.headers.get.bind(request.headers);
  const d = districtsFromCookie(request);
  assert.deepEqual(d, { st: "CA", cd: "5", co: "06009" });
  assert.equal(isCalaveras(d), true);
  assert.match(describe(d), /California · Congressional District 5/);
});

test("reps: senators, House member, state legislators, supervisors", () => {
  const w = repsWhere({ st: "CA", cd: "5", su: "4", sl: "8", co: "06009" });
  assert.match(w.sql, /us-senate/);
  assert.match(w.sql, /ca-assembly/);
  assert.match(w.sql, /county-board/);
  const tx = repsWhere({ st: "TX", cd: "37", su: "14", sl: "49" });
  assert.doesNotMatch(tx.sql, /ca-senate|county-board/, "state and county reps are California only for now");
});

test("totals: House party totals are summed", () => {
  const t = houseTotals({ votePartyTotal: [{ yeaTotal: 216, nayTotal: 2, presentTotal: 0, notVotingTotal: 2 }, { yeaTotal: 0, nayTotal: 212, presentTotal: 1, notVotingTotal: 1 }] }, []);
  assert.deepEqual(t, { yea: 216, nay: 214, present: 1, not_voting: 3 });
  assert.deepEqual(houseTotals({}, [{ voteCast: "Yea" }, { voteCast: "Nay" }, { voteCast: "Not Voting" }]), { yea: 1, nay: 1, present: 0, not_voting: 1 });
});

test("totals: Senate <count> and Open States counts", () => {
  assert.deepEqual(senateTotals("<count><yeas>51</yeas><nays>45</nays><present/><absent>4</absent></count>", []), { yea: 51, nay: 45, present: 0, not_voting: 4 });
  assert.deepEqual(stateTotals({ counts: [{ option: "yes", value: 60 }, { option: "no", value: 15 }, { option: "not voting", value: 5 }] }), { yea: 60, nay: 15, present: 0, not_voting: 5 });
  assert.equal(stateTotals({}), null);
  assert.deepEqual(totals({ yea: "3", nay: null, present: "", not_voting: 1 }), [3, null, null, 1]);
});

test("members: names and districts from the Congress.gov list", () => {
  assert.equal(directName("Pelosi, Nancy"), "Nancy Pelosi");
  assert.equal(directName("Smith, John, Jr."), "John Smith, Jr.");
  assert.equal(districtCode(5), "5");
  assert.equal(districtCode(undefined), "0");
  assert.equal(districtCode(0), "0");
});

test("state votes: every loaded legislator's position, one per person", () => {
  const a = { id: "openstates:a", openstates_id: "ocd-person/a", chamber: "ca-assembly", last_name: "Delta" };
  const b = { id: "openstates:b", openstates_id: "ocd-person/b", chamber: "ca-assembly", last_name: "Eta" };
  const officials = { all: [a, b], by: new Map([[a.openstates_id, a], [b.openstates_id, b]]) };
  const vote = { organization: { classification: "lower" }, votes: [
    { option: "yes", voter: { id: "ocd-person/a" } },
    { option: "no", voter_name: "Eta", voter: null },
    { option: "yes", voter_name: "Somebody", voter: { id: "ocd-person/unknown" } },
  ] };
  const got = matchPositions(vote, officials);
  assert.deepEqual(got.map((p) => [p.official_id, p.position]), [["openstates:a", "Yes"], ["openstates:b", "No"]]);
});

test("long bills: a card reads the summary, the sections and the opening", () => {
  const text = ["SECTION 1. SHORT TITLE.", "This Act may be cited as the Test Act.", "TITLE I--GRANTS", "SEC. 101. GRANTS.", "x".repeat(5000), "SEC. 102. REPORTS.", "y".repeat(5000)].join("\n");
  assert.deepEqual(sectionHeadings(text), ["SECTION 1. SHORT TITLE.", "TITLE I--GRANTS", "SEC. 101. GRANTS.", "SEC. 102. REPORTS."]);
  const short = { basis: "full_text", text: "short" };
  assert.equal(condense(short, { limit: 1000 }), short, "a short bill is unchanged");
  const c = condense({ basis: "full_text", text }, { limit: 6000, summary: { label: "CRS summary", text: "It makes grants." } });
  assert.equal(c.basis, "partial_text");
  assert.ok(c.text.length <= 6000 + 200);
  assert.match(c.text, /OFFICIAL SUMMARY \(CRS summary\):\nIt makes grants\./);
  assert.match(c.text, /SEC\. 102\. REPORTS\./, "headings from past the cut are listed");
  assert.match(c.note, /^the official summary, the list of sections and the first [\d,]+ of 10,117 characters$/);
});

test("revision: the reviewer's problems and the previous draft go back to the drafter", () => {
  const msg = revisionMessage({ bill_number: "H.R. 1", level: "federal", title: "T", session: "119" }, { basis: "full_text", text: "TEXT" }, "card", { plain_summary: "S" }, ["Summary is incomplete.", "Too certain."]);
  assert.match(msg, /<previous_draft>[\s\S]*"plain_summary": "S"/);
  assert.match(msg, /1\. Summary is incomplete\.\n2\. Too certain\./);
  assert.match(msg, /Revise the short card\.$/);
});

console.log(`${passed} passed`);
