// node --import ./test/sql-stub.mjs --test test/writes.test.mjs
//
// "Write only what changed" (docs/data-sync.md, "What Cloudflare costs"): D1 bills every row
// written, so every load that reads a source again must write nothing when nothing changed.
// Each test saves the same data twice against the real schema (every migration) and counts
// the rows the second pass wrote: always 0. Then one value changes, and only that row is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { upsertOfficial, upsertBill, saveVote, existingVoteIds } from "../src/db.js";
import { syncScope, differs } from "../src/upsert.js";
import { setState } from "../src/util.js";
import { saveAction } from "../src/executive/sync.js";
import { stateCampaignStatements } from "../src/funding/executive.js";
import { saveItems } from "../src/meetings/items.js";
import { summaryStatements } from "../src/trades/summary.js";

const MIG = new URL("../migrations/", import.meta.url);

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec("PRAGMA foreign_keys = OFF");
  const wrap = (sql, binds = []) => {
    const st = sqlite.prepare(sql);
    const run = () => st.run(...binds.map((b) => (b === undefined ? null : b)));
    return {
      __sql: sql,
      bind: (...b) => wrap(sql, b),
      all: async () => ({ results: st.all(...binds), meta: {} }),
      first: async () => st.get(...binds) ?? null,
      run: async () => ({ meta: { changes: run().changes } }),
      _run: run,
    };
  };
  const db = { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._run()) };
  // Rows written so far (inserts, updates and deletes), as SQLite counts them.
  const written = () => sqlite.prepare("SELECT total_changes() AS n").get().n;
  return { db, sqlite, written };
}

/** The rows `fn` writes. */
async function writes(t, fn) {
  const before = t.written();
  await fn();
  return t.written() - before;
}

const OFFICIAL = {
  id: "bioguide:X000001", slug: "ada-example", name: "Ada Example", last_name: "Example", office: "U.S. Representative", level: "federal",
  chamber: "us-house", body: "us-house", district: "CA-5", party: "Example", source_url: "https://example.gov/ada", bioguide_id: "X000001",
  state: "CA", district_code: "5", last_verified: "2026-11-11",
};

test("differs() builds the change test", () => {
  assert.equal(differs("t", ["a", "b"]), "t.a IS NOT excluded.a OR t.b IS NOT excluded.b");
});

test("an official read again unchanged writes nothing; a change writes one row", async () => {
  const t = fresh();
  assert.equal(await writes(t, () => upsertOfficial(t.db, OFFICIAL)), 1);
  assert.equal(await writes(t, () => upsertOfficial(t.db, OFFICIAL)), 0);
  assert.equal(await writes(t, () => upsertOfficial(t.db, { ...OFFICIAL, website: "https://example.gov" })), 1);
  // The next day's check writes once (last verified), then nothing again.
  assert.equal(await writes(t, () => upsertOfficial(t.db, { ...OFFICIAL, website: "https://example.gov", last_verified: "2026-11-12" })), 1);
  assert.equal(await writes(t, () => upsertOfficial(t.db, { ...OFFICIAL, website: "https://example.gov", last_verified: "2026-11-12" })), 0);
});

test("a bill and a vote with its positions, saved again unchanged, write nothing", async () => {
  const t = fresh();
  await upsertOfficial(t.db, OFFICIAL);
  const bill = { id: "us-119-hr-1", level: "federal", chamber: "us-house", bill_number: "H.R. 1", session: "119", title: "An Act", source_url: "https://example.gov/hr1" };
  const vote = { id: "us-house-119-1-7", bill_id: bill.id, level: "federal", chamber: "us-house", vote_date: "2026-11-10", question: "On Passage", vote_type: "final_passage", result: "Passed", source_url: "https://example.gov/v7", totals: { yea: 1, nay: 0, present: 0, not_voting: 0 } };
  const positions = [{ official_id: OFFICIAL.id, position: "Yes", raw_position: "Yea" }];
  assert.ok((await writes(t, async () => { await upsertBill(t.db, bill); await saveVote(t.db, vote, positions); })) >= 3);
  assert.equal(await writes(t, async () => { await upsertBill(t.db, bill); await saveVote(t.db, vote, positions); }), 0);
  assert.equal(await writes(t, () => saveVote(t.db, vote, [{ ...positions[0], position: "No", raw_position: "Nay" }])), 1);
});

