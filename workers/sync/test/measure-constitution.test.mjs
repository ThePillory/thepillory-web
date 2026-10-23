// node --import ./test/sql-stub.mjs --test test/measure-constitution.test.mjs
// Ballot measures' Constitution section (migration 0041): the line rule, the
// all-at-once publish gate, the section's layout, the review page's approve /
// send back / court-record actions, and the post-election analysis queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { lineProblem, publishedSection, constitutionSection, NOT_ADVICE } from "../../../functions/_lib/measure-constitution.js";
import { measureReviewChange, measureReviewList, measureReviewHref } from "../../../functions/_lib/measure-review.js";
import { nextMeasures, measureSource, MEASURE_PREFIX } from "../src/analysis/measures.js";

function d1(sqlite) {
  const wrap = (sql, binds = []) => ({
    bind: (...b) => wrap(sql, b),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...binds).changes) } }),
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())) };
}

const PROVISIONS = [
  { label: "Article XIII A, Section 1", url: "https://thepillory.co/laws/constitution/", quote: "(a) The maximum amount of any ad valorem tax", line: "This measure amends this section." },
  { label: "Article II, Section 8", url: "https://example.gov/ca", quote: "", line: "This measure is proposed under this section." },
];
const CASES = [{ name: "Doe v. State", court: "Superior Court", filed: "2026-08-01", url: "https://www.courtlistener.com/docket/1/" }];

function seeded(total = 2) {
  const s = new DatabaseSync(":memory:");
  s.exec(readFileSync(new URL("../migrations/0041_measure_constitution.sql", import.meta.url), "utf8"));
  s.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)");
  s.exec("CREATE TABLE bill_analyses (id INTEGER PRIMARY KEY, bill_id TEXT)");
  s.exec("CREATE TABLE analysis_attempts (bill_id TEXT PRIMARY KEY, last_attempt TEXT)");
  s.prepare("INSERT INTO sync_state VALUES ('measure_constitution_total', ?)").run(String(total));
  const add = s.prepare(`INSERT INTO measure_constitution (measure_key, election_id, measure_id, state, label, changes, changes_quote, changes_source, changes_source_url, provisions, cases, model, prompt_version)
    VALUES (?, '2026-11-03-ca', ?, 'CA', ?, 'constitution', 'ACA 1', 'Official Voter Information Guide', 'https://voterguide.sos.ca.gov/', ?, ?, 'm', 'p')`);
  add.run("2026-11-03-ca/prop-1", "prop-1", "Proposition 1", JSON.stringify(PROVISIONS), JSON.stringify(CASES));
  add.run("2026-11-03-ca/prop-2", "prop-2", "Proposition 2", "[]", "[]");
  return s;
}

const form = (fields) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) f.append(k, x);
  return f;
};
const approve = (db, key, extra = {}) => measureReviewChange(db, key, form({ action: "approve", reviewer: "Reviewer", checked: "1", keep: ["0", "1"], case: "0", ...extra }), "r@example.com");

test("a provision's line: one short neutral sentence about what the measure does", () => {
  assert.equal(lineProblem("This measure amends this section."), "");
  assert.equal(lineProblem("The measure's tax is levied under this section."), "");
  assert.match(lineProblem("Amends this section."), /start the line/);
  assert.match(lineProblem("This measure amends this section"), /period/);
  assert.match(lineProblem("This measure protects taxpayers under this section."), /protects/);
  assert.match(lineProblem("This measure may be unconstitutional under this section."), /unconstitutional/);
  assert.match(lineProblem(`This measure ${"amends ".repeat(30)}this section.`), /30 words/);
});

test("nothing is published until every measure is approved, then all are", async () => {
  const s = seeded();
  const db = d1(s);
  assert.equal(await publishedSection(db, "2026-11-03-ca", "prop-1"), null);
  assert.deepEqual(await approve(db, "2026-11-03-ca/prop-1"), { done: "Approved by Reviewer." });
  assert.equal(await publishedSection(db, "2026-11-03-ca", "prop-1"), null, "one of two approved: still held");
  await approve(db, "2026-11-03-ca/prop-2");
  const row = await publishedSection(db, "2026-11-03-ca", "prop-1");
  assert.equal(row.reviewed_by, "Reviewer");
  // A measure the tool counted but hasn't drafted yet holds them all back.
  s.prepare("UPDATE sync_state SET value = '3'").run();
  assert.equal(await publishedSection(db, "2026-11-03-ca", "prop-1"), null);
  // Missing tables: nothing, never an error.
  assert.equal(await publishedSection(d1(new DatabaseSync(":memory:")), "x", "y"), null);
});

