// Incumbency on race pages, the ballot preview and candidate pages: "Incumbent"
// only on the candidate who holds that exact seat (the certified list's mark,
// or ThePillory's records: same FEC ID, or the only name match), nobody else
// labeled, the order untouched, and "Open seat" naming the holder only from
// the records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seatOf, raceIncumbency, openSeatLine, candidateCard } from "../../../functions/_lib/candidates.js";

const off = (slug, name, chamber, extra = {}) => ({ slug, name, chamber, active: 1, state: "CA", office: "", district_code: null, ...extra });
const records = {
  officials: [
    off("gov-one", "Gwen Governor", "ca-executive", { office: "Governor" }),
    off("ctl-one", "Cora Controller", "ca-executive", { office: "State Controller" }),
    off("rep-five", "Hank House", "us-house", { district_code: "5" }),
    off("rep-six", "Ida Inc", "us-house", { district_code: "6" }),
    off("old-rep", "Hank Former", "us-house", { district_code: "7", active: 0 }),
    off("asm-eight", "Alma Assembly", "ca-assembly", { district_code: "8" }),
    off("sen-a", "Sam Senator", "us-senate"),
    off("sen-b", "Sue Senator", "us-senate"),
  ],
  byFec: { H6CA05001: { slug: "rep-five", name: "Hank House", active: 1 } },
};

test("the seat a race is for: the exact district or office, current officials only", () => {
  assert.deepEqual(seatOf(records, "CA", "house-5").holders.map((o) => o.slug), ["rep-five"]);
  assert.deepEqual(seatOf(records, "CA", "house-7").holders, [], "a former member doesn't hold the seat");
  assert.deepEqual(seatOf(records, "CA", "x", { scope: "statewide", office: "Controller" }).holders.map((o) => o.slug), ["ctl-one"], '"State Controller" is the Controller');
  assert.deepEqual(seatOf(records, "CA", "x", { scope: "sldl", district: "8" }).holders.map((o) => o.slug), ["asm-eight"]);
  assert.equal(seatOf(records, "CA", "senate").senate, true);
});

test("a House incumbent running: labeled by FEC ID, nobody else labeled, order kept", () => {
  const fecList = [{ id: "H6CA05009", name: "ABLE, ANN" }, { id: "H6CA05001", name: "HOUSE, HANK" }];
  const inc = raceIncumbency({ st: "CA", key: "house-5", fecList, records });
  assert.equal(inc.get("H6CA05001", "Hank House").holder.slug, "rep-five");
  assert.equal(inc.get("H6CA05009", "Ann Able"), null);
  assert.equal(inc.open, null);
});

test("the certified list's mark labels the incumbent; a unique name match does too", () => {
  const contest = { id: "us-rep-6", scope: "cd", district: "6", candidates: [{ name: "Ida Inc", incumbent: false }, { name: "Bo Other", incumbent: false }] };
  const inc = raceIncumbency({ st: "CA", key: contest.id, contest, ballot: contest.candidates, records });
  assert.equal(inc.get(null, "Ida Inc").holder.slug, "rep-six");
  assert.equal(inc.get(null, "Bo Other"), null);
  const marked = { ...contest, district: "9", candidates: [{ name: "Mark Marked", incumbent: true }] };
  const m = raceIncumbency({ st: "CA", key: marked.id, contest: marked, ballot: marked.candidates, records });
  assert.deepEqual(m.get(null, "Mark Marked"), { holder: null }, "the official mark alone: labeled, no record link");
});

test("two candidates matching the holder's name: neither is labeled", () => {
  const contest = { id: "us-rep-6", scope: "cd", district: "6", candidates: [{ name: "Ida Inc" }, { name: "Ida M. Inc" }] };
  const inc = raceIncumbency({ st: "CA", key: contest.id, contest, ballot: contest.candidates, records });
  assert.equal(inc.get(null, "Ida Inc"), null);
  assert.equal(inc.get(null, "Ida M. Inc"), null);
});

test("an open seat names the current holder only from the records; never for the Senate", () => {
  const contest = { id: "governor", scope: "statewide", office: "Governor", candidates: [{ name: "Xena Y", incumbent: false }, { name: "Zed Q", incumbent: false }] };
  const inc = raceIncumbency({ st: "CA", key: "governor", contest, ballot: contest.candidates, records });
  assert.equal(inc.open.slug, "gov-one");
  assert.match(openSeatLine(inc.open), /Open seat: the current officeholder, <a class="inline-link" href="\/reps\/gov-one\/">Gwen Governor<\/a>, isn't running\./);
  assert.equal(raceIncumbency({ st: "CA", key: "house-7", fecList: [{ id: "H1", name: "A, B" }], records }).open, null, "no current holder in the records: no line");
  assert.equal(raceIncumbency({ st: "CA", key: "senate", fecList: [{ id: "S1", name: "NEW, NORA" }], records }).open, null);
  assert.equal(openSeatLine(null), "");
});

test("the incumbent's card links to their record; others' cards don't", () => {
  const card = candidateCard({ href: "/candidates/H1/", name: "Hank House", facts: ["Party A", "Incumbent"], held: "", record: { slug: "rep-five" } });
  assert.match(card, /<a class="cand-record" href="\/reps\/rep-five\/#votes">Votes and record ›<\/a>/);
  assert.match(card, /<ul class="cand-facts"><li>Party A<\/li><li>Incumbent<\/li><\/ul>/, "one bullet each");
  assert.doesNotMatch(candidateCard({ href: "/candidates/H2/", name: "Ann Able", facts: ["Party B"], held: "" }), /cand-record|Incumbent|Challenger/);
});
