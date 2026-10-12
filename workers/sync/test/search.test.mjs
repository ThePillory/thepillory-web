// Tests for the global search's server side (functions/_lib/people-search.js,
// /api/search-officials?q=): bills by number or title and meetings, each bounded,
// and the bill-number index (migration 0032) actually used. Every row is FAKE.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { numberKey, searchAll, GLOBAL_LIMIT } from "../../../functions/_lib/people-search.js";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE officials (id TEXT, slug TEXT, name TEXT, last_name TEXT, office TEXT, district TEXT, chamber TEXT, active INTEGER);
    CREATE TABLE bill_list (bill_id TEXT PRIMARY KEY, level TEXT, bill_number TEXT, title TEXT, last_vote TEXT, st TEXT);
    CREATE TABLE meetings (id TEXT, body TEXT, meeting_type TEXT, starts_at TEXT, level TEXT, status TEXT);
    INSERT INTO officials VALUES ('o1', 'ann-example', 'Ann Example', 'Example', 'U.S. Representative', 'CA-5', 'us-house', 1);
    INSERT INTO meetings VALUES ('m1', 'Board of Supervisors', 'Regular Meeting', date('now', '+3 days'), 'county', 'scheduled'),
                                ('m2', 'Board of Supervisors', 'Regular Meeting', date('now', '-400 days'), 'county', 'held');`);
  sqlite.exec(readFileSync(new URL("../migrations/0032_bill_number_search.sql", import.meta.url), "utf8"));
  const ins = sqlite.prepare("INSERT INTO bill_list VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("us-119-hr-1234", "federal", "H.R. 1234", "Example Water Infrastructure Act", "2026-05-01", null);
  ins.run("us-118-hr-1234", "federal", "H.R. 1234", "An older bill with the same number", "2024-05-01", null);
  ins.run("ca-20252026-ab-5", "state", "AB 5", "Example labor bill", "2026-04-01", "CA");
  for (let i = 0; i < 30; i++) ins.run(`us-119-s-${i}`, "federal", `S. ${i}`, `Example water bill ${i}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, null);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { sqlite, prepare: (sql) => stmt(sql) };
}
// No justices or candidates files here: those parts come back empty.
const request = new Request("https://example.test/");
const env = (db) => ({ DB: db, ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } });

test("a bill number is recognized however it's typed", () => {
  assert.equal(numberKey("H.R. 1234"), "hr1234");
  assert.equal(numberKey("hr1234"), "hr1234");
  assert.equal(numberKey("AB 5"), "ab5");
  assert.equal(numberKey("S. 5"), "s5");
  assert.equal(numberKey("water 2026"), null);
  assert.equal(numberKey("Ann Example"), null);
});

test("search finds a rep, a bill by number (newest first) and by title, and a coming meeting; never more than the cap", async () => {
  const db = d1();
  const r = await searchAll(env(db), request, "hr 1234");
  assert.deepEqual(r.bills.map((b) => b.href), ["/laws/bills/us-119-hr-1234/", "/laws/bills/us-118-hr-1234/"]);
  assert.equal(r.bills[0].name, "H.R. 1234: Example Water Infrastructure Act");
  assert.equal((await searchAll(env(db), request, "AB5")).bills[0].sub, "State · CA");
  assert.equal((await searchAll(env(db), request, "ann exam")).officials[0].href, "/reps/ann-example/");
  const water = await searchAll(env(db), request, "water");
  assert.equal(water.bills.length, GLOBAL_LIMIT);
  const meet = await searchAll(env(db), request, "supervisors");
  assert.deepEqual(meet.meetings.map((m) => m.href), ["/meetings/m1/"]);
  assert.equal(await searchAll(env(db), request, "a"), null);
});

test("the number lookup uses the index, not a scan of every bill", () => {
  const db = d1();
  const plan = db.sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT bill_id FROM bill_list WHERE lower(replace(replace(bill_number, '.', ''), ' ', '')) = ? ORDER BY last_vote DESC LIMIT 8")
    .all("hr1234")
    .map((r) => r.detail)
    .join(" ");
  assert.match(plan, /USING INDEX bill_list_number_key/);
});