test("approve: the box, the lines, what's kept, and a history row", async () => {
  const s = seeded();
  const db = d1(s);
  const key = "2026-11-03-ca/prop-1";
  assert.match((await measureReviewChange(db, key, form({ action: "approve", reviewer: "" }), "")).error, /name/);
  assert.match((await measureReviewChange(db, key, form({ action: "approve", reviewer: "R" }), "")).error, /Tick the box/);
  assert.match((await approve(db, key, { "line-0": "This measure erodes this section." })).error, /Article XIII A, Section 1/);
  assert.equal(s.prepare("SELECT status FROM measure_constitution WHERE measure_key = ?").get(key).status, "pending");
  await approve(db, key, { keep: "0", "line-0": "This measure adds a subdivision to this section.", case: [] });
  const r = s.prepare("SELECT * FROM measure_constitution WHERE measure_key = ?").get(key);
  assert.equal(r.status, "approved");
  assert.equal(r.version, 2);
  assert.deepEqual(JSON.parse(r.provisions).map((p) => p.line), ["This measure adds a subdivision to this section."]);
  assert.deepEqual(JSON.parse(r.cases), []);
  const h = s.prepare("SELECT * FROM measure_constitution_history WHERE measure_key = ?").all(key);
  assert.equal(h.length, 1);
  assert.equal(h[0].by_whom, "Reviewer <r@example.com>");
});

test("send back needs a note; new court records wait without unpublishing", async () => {
  const s = seeded();
  const db = d1(s);
  const key = "2026-11-03-ca/prop-2";
  assert.match((await measureReviewChange(db, key, form({ action: "reject", reviewer: "R" }), "")).error, /Say what needs changing/);
  await measureReviewChange(db, key, form({ action: "reject", reviewer: "R", note: "Cite Article XIII." }), "");
  assert.equal(s.prepare("SELECT status, review_note FROM measure_constitution WHERE measure_key = ?").get(key).review_note, "Cite Article XIII.");
  await approve(db, key);
  s.prepare("UPDATE measure_constitution SET cases_new = ? WHERE measure_key = ?").run(JSON.stringify([...CASES, { ...CASES[0], name: "Roe v. State" }]), key);
  assert.match((await measureReviewList(db)).main, /New court records \(1\)/);
  const out = await measureReviewChange(db, key, form({ action: "add_cases", reviewer: "R", new: "1" }), "");
  assert.equal(out.done, "1 court record(s) added, 1 dismissed.");
  const r = s.prepare("SELECT * FROM measure_constitution WHERE measure_key = ?").get(key);
  assert.equal(r.status, "approved");
  assert.deepEqual(JSON.parse(r.cases).map((c) => c.name), ["Roe v. State"]);
  assert.equal(r.cases_new, "[]");
});

test("the section: the same parts for every measure, and the line", () => {
  const row = { changes: "constitution", changes_quote: "ACA 1", changes_source: "Official Voter Information Guide", changes_source_url: "https://voterguide.sos.ca.gov/", provisions: JSON.stringify(PROVISIONS), cases: "[]", cases_checked_at: "2026-10-20 15:00:00", reviewed_by: "Reviewer", reviewed_at: "2026-10-22 10:00:00" };
  const html = constitutionSection(row, { stateName: "California", label: "Proposition 1" });
  for (const part of ["What it changes", "Constitutional provisions it touches", "Legal challenges", NOT_ADVICE, "This measure amends the California Constitution.", "reviewed by Reviewer"]) assert.ok(html.includes(part), part);
  assert.match(html, /No court records that mention Proposition 1 were found on CourtListener, as of/);
  assert.match(html, /The full text is on the state's official site/);
  assert.doesNotMatch(html, /aligns|tension/i);
  const none = constitutionSection({ ...row, changes: "statute", provisions: "[]", cases: JSON.stringify(CASES) }, { stateName: "Colorado", label: "Amendment A" });
  assert.match(none, /doesn't cite a provision of the U\.S\. Constitution or the Colorado Constitution/);
  assert.match(none, /Doe v\. State/);
  assert.equal(constitutionSection(null, {}), "");
  assert.equal(measureReviewHref("2026-11-03-ca/prop-1"), "/admin/review/measures/2026-11-03-ca/prop-1/");
});

test("the three-panel analysis waits for the day after the election", async () => {
  const s = seeded();
  const db = d1(s);
  s.prepare(`INSERT INTO measure_analysis_queue (measure_key, election_id, measure_id, state, label, title, text_url, text, not_before)
    VALUES ('2026-11-03-ca/prop-1', '2026-11-03-ca', 'prop-1', 'CA', 'Proposition 1', 'Title', 'https://voterguide.sos.ca.gov/', 'The text.', '2026-11-04')`).run();
  assert.deepEqual(await nextMeasures(db, 10, "2026-11-03"), []);
  const [m] = await nextMeasures(db, 10, "2026-11-04");
  assert.equal(m.id, `${MEASURE_PREFIX}2026-11-03-ca/prop-1`);
  assert.equal(m.kind, "measure");
  assert.equal(m.depth, "full");
  assert.equal(measureSource(m.queued).text, "The text.");
  s.prepare("INSERT INTO bill_analyses (bill_id) VALUES (?)").run(m.id);
  assert.deepEqual(await nextMeasures(db, 10, "2026-11-05"), [], "drafted once");
});
