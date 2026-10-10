// node --test test/election-window.test.mjs
// When "Open your ballot" leads the home page: from 45 days before the visitor's
// state's next election through Election Day, from that state's own dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ballotWindow, nextElection, todayIn, countdownLine, daysBetween, WINDOW_DAYS } from "../../../functions/_lib/election-window.js";

// In the shape tools/build_federal_races.py writes, from the FEC's dates for these states.
const DATES = { states: {
  WA: [{ date: "2026-08-04", type: "P", district: "", offices: ["U.S. House"] }, { date: "2026-11-03", type: "G", district: "", offices: ["U.S. House"] }],
  GA: [
    { date: "2026-07-28", type: "SG", district: "13", offices: ["U.S. House"] },
    { date: "2026-08-25", type: "SR", district: "13", offices: ["U.S. House"] },
    { date: "2026-11-03", type: "G", district: "", offices: ["U.S. House", "U.S. Senate"] },
    { date: "2026-12-01", type: "GR", district: "", offices: ["U.S. Senate", "U.S. House"] },
  ],
} };

test("the window: 45 days before through Election Day, with the countdown", () => {
  assert.equal(WINDOW_DAYS, 45);
  const w = ballotWindow(DATES, "WA", "2026-10-09");
  assert.equal(w.open, true);
  assert.equal(w.line, "Election Day: Tue, Nov 3 · 25 days");
  assert.equal(ballotWindow(DATES, "WA", "2026-09-19").open, true, "45 days before");
  assert.equal(ballotWindow(DATES, "WA", "2026-09-18").open, false, "46 days before: a regular link");
  assert.equal(ballotWindow(DATES, "WA", "2026-11-02").line, "Election Day: Tue, Nov 3 · tomorrow");
  assert.equal(ballotWindow(DATES, "WA", "2026-11-03").line, "Election Day: Tue, Nov 3 · today");
  assert.equal(ballotWindow(DATES, "WA", "2026-11-04"), null, "after Election Day, nothing listed ahead");
});

test("each state's own dates: a primary, a runoff, a special election in the visitor's district", () => {
  assert.equal(ballotWindow(DATES, "WA", "2026-07-01").line, "Primary election: Tue, Aug 4 · 34 days");
  assert.equal(ballotWindow(DATES, "GA", "2026-11-10").line, "General runoff: Tue, Dec 1 · 21 days");
  assert.equal(nextElection(DATES, "GA", "2026-07-01").date, "2026-11-03", "another district's special election isn't the visitor's");
  assert.equal(nextElection(DATES, "GA", "2026-07-01", "13").date, "2026-07-28");
  assert.equal(ballotWindow(DATES, "GA", "2026-07-01", "13").line, "Special election, District 13: Tue, Jul 28 · 27 days");
  assert.equal(ballotWindow(DATES, "TX", "2026-10-09"), null, "a state with no dates listed");
});

test("today is the state's own date", () => {
  const late = new Date("2026-11-03T05:30:00Z"); // 12:30 a.m. in New York, 9:30 p.m. the night before in California
  assert.equal(todayIn("NY", late), "2026-11-03");
  assert.equal(todayIn("CA", late), "2026-11-02");
  assert.equal(daysBetween("2026-10-09", "2026-11-03"), 25);
  assert.equal(countdownLine({ date: "2026-11-03", type: "G", district: "" }, 25), "Election Day: Tue, Nov 3 · 25 days");
});
