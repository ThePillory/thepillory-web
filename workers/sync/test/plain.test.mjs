// node --import ./test/sql-stub.mjs --test test/plain.test.mjs
// Simple mode: the checks every plain rewrite must pass (src/plain/check.js),
// the step that writes them (src/plain/sync.js) with a fake model and an
// in-memory SQLite stand-in for D1, and the plain pieces of the pages
// (functions/_lib/simple.js), the glossary file, and the Simple cards on the
// Court, case, measure and ballot pages. Every bill, name and number here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { plainProblems, readingGrade, numbersIn, namesIn } from "../src/plain/check.js";
import { billSource, measureSource, rewrite, syncPlainSummaries } from "../src/plain/sync.js";
import { Budget } from "../src/util.js";
import { billStands, repVotesPlain, jobSentence, voteLinePlain, moneyLinePlain, plainLead, simpleCard } from "../../../functions/_lib/simple.js";

const SOURCE = "This bill requires the Department of Example to publish a yearly report on bridge repairs and provides $2,000,000 for inspections in fiscal year 2027.";

test("the checks: short, readable, no new facts, neutral, balanced", () => {
  assert.deepEqual(plainProblems({ what: "It makes the Department of Example post a report on bridge repairs each year. It also pays $2,000,000 for checks." }, SOURCE), []);
  assert.ok(plainProblems({ what: "It pays $5,000,000 for inspections." }, SOURCE).some((p) => /number not in the source: 5000000/.test(p)));
  assert.ok(plainProblems({ what: "It makes Senator Smith post a report." }, SOURCE).some((p) => /name not in the source: Smith/.test(p)));
  assert.ok(plainProblems({ what: "A common-sense fix that makes the Department of Example post reports." }, SOURCE).some((p) => /loaded/.test(p)));
  assert.ok(plainProblems({ what: "The aforementioned appropriation notwithstanding subsequent administrative determinations necessitates comprehensive infrastructural evaluation." }, SOURCE).some((p) => /reads above grade/.test(p)));
  assert.ok(plainProblems({ what: "It posts reports.", supporters: "Reports help.", critics: "" }, SOURCE).some((p) => /no sides/.test(p)));
  const sides = { what: "It posts reports on bridge repairs.", supporters: "Supporters say reports show where repairs are needed.", critics: "Critics say the reports cost money and take staff time." };
  assert.deepEqual(plainProblems(sides, SOURCE + " Supporters say reports show where repairs are needed. Critics say the reports cost money.", { sides: true }), []);
  assert.ok(plainProblems({ ...sides, critics: "Critics say the reports cost money and take staff time away from other work that the department has to do every single week." }, SOURCE, { sides: true }).some((p) => /unequal length|too long/.test(p)));
  assert.ok(plainProblems({ what: "It posts reports on bridge repairs." }, SOURCE, { sides: true }).some((p) => /keep both/.test(p)));
  assert.deepEqual(numbersIn("$11.25 billion in 2,000 places, 5%"), ["11.25", "2000", "5"]);
  assert.deepEqual(namesIn("It helps. The Department of Example pays the President."), ["Department", "Example", "President"]);
  assert.ok(readingGrade("It pays for bridge checks.") < 6);
});

test("sources: the same summary the page shows", () => {
  assert.equal(billSource({ summary: "", official_summary: "Existing law does X. This bill would require Y.", official_summary_label: "Legislative Counsel's Digest" }).text, "This bill would require Y.");
  assert.match(billSource({ official_summary: SOURCE, official_summary_label: "CRS summary (Introduced)" }).source_label, /Congressional Research Service/);
  const fromAnalysis = billSource({}, { plain_summary: "It does Y.", supporters: "S says.", critics: "C says." });
  assert.equal(fromAnalysis.supporters, "S says.");
  assert.equal(billSource({}, null), null);
  assert.match(measureSource({}, { scope: "statewide", summary: "Put on the Ballot by Petition Signatures Makes permanent existing tax rates." }).text, /^Makes permanent/);
  assert.equal(measureSource({}, { ballot_title: { description: "This measure would repeal a tax." } }).text, "This measure would repeal a tax.");
});

const fakeCall = (answer) => async () => ({ data: answer, model: "test-model" });