test("existingVoteIds reads one session's votes by key range", async () => {
  const t = fresh();
  for (const id of ["us-house-119-1-7", "us-house-119-1-8", "us-house-119-2-1", "us-senate-119-1-7"]) {
    t.sqlite.prepare("INSERT INTO votes (id, level, chamber, vote_date, question, vote_type, result, source_url, yea) VALUES (?, 'federal', 'us-house', '2026-01-01', 'q', 'final_passage', 'Passed', 'https://example.gov', 1)").run(id);
  }
  t.sqlite.prepare("INSERT INTO votes (id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES ('us-house-119-1-9', 'federal', 'us-house', '2026-01-01', 'q', 'final_passage', 'Passed', 'https://example.gov')").run();
  assert.deepEqual([...(await existingVoteIds(t.db, "us-house-119-1-"))].sort(), ["us-house-119-1-7", "us-house-119-1-8"]);
  // The plan uses the primary key, never a scan of every vote.
  const plan = t.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM votes WHERE id >= ? AND id < ? AND yea IS NOT NULL").all("a", "b").map((r) => r.detail).join(" ");
  assert.match(plan, /USING (INDEX|PRIMARY KEY|COVERING INDEX)/i, plan);
});

test("an executive order saved again unchanged writes nothing", async () => {
  const t = fresh();
  const a = { id: "fr:2026-1", kind: "executive_order", number: "14500", title: "Publishing Permit Data", signed_on: "2026-11-01", published_on: "2026-11-05", citation: "91 FR 1", document_url: "https://example.gov/eo.pdf", source_url: "https://example.gov/eo" };
  assert.equal(await writes(t, () => saveAction(t.db, "exec:1", a)), 1);
  assert.equal(await writes(t, () => saveAction(t.db, "exec:1", a)), 0);
  // A missing link keeps the saved one, and writes nothing.
  assert.equal(await writes(t, () => saveAction(t.db, "exec:1", { ...a, document_url: null })), 0);
  assert.equal(await writes(t, () => saveAction(t.db, "exec:1", { ...a, title: "Publishing Permit Data Faster" })), 1);
});

test("syncScope writes only new, changed and gone rows", async () => {
  const t = fresh();
  const scope = { official_id: "o1", cycle: 2026 };
  const cols = ["committee_id", "name", "committee_type", "total", "count", "industry", "source_url"];
  const row = (id, total) => ({ committee_id: id, name: `PAC ${id}`, committee_type: "Q", total, count: 2, industry: "other", source_url: "https://example.gov" });
  const run = async (rows) => {
    const r = await syncScope(t.db, { table: "funding_pacs", scope, key: ["committee_id"], cols, rows });
    await t.db.batch(r.stmts);
    return r;
  };
  let r = await run([row("C1", 100), row("C2", 50)]);
  assert.deepEqual([r.inserted, r.updated, r.deleted, r.same], [2, 0, 0, 0]);
  assert.equal(await writes(t, async () => { r = await run([row("C1", 100), row("C2", 50)]); }), 0);
  assert.equal(r.stmts.length, 0);
  assert.equal(await writes(t, async () => { r = await run([row("C1", 100), row("C2", 75), row("C3", 10)]); }), 2);
  assert.deepEqual([r.inserted, r.updated, r.deleted, r.same], [1, 1, 0, 1]);
  assert.equal(await writes(t, async () => { r = await run([row("C1", 100)]); }), 2);
  assert.deepEqual([r.deleted], [2]);
  assert.deepEqual(t.sqlite.prepare("SELECT committee_id, total FROM funding_pacs ORDER BY 1").all().map((x) => ({ ...x })), [{ committee_id: "C1", total: 100 }]);
  // A key read as text that the table stores as a number still matches (no delete-and-insert).
  const s2 = await syncScope(t.db, { table: "funding_pacs", scope: { official_id: "o1", cycle: "2026" }, key: ["committee_id"], cols, rows: [row("C1", 100)] });
  assert.equal(s2.stmts.length, 0);
});

