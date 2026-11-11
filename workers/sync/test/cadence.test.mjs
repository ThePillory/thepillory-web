// node --test test/cadence.test.mjs
// How often each job runs (src/cadence.js; docs/data-sync.md, "How often each source updates").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ldaDeadlines, fecDeadlines, generalElection, nextBusinessDay, inWindow, filingWindow,
  stepCadence, stepDue, stepRecord, workflowDue, STEP_CADENCE, WORKFLOW_CADENCE,
} from "../src/cadence.js";

test("deadlines come from the filing rules, weekends moved to the Monday", () => {
  assert.equal(generalElection(2026), "2026-11-03");
  assert.equal(generalElection(2028), "2028-11-07");
  assert.equal(nextBusinessDay("2026-12-05"), "2026-12-07"); // Saturday
  assert.equal(nextBusinessDay("2026-12-06"), "2026-12-07"); // Sunday
  // LD-2 on the 20th of Jan/Apr/Jul/Oct, LD-203 on Jan 30 and Jul 30 (2026: Jan 30 is a Friday; Apr 20 a Monday; Jul 20 a Monday; Jul 30 a Thursday; Oct 20 a Tuesday).
  assert.deepEqual(ldaDeadlines(2026), ["2026-01-20", "2026-01-30", "2026-04-20", "2026-07-20", "2026-07-30", "2026-10-20"]);
  // 2027: Jan 30 is a Saturday → Monday Feb 1; Jul 20 a Tuesday.
  assert.ok(ldaDeadlines(2027).includes("2027-02-01"));
  // FEC quarterly (Jan 31, Apr 15, Jul 15, Oct 15) and, in 2026, pre-general (Oct 22) and post-general (Dec 3).
  assert.deepEqual(fecDeadlines(2026), ["2026-02-02", "2026-04-15", "2026-07-15", "2026-10-15", "2026-10-22", "2026-12-03"]);
  assert.equal(fecDeadlines(2027).length, 4);
});

test("a filing window is the 7 days that start on the deadline", () => {
  assert.equal(inWindow("2026-04-20", ["2026-04-20"]), "2026-04-20");
  assert.equal(inWindow("2026-04-26", ["2026-04-20"]), "2026-04-20");
  assert.equal(inWindow("2026-04-27", ["2026-04-20"]), null);
  assert.equal(inWindow("2026-04-19", ["2026-04-20"]), null);
  assert.match(filingWindow("2026-07-31"), /2026-07-30 LDA/);
  assert.match(filingWindow("2026-12-05"), /2026-12-03 FEC/);
  assert.equal(filingWindow("2026-11-11"), null);
  // The window of a deadline in the year before reaches into January.
  assert.ok(filingWindow("2027-02-03"));
});

test("money and lobbying steps: weekly, daily in a filing window", () => {
  for (const step of ["executive-funding", "dark-money", "federal-funding", "federal-lobbying", "lobbying-contributions"]) {
    assert.ok(step in STEP_CADENCE, step);
    assert.equal(stepCadence(step, "2026-11-11").freq, "weekly");
    assert.equal(stepCadence(step, "2026-10-21").freq, "daily"); // after the Oct 20 LDA deadline
    assert.equal(stepCadence(step, "2026-12-04").freq, "daily"); // after the Dec 3 FEC post-general
  }
  assert.equal(stepCadence("issues-pages", "2026-10-21").freq, "weekly");
  assert.equal(stepCadence("candidate-platforms", "2026-10-21").freq, "weekly");
});

test("daily steps stay daily", () => {
  for (const step of ["house-votes", "senate-votes", "state-votes", "other-state-votes", "county-meetings", "executive-orders", "bill-outcomes", "source-health", "page-summaries"]) {
    assert.equal(stepCadence(step, "2026-11-11").freq, "daily", step);
    assert.equal(stepDue(step, "2026-11-11", { done: "2026-11-11" }).run, true, step);
  }
});