test("a rewrite is kept only when the checks pass", async () => {
  const item = { kind: "bill", id: "us-1", describe: "a bill", text: SOURCE, source_label: "the CRS summary" };
  const ok = await rewrite({}, item, { call: fakeCall({ what: "It makes the Department of Example post a yearly report on bridge repairs.", supporters: "", critics: "" }) });
  assert.ok(ok.row && ok.row.what);
  const bad = await rewrite({}, item, { call: fakeCall({ what: "It gives $9 to Acme Corp.", supporters: "", critics: "" }) });
  assert.ok(bad.problems.length >= 2);
});

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0023_plain_summaries.sql", import.meta.url), "utf8"));
  sqlite.exec(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE bills (id TEXT PRIMARY KEY, title TEXT, level TEXT, summary TEXT, official_summary TEXT, official_summary_label TEXT);
    CREATE TABLE bill_list (bill_id TEXT, last_final TEXT);
    CREATE TABLE bill_analyses (bill_id TEXT, current INTEGER, status TEXT, ai_review TEXT, plain_summary TEXT, supporters TEXT, critics TEXT);
    CREATE TABLE executive_actions (id TEXT PRIMARY KEY, title TEXT, signed_on TEXT);
    INSERT INTO bills VALUES ('us-1', 'Bridge Reports Act', 'federal', NULL, '${SOURCE}', 'CRS summary (Introduced)');
    INSERT INTO bills VALUES ('us-2', 'Other Act', 'federal', NULL, NULL, NULL);
    INSERT INTO bill_list VALUES ('us-1', '2026-09-01'), ('us-2', '2026-09-02');
    INSERT INTO bill_analyses VALUES ('us-2', 1, 'ai_draft', 'flag', 'Not public yet.', '', '');`);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { sqlite, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

test("the step writes checked rewrites, skips items without a public source, and doesn't redo them", async () => {
  const db = d1();
  const budget = new Budget({ MAX_SUBREQUESTS: "10" }, 60000);
  const env = { PLAIN_DAILY: "5", PLAIN_ELECTIONS: "" };
  const r = await syncPlainSummaries(env, db, budget, { call: fakeCall({ what: "It makes the Department of Example post a yearly report on bridge repairs.", supporters: "", critics: "" }) });
  assert.equal(r.status, "ok");
  const rows = db.sqlite.prepare("SELECT kind, item_id, what, source_label FROM plain_summaries").all();
  assert.equal(rows.length, 1, "only the bill with a public source");
  assert.equal(rows[0].item_id, "us-1");
  assert.match(rows[0].source_label, /Congressional Research Service/);
  let calls = 0;
  await syncPlainSummaries(env, db, budget, { call: async (...a) => (calls++, fakeCall({ what: "x" })(...a)) });
  assert.equal(calls, 0, "the same source isn't rewritten again");
});

test("plain pieces of the pages", () => {
  assert.equal(billStands({ federal: true, chambers: ["us-house", "us-senate"], outcome: { outcome: { outcome: "signed", action_date: "2026-07-04" } }, votes: [] }), "Became law on Jul 4, 2026.");
  assert.equal(billStands({ federal: true, chambers: ["us-house", "us-senate"], outcome: null, votes: [{ vote_type: "final_passage", chamber: "us-senate", result: "Passed", vote_date: "2026-09-01" }] }), "Passed the Senate on Sep 1, 2026. Waiting on the House.");
  assert.equal(billStands({ federal: false, chambers: ["ca-assembly", "ca-senate"], outcome: { outcome: { outcome: "vetoed", action_date: "2026-09-30" } }, votes: [] }), "Vetoed by the Governor on Sep 30, 2026.");
  assert.equal(billStands({ federal: true, chambers: ["us-house", "us-senate"], outcome: null, votes: [] }), "No final vote yet.");
  assert.match(repVotesPlain({ districts: null }), /Find your representatives/);
  const votes = [{ vote_type: "final_passage", chamber: "us-house", positions: [{ slug: "a-b", position: "Yes" }] }];
  assert.match(repVotesPlain({ districts: { st: "ZZ" }, reps: [{ slug: "a-b", name: "A B", chamber: "us-house" }, { slug: "c-d", name: "C D", chamber: "us-senate" }], chambers: ["us-house", "us-senate"], votes }), /A B<\/a> voted Yes\.<\/li><li>.*C D<\/a> has no final vote recorded/);
  assert.match(jobSentence({ chamber: "us-senate" }), /One of 100 U\.S\. senators/);
  assert.match(jobSentence({ chamber: "tx-lower", office: "State Representative" }, "Texas"), /Texas's state House/);
  assert.match(voteLinePlain({ position: "No", bill_id: "us-1", bill_number: "H.R. 1", bill_title: "Example Act", result: "Passed", vote_date: "2026-01-02" }), /^Voted No on <a[^>]+>H\.R\. 1<\/a> \(Example Act\)\. It passed\./);
  assert.equal(moneyLinePlain({ receipts: 100, individual_unitemized: 60, pac: 40 }, "2025–2026"), "Raised $100 in 2025–2026, mostly from small donors ($200 or less).");
  assert.equal(moneyLinePlain({ receipts: 0 }, "x"), null);
  const lead = plainLead({ what: "It does X.", supporters: "A.", critics: "B.", source_label: "the CRS summary" }, null);
  assert.match(lead.source, /Simplified by AI from the CRS summary/);
  assert.equal(lead.extra.length, 2);
  assert.match(plainLead(null, { text: "First. Second.", source: "From X." }).html, /^First\.$/);
  const card = simpleCard({ lines: [["What it does", "It does X."], ["Empty", ""]], source: "From X." });
  assert.match(card, /class="card stack simple-card simple-only"/);
  assert.match(card, /data-mode-set="detailed"/);
  assert.doesNotMatch(card, /Empty/);
});

test("the glossary: one reviewable file, one sentence each, every Constitution id real", () => {
  const g = JSON.parse(readFileSync(new URL("../../../data/glossary.json", import.meta.url), "utf8"));
  const ids = new Set(JSON.parse(readFileSync(new URL("../../../data/constitution.json", import.meta.url), "utf8")).provisions.map((p) => p.id));
  for (const t of g.terms) {
    assert.ok(t.term && t.definition, t.term);
    assert.ok(t.definition.length < 220, `${t.term}: short`);
  }
  for (const id of ["cloture", "veto override", "committee", "roll call", "ballot measure"]) assert.ok(g.terms.some((t) => t.term === id), id);
  for (const id of Object.keys(g.constitution)) assert.ok(ids.has(id), id);
  assert.equal(g.constitution["amend-1"], "Speech, religion, press, assembly");
});

// The Simple cards on pages built from the site's static files.
const ROOT = new URL("../../../", import.meta.url);
const env = { ASSETS: { fetch: async (u) => { const f = new URL(`.${new URL(u).pathname}`, ROOT); return existsSync(f) ? new Response(readFileSync(f, "utf8")) : new Response("nf", { status: 404 }); } } };
async function get(mod, path) {
  const { onRequestGet } = await import(mod);
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await onRequestGet({ request, env, params: { path: parts }, waitUntil: () => {} });
  return res.status === 200 ? res.text() : "";
}

test("Simple cards on the Supreme Court, a case, a measure and the ballot preview", async () => {
  const court = await get("../../../functions/bodies/[[path]].js", "/bodies/us-supreme-court/");
  assert.match(court, /<div class="simple-scope">/);
  assert.match(court, /simple-card simple-only[\s\S]*What it is[\s\S]*Latest decisions/);
  const prop = await get("../../../functions/elections/[[path]].js", "/elections/2026-11-03/measure/prop-1/");
  assert.match(prop, /simple-card[\s\S]*What it does[\s\S]*A Yes vote means[\s\S]*A No vote means[\s\S]*Where it stands/);
  assert.match(prop, /word for word from the official guide/);
  const ballot = await get("../../../functions/ballot/[[path]].js", "/ballot/ca/");
  assert.match(ballot, /simple-card[\s\S]*What&#x27;s on it[\s\S]*statewide offices/);
  assert.match(ballot, /class="stack-sm simple-keep" id="statewide"/);
  assert.match(ballot, /lookup simple-keep" id="address"/);
});
