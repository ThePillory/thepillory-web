// node --import ./test/sql-stub.mjs --test test/corrections.test.mjs
// "Report an error": the public form (functions/corrections/) and the admin
// list (functions/_lib/corrections-review.js), against an in-memory D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequestGet, onRequestPost, sitePath } from "../../../functions/corrections/index.js";
import { correctionsList, correctionChange } from "../../../functions/_lib/corrections-review.js";

function d1(sqlite) {
  const wrap = (sql, binds = []) => ({
    bind: (...b) => wrap(sql, b),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...binds).changes) } }),
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())) };
}
const seeded = () => {
  const s = new DatabaseSync(":memory:");
  s.exec(readFileSync(new URL("../migrations/0038_corrections.sql", import.meta.url), "utf8"));
  return s;
};
const ENV = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
const post = (fields, headers = {}) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("https://thepillory.test/corrections/", { method: "POST", body, headers: { "CF-Connecting-IP": "203.0.113.9", ...headers } });
};

test("a page on this site only", () => {
  const o = "https://thepillory.test";
  assert.equal(sitePath("/reps/example/", o), "/reps/example/");
  assert.equal(sitePath("https://thepillory.test/laws/bills/x/?tab=1", o), "/laws/bills/x/?tab=1");
  assert.equal(sitePath("https://elsewhere.example/reps/", o), "");
  assert.equal(sitePath("//elsewhere.example/", o), "");
  assert.equal(sitePath("/corrections/", o), "");
});

test("the form fills in the page the reader came from, and says it's in beta", async () => {
  const res = await onRequestGet({ request: new Request("https://thepillory.test/corrections/", { headers: { Referer: "https://thepillory.test/reps/example/" } }), env: ENV });
  const html = await res.text();
  assert.match(html, /ThePillory is in beta\. Every fact links to its source\./);
  assert.match(html, /name="page" value="\/reps\/example\/"/);
  assert.match(res.headers.get("Cache-Control"), /no-store/);
  const closed = await (await onRequestGet({ request: new Request("https://thepillory.test/corrections/"), env: {} })).text();
  assert.match(closed, /The form opens soon/);
});

test("a report is stored with its page and source, never who sent it; the daily limit holds", async (t) => {
  const sqlite = seeded();
  const env = { ...ENV, DB: d1(sqlite) };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true })));
  const ok = await onRequestPost({ request: post({ page: "/reps/example/", what: "The term start date is wrong.", source: "https://example.org/record", "cf-turnstile-response": "tok" }), env });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("Location"), /notice=sent/);
  const row = sqlite.prepare("SELECT * FROM corrections").get();
  assert.deepEqual([row.page, row.what, row.source_url, row.status], ["/reps/example/", "The term start date is wrong.", "https://example.org/record", "open"]);
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM correction_attempts").all()).includes("203.0.113.9"), "the address isn't kept");
  const bad = await onRequestPost({ request: post({ page: "/reps/example/", what: "", "cf-turnstile-response": "tok" }), env });
  assert.match(bad.headers.get("Location"), /notice=invalid/);
  const badSource = await onRequestPost({ request: post({ page: "/reps/example/", what: "x", source: "javascript:alert(1)", "cf-turnstile-response": "tok" }), env });
  assert.match(badSource.headers.get("Location"), /notice=invalid/);
  for (let i = 0; i < 4; i++) await onRequestPost({ request: post({ page: "/x/", what: "y", "cf-turnstile-response": "tok" }), env });
  const limited = await onRequestPost({ request: post({ page: "/x/", what: "y", "cf-turnstile-response": "tok" }), env });
  assert.match(limited.headers.get("Location"), /notice=limit/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM corrections").get().n, 5);
});

test("a person records what was done", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  sqlite.exec("INSERT INTO corrections (page, what) VALUES ('/reps/example/', 'Wrong district.')");
  assert.match((await correctionsList(db)).main, /Open \(1\)[\s\S]*Wrong district\./);
  const form = (o) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  assert.match((await correctionChange(db, 1, form({ status: "fixed", reviewer: "Rae Reviewer" }))).error, /Add a note/);
  assert.match((await correctionChange(db, 1, form({ status: "fixed", note: "District corrected from the source.", reviewer: "Rae Reviewer" }))).done, /fixed/);
  assert.match((await correctionChange(db, 1, form({ status: "fixed", note: "again", reviewer: "Rae Reviewer" }))).error, /isn't open/);
  assert.match((await correctionsList(db)).main, /Open \(0\)[\s\S]*Fixed · Rae Reviewer/);
});