test("California campaign rows for an official, loaded again unchanged, write nothing", async () => {
  const t = fresh();
  const entry = {
    name: "Ada Example",
    committees: [{ filer_id: 123, name: "Ada for Assembly", source_url: "https://example.gov/c/123", reports: [{ from: "2026-01-01", thru: "2026-06-30", contributions: 1000, expenditures: 500, cash_end: 500, source_url: "https://example.gov/r/1" }] }],
    cycles: { 2026: { raised: 1000, spent: 500, statements: 1, industries: [{ industry: "Health", total: 400 }], employers: [], organizations: [{ name: "Example Org", kind: "committee", industry: "Health", total: 400, count: 1 }], ie: [] } },
  };
  const apply = async (e) => t.db.batch((await stateCampaignStatements(t.db, "os:ada", e, null)).stmts);
  assert.ok((await writes(t, () => apply(entry))) >= 5);
  // The second load writes only its check stamp (disclosure_checks).
  assert.equal(await writes(t, () => apply(entry)), 1);
  const changed = JSON.parse(JSON.stringify(entry));
  changed.cycles[2026].industries[0].total = 450;
  assert.equal(await writes(t, () => apply(changed)), 2);
});

test("a meeting's agenda items read again unchanged write only the meeting's check time", async () => {
  const t = fresh();
  t.sqlite.prepare("INSERT INTO meetings (id, level, source, body, meeting_type, starts_at, status, source_url) VALUES ('m1', 'county', 'tylermm', 'Board', 'Regular', '2026-11-17T09:00', 'scheduled', 'https://example.gov/m1')").run();
  const parsed = { items: [{ item_key: "1", number: "1", title: "Approve the minutes", section: "Consent", section_kind: "consent", item_url: null, staff_report_url: null, attachments: [], sort: 1 }], agenda_file_id: null, agenda_url: null, packet_url: null };
  assert.equal(await writes(t, () => saveItems(t.db, "m1", "f1", parsed)), 2);
  assert.equal(await writes(t, () => saveItems(t.db, "m1", "f1", parsed)), 1);
});

test("setState with the same value writes nothing", async () => {
  const t = fresh();
  assert.equal(await writes(t, () => setState(t.db, "k", "1")), 1);
  assert.equal(await writes(t, () => setState(t.db, "k", "1")), 0);
  assert.equal(await writes(t, () => setState(t.db, "k", "2")), 1);
});

test("the trade summary rebuilt unchanged writes nothing, and drops a year no longer present", async () => {
  const t = fresh();
  t.sqlite.exec(`INSERT INTO trades (report_id, n, official_id, chamber, transaction_date, filed_on, asset_name, type, amount, amount_min, amount_max)
    VALUES ('r1', 1, 'o1', 'us-house', '2025-03-01', '2025-03-20', 'Example Co', 'P', '$1,001 - $15,000', 1001, 15000),
           ('r1', 2, 'o1', 'us-house', '2026-03-01', '2026-03-20', 'Example Co', 'S', '$1,001 - $15,000', 1001, 15000)`);
  const rebuild = () => t.db.batch(summaryStatements(["o1"]).map((s) => t.db.prepare(s.sql).bind(...s.binds)));
  assert.equal(await writes(t, rebuild), 2);
  assert.equal(await writes(t, rebuild), 0);
  t.sqlite.exec("DELETE FROM trades WHERE n = 1");
  assert.equal(await writes(t, rebuild), 1);
  assert.deepEqual(t.sqlite.prepare("SELECT year FROM trade_summary").all().map((r) => r.year), [2026]);
});