test("a weekly step runs 7 days after its last finished pass, and a pass at a daily limit continues the next day", () => {
  const day = "2026-11-11";
  assert.equal(stepDue("issues-pages", day, {}).run, true);
  const after = stepRecord("issues-pages", day, { status: "ok", message: "done" }, {});
  assert.deepEqual(after, { open: false, done: day });
  const next = stepDue("issues-pages", "2026-11-12", after);
  assert.equal(next.run, false);
  assert.match(next.message, /^not due: runs weekly; last finished 2026-11-11, next 2026-11-18/);
  assert.equal(stepDue("issues-pages", "2026-11-18", after).run, true);
  // At its daily limit (more: true) or stopped short (partial), the pass stays open.
  const open = stepRecord("issues-pages", day, { status: "skipped", more: true }, after);
  assert.equal(open.open, true);
  assert.equal(stepDue("issues-pages", "2026-11-12", open).run, true);
  assert.equal(stepRecord("federal-funding", day, { status: "partial", message: "lda daily limit" }, {}).open, true);
  // An error changes nothing.
  assert.deepEqual(stepRecord("issues-pages", day, { status: "error" }, after), after);
});

test("history steps: skipped as complete once loaded, until the next year", () => {
  const s = stepRecord("history-votes", "2026-11-11", { status: "ok", message: "caught up to 2001" }, {});
  assert.equal(s.complete, "2026");
  const d = stepDue("history-votes", "2026-11-12", s);
  assert.equal(d.run, false);
  assert.match(d.message, /^complete: fully loaded on 2026-11-11/);
  assert.equal(stepDue("history-votes", "2027-01-01", s).run, true);
  // Still loading, or skipped for a missing key: not complete.
  assert.equal(stepRecord("history-votes", "2026-11-11", { status: "partial" }, {}).complete, undefined);
  assert.equal(stepRecord("history-funding", "2026-11-11", { status: "skipped", message: "FEC_API_KEY is not set" }, {}).complete, undefined);
});

const DATES = { states: { CA: [{ date: "2026-06-02", type: "P" }, { date: "2026-11-03", type: "G" }], TX: [{ date: "2026-03-03", type: "P" }, { date: "2026-11-03", type: "G" }] } };
const monday = "2026-11-16";
const tuesday = "2026-11-17";

test("workflows: weekly on Mondays, daily in their windows", () => {
  for (const job of Object.keys(WORKFLOW_CADENCE)) assert.equal(workflowDue(job, monday, { dates: { states: {} } }).run, true, job);
  // Candidate data: daily for 7 days after an FEC deadline.
  assert.equal(workflowDue("candidates", "2026-10-16").run, true);
  assert.equal(workflowDue("candidates", "2026-11-11").run, false);
  // Election data: daily until California certifies (38 days after Nov 3 = Dec 11), from 60 days before.
  assert.equal(workflowDue("elections", tuesday, { dates: DATES }).run, true);
  assert.match(workflowDue("elections", tuesday, { dates: DATES }).why, /certified \(2026-12-11\)/);
  assert.equal(workflowDue("elections", "2026-12-11", { dates: DATES }).run, true);
  assert.equal(workflowDue("elections", "2026-12-15", { dates: DATES }).run, false);
  assert.equal(workflowDue("elections", "2026-09-04", { dates: DATES }).run, true); // 60 days before Nov 3
  assert.equal(workflowDue("elections", "2026-09-01", { dates: DATES }).run, false);
  // Another state's primary doesn't make the election data daily; its general does.
  assert.equal(workflowDue("elections", "2026-02-24", { dates: DATES }).run, false);
  // Constitution sections: weekly.
  assert.equal(workflowDue("measure-constitution", tuesday).run, false);
  // Net worth: daily May 1 – Aug 31.
  assert.equal(workflowDue("networth", "2026-05-01").run, true);
  assert.equal(workflowDue("networth", "2026-08-31").run, true);
  assert.equal(workflowDue("networth", "2026-09-01").run, false);
  // The Supreme Court: daily October – June, weekly July – September.
  assert.equal(workflowDue("scotus", "2026-10-07").run, true);
  assert.equal(workflowDue("scotus", "2026-06-30").run, true);
  assert.equal(workflowDue("scotus", "2026-07-07").run, false);
  assert.match(workflowDue("scotus", "2026-07-07").why, /next run 2026-07-13/);
});
