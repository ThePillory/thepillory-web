// /status stays light (src/status.js): the big tables are counted once per sync round into
// status_counts, /status reads only that and indexed queries, and a busy database gives a note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { statusReport, recordStatusCounts, LIVE, BUSY, COUNTED } from "../src/status.js";
import { withRetry, isOverloaded, OVERLOAD_RETRY } from "../src/d1retry.js";
import { isTemporary } from "../src/util.js";

const MIG = new URL("../migrations/", import.meta.url);
const BIG = /\b(votes|vote_positions|state_positions|bills|bill_list)\b/;

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  return sqlite;
}
function d1(sqlite, seen = [], fail = null) {
  const wrap = (sql, binds = []) => {
    const go = (fn) => {
      seen.push(sql);
      if (fail && fail(sql)) throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
      return fn(sqlite.prepare(sql));
    };
    return {
      bind: (...b) => wrap(sql, b),
      all: async () => go((st) => ({ results: st.all(...binds), meta: {} })),
      first: async () => go((st) => st.get(...binds) ?? null),
      run: async () => go((st) => ({ meta: { changes: Number(st.run(...binds).changes) } })),
      _run: () => go((st) => st.run(...binds)),
    };
  };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._run()) };
}

test("/status never counts or reads the big tables", async () => {
  const sqlite = fresh();
  const seen = [];
  await statusReport(d1(sqlite, seen));
  assert.ok(seen.length >= 4);
  for (const sql of seen) assert.doesNotMatch(sql.replace(/status_counts|ai_review/g, ""), BIG, sql);
  // And the Worker's /status handler has no COUNT of its own: only src/status.js's COUNTED does.
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const handler = index.slice(index.indexOf("// /status"), index.indexOf("recent_log: report.recent_log"));
  assert.doesNotMatch(handler, /COUNT\(/);
});

test("counts recorded once per round are read back with as of", async () => {
  const sqlite = fresh();
  sqlite.exec(`INSERT INTO votes (id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES
    ('v1', 'federal', 'us-house', '2026-11-12', 'On Passage', 'final_passage', 'Passed', 'https://clerk.house.gov/Votes/1')`);
  const db = d1(sqlite);
  assert.equal(await recordStatusCounts(db, "2026-11-14T05:00:00Z"), COUNTED.length);
  const r = await statusReport(db);
  assert.equal(r.counts.votes, 1);
  assert.equal(r.counts.positions, 0);
  assert.equal(r.counts_as_of, "2026-11-14T05:00:00Z");
  assert.equal(r.note, undefined);
  // A second round updates the time, not a new row.
  await recordStatusCounts(db, "2026-11-14T06:00:00Z");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM status_counts").get().n, COUNTED.length);
  assert.equal((await statusReport(db)).counts_as_of, "2026-11-14T06:00:00Z");
});

test("before the first count, /status says so", async () => {
  const r = await statusReport(d1(fresh()));
  assert.match(r.counts_note, /Not counted yet/);
  assert.equal(r.counts.analyses_flagged_by_ai, 0);
});

test("/status's live queries read by index (EXPLAIN QUERY PLAN)", () => {
  const sqlite = fresh();
  for (const [name, sql] of Object.entries(LIVE)) {
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
    if (name === "analyses" || name === "flags") assert.match(plan, /SEARCH bill_analyses USING (COVERING )?INDEX bill_analyses_current_review/, plan);
    if (name === "recent") assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  }
});

test("a busy database: /status returns what it has, with the note", async () => {
  const sqlite = fresh();
  await recordStatusCounts(d1(sqlite), "2026-11-14T05:00:00Z");
  const r = await statusReport(d1(sqlite, [], (sql) => /sync_log/.test(sql)));
  assert.equal(r.note, BUSY);
  assert.equal(r.counts_as_of, "2026-11-14T05:00:00Z");
  assert.deepEqual(r.recent_log, []);
});

test("D1 overloaded: retried with a longer backoff, then a temporary error for the step", async () => {
  const err = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
  assert.ok(isOverloaded(err));
  assert.ok(isTemporary(err));
  const waits = [];
  let tries = 0;
  await assert.rejects(() => withRetry(async () => { tries++; throw err; }, { sleep: async (ms) => waits.push(ms) }));
  assert.equal(tries, OVERLOAD_RETRY.attempts);
  assert.ok(waits[0] >= 1500 && Math.max(...waits) <= OVERLOAD_RETRY.maxMs * 1.25);
  // An overload that clears is retried through.
  let n = 0;
  assert.equal(await withRetry(async () => (++n < 4 ? Promise.reject(err) : "ok"), { sleep: async () => {} }), "ok");
  // One query costing too much isn't a busy queue: not retried, and the step fails as before.
  const heavy = new Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.");
  assert.ok(!isOverloaded(heavy));
  assert.ok(!isTemporary(heavy));
  let h = 0;
  await assert.rejects(() => withRetry(async () => { h++; throw heavy; }, { sleep: async () => {} }));
  assert.equal(h, 1);
  // Other errors still fail at once.
  let m = 0;
  await assert.rejects(() => withRetry(async () => { m++; throw new Error("UNIQUE constraint failed"); }, { sleep: async () => {} }));
  assert.equal(m, 1);
});
