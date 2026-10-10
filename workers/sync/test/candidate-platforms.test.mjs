// node --import ./test/sql-stub.mjs --test test/candidate-platforms.test.mjs
// The candidate-platforms step (src/promises/candidates-sync.js) against an
// in-memory SQLite stand-in for D1 and fake websites: the same finder and
// excerpt checks as officials; one site per candidate per day within the cap;
// removed pages never come back. Every site and name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Budget } from "../src/util.js";
import { syncCandidatePlatforms } from "../src/promises/candidates-sync.js";
import { excerptInstructions, EXCERPT_INSTRUCTIONS, checkExcerpt } from "../src/promises/excerpt.js";
import { candidatePlatform } from "../../../functions/_lib/candidates.js";

// D1's prepare/bind/first/all/run/batch over node:sqlite.
function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0022_candidate_platforms.sql", import.meta.url), "utf8"));
  sqlite.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT); CREATE TABLE promise_pages_removed (url TEXT PRIMARY KEY, official_id TEXT, removed_by TEXT, removed_at TEXT)");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { sqlite, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const ISSUES = `<html><head><title>Issues</title></head><body><h1>Issues</h1><p>Our campaign will focus on three things. We will fix the bridges in every county by 2028. We will open two new clinics.</p><p>${"More text about the plan. ".repeat(20)}</p></body></html>`;
const SITES = {
  "https://alpha.example/": '<html><body><a href="/issues">Issues</a></body></html>',
  "https://alpha.example/issues": ISSUES,
  "https://bravo.example/": "<html><body><a href='/about'>About</a></body></html>",
  "https://charlie.example/": '<html><body><a href="/priorities">Priorities</a></body></html>',
  "https://charlie.example/priorities": ISSUES.replace(/Issues/g, "Priorities"),
};
const WEBSITES = {
  year: 2026,
  candidates: [
    { id: "S6ZZ00001", name: "ALPHA, ANN", st: "ZZ", url: "https://alpha.example/" },
    { id: "S6ZZ00002", name: "BRAVO, BO", st: "ZZ", url: "https://bravo.example/" },
    { id: "S6ZZ00003", name: "CHARLIE, CY", st: "ZZ", url: "https://charlie.example/" },
  ],
};
const budget = () => {
  const b = new Budget({ MAX_SUBREQUESTS: "100", FETCH_RETRIES: "0" }, 60000);
  b.fetchImpl = async (url) => {
    if (url === "https://thepillory.test/data/candidates/2026/websites.json") return new Response(JSON.stringify(WEBSITES));
    return SITES[url] ? new Response(SITES[url], { headers: { "Content-Type": "text/html" } }) : new Response("missing", { status: 404 });
  };
  return b;
};
const asked = [];
const pick = async (env, page, who, kind) => {
  asked.push([who.name, kind]);
  return { ...checkExcerpt(page.text, "We will fix the bridges in every county by 2028. We will open two new clinics."), model: "test-model" };
};
const env = { SITE_URL: "https://thepillory.test", CANDIDATE_PLATFORMS_DAILY: "2" };

test("the same excerpt rules for candidates as officials", () => {
  assert.match(EXCERPT_INSTRUCTIONS, /from an official's own Issues/);
  const c = excerptInstructions("candidate");
  assert.match(c, /from a candidate's own Issues/);
  assert.match(c, /Choose the same way for every candidate, whatever their office or party/);
  assert.equal(c.replace(/candidate/g, "official"), EXCERPT_INSTRUCTIONS.replace(/an official/g, "a official"));
});

test("searches campaign sites in turn, within the daily cap, and excerpts word for word", async () => {
  const db = d1();
  const r1 = await syncCandidatePlatforms(env, db, budget(), { pick });
  assert.equal(r1.status, "ok");
  const rows = db.sqlite.prepare("SELECT candidate_id, result, page_url, excerpt, excerpt_by FROM candidate_platforms ORDER BY candidate_id").all();
  assert.equal(rows[0].result, "found");
  assert.equal(rows[0].page_url, "https://alpha.example/issues");
  assert.equal(rows[0].excerpt, "We will fix the bridges in every county by 2028. We will open two new clinics.");
  assert.equal(rows[0].excerpt_by, "test-model");
  assert.equal(rows[1].result, "none", "no issues page on the site");
  assert.equal(rows[2].result, null, "the third waits for tomorrow (cap 2)");
  assert.deepEqual(asked[0], ["ALPHA, ANN", "candidate"]);
  const r2 = await syncCandidatePlatforms(env, db, budget(), { pick });
  assert.equal(r2.status, "skipped", "the day's cap is used");
});

test("a page a person removed isn't found again", async () => {
  const db = d1();
  db.sqlite.prepare("INSERT INTO promise_pages_removed (url, official_id) VALUES ('https://alpha.example/issues', 'S6ZZ00001')").run();
  await syncCandidatePlatforms({ ...env, CANDIDATE_PLATFORMS_DAILY: "5" }, db, budget(), { pick });
  const a = db.sqlite.prepare("SELECT result, page_url, excerpt FROM candidate_platforms WHERE candidate_id = 'S6ZZ00001'").get();
  assert.equal(a.result, "none");
  assert.equal(a.page_url, null);
  assert.equal(a.excerpt, null);
  assert.equal(db.sqlite.prepare("SELECT result FROM candidate_platforms WHERE candidate_id = 'S6ZZ00003'").get().result, "found");
});

test("the Platform tab says what was found, the same way for everyone", () => {
  const found = candidatePlatform("Ann Alpha", "https://alpha.example/", { result: "found", page_url: "https://alpha.example/issues", title: "Issues", excerpt: "We will fix the bridges.", excerpt_at: "2026-10-10 00:00:00", excerpt_by: "m", checked_at: "2026-10-10" });
  assert.match(found, /In their own words/);
  assert.match(found, /<blockquote class="promise-quote">“We will fix the bridges\.”<\/blockquote>/);
  assert.match(found, /checked word for word against the page/);
  const hidden = candidatePlatform("Ann Alpha", "https://alpha.example/", { result: "found", page_url: "https://alpha.example/issues", excerpt: "X", excerpt_by: "hidden", checked_at: "2026-10-10" });
  assert.doesNotMatch(hidden, /blockquote/);
  assert.match(candidatePlatform("Bo Bravo", "https://bravo.example/", { result: "none", checked_at: "2026-10-10" }), /No issues page found/);
  assert.match(candidatePlatform("Cy Charlie", "https://charlie.example/", null), /hasn't been searched/);
  assert.match(candidatePlatform("Di Delta", null, null), /No campaign website is listed/);
  assert.match(candidatePlatform("Ed Echo", null, null, { state: true }), /certified candidate list doesn't include campaign websites/);
});
