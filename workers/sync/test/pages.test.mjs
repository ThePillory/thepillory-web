// node workers/sync/test/pages.test.mjs
// Page summaries (src/summaries.js), the queries the pages read them with, and
// the helpers that let a page fail one section at a time. Runs the real
// migrations in an in-memory SQLite database (node:sqlite) behind a small
// D1-shaped adapter. Every name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { buildSummaries } from "../src/summaries.js";
import { billList, withVoteCounts, voteCounts, BILLS_PER_PAGE } from "../../../functions/_lib/data.js";
import { happeningNow } from "../../../functions/_lib/hub.js";
import { loadSection, FAILED, anyFailed, sectionError, guard, page, edgeCached } from "../../../functions/_lib/render.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** A D1-shaped wrapper around node:sqlite. */
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  return { sqlite, db: d1(sqlite) };
}

const SRC = "https://example.org/source";

function seed(sqlite, { bills = 3, officials = 4 } = {}) {
  const off = sqlite.prepare("INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified, active, state) VALUES (?, ?, ?, 'Member', 'federal', 'us-house', 'us-house', ?, '2026-01-01', 1, 'ZZ')");
  for (let i = 0; i < officials; i++) off.run(`o${i}`, `member-${i}`, `Member ${i}`, SRC);
  const bill = sqlite.prepare("INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const vote = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay, present, not_voting) VALUES (?, ?, ?, 'us-house', ?, 'On Passage', ?, ?, ?, ?, ?, 0, 0)");
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, ?, ?, ?)");
  for (let b = 0; b < bills; b++) {
    const id = `us-119-hr-${b + 1}`;
    bill.run(id, "federal", "us-house", `H.R. ${b + 1}`, "119", `Example Act ${b + 1}`, SRC);
    // A procedural vote, then (for most bills) a final-passage vote a day later.
    const day = String(1 + (b % 27)).padStart(2, "0");
    const votes = [[`v${b}-p`, `2026-03-${day}`, "procedural", "Agreed to"]];
    if (b % 4 !== 3) votes.push([`v${b}-f`, `2026-04-${day}`, "final_passage", "Passed"]);
    for (const [vid, date, type, result] of votes) {
      vote.run(vid, id, "federal", date, type, result, SRC, officials - 1, 1);
      for (let i = 0; i < officials; i++) pos.run(vid, `o${i}`, i ? "Yes" : "No", i ? "Yea" : "Nay");
    }
  }
}

test("bill list: built from votes, with the latest final vote, outcome and routine flag", async () => {
  const { sqlite, db } = freshDb();
  seed(sqlite, { bills: 4 });
  sqlite.prepare("INSERT INTO bill_outcomes (bill_id, outcome, action_date, action_text, source_url) VALUES ('us-119-hr-1', 'signed', '2026-05-01', 'Became Public Law No: 119-1.', ?)").run(SRC);
  sqlite.prepare("INSERT INTO bill_relevance (bill_id, verdict, category, reason, local, model, prompt_version) VALUES ('us-119-hr-2', 'skip', 'naming', 'Names a post office.', 'none', 'm', 'p')").run();
  const r = await buildSummaries(db);
  assert.equal(r.status, "ok");
  assert.match(r.message, /bill list: 4 bills; vote counts: 4 officials/);
  const rows = sqlite.prepare("SELECT * FROM bill_list ORDER BY bill_id").all();
  const hr1 = rows.find((x) => x.bill_id === "us-119-hr-1");
  assert.equal(hr1.vote_count, 2);
  assert.equal(hr1.final_count, 1);
  assert.equal(hr1.last_final, "2026-04-01");
  assert.equal(hr1.final_vote_id, "v0-f");
  assert.equal(hr1.final_result, "Passed");
  assert.equal(hr1.yea, 3);
  assert.equal(hr1.outcome, "signed");
  assert.equal(rows.find((x) => x.bill_id === "us-119-hr-2").routine, 1);
  // H.R. 4 has only a procedural vote: listed, with no final vote.
  const hr4 = rows.find((x) => x.bill_id === "us-119-hr-4");
  assert.equal(hr4.last_final, null);
  assert.equal(hr4.final_count, 0);
  // Counts per official.
  assert.deepEqual({ ...(await voteCounts(db, "o0")) }, { total: 7, final: 3 });
  // Nothing changed: skipped. A change: rebuilt.
  assert.equal((await buildSummaries(db)).status, "skipped");
  sqlite.prepare("UPDATE votes SET result = 'Failed', updated_at = '2099-01-01' WHERE id = 'v0-f'").run();
  assert.equal((await buildSummaries(db)).status, "ok");
  assert.equal(sqlite.prepare("SELECT final_result FROM bill_list WHERE bill_id = 'us-119-hr-1'").get().final_result, "Failed");
});

test("bill list: pages of 20, final-passage only by default", async () => {
  const { sqlite, db } = freshDb();
  seed(sqlite, { bills: 50, officials: 2 });
  await buildSummaries(db);
  const first = await billList(db, { level: "federal" });
  assert.equal(first.rows.length, BILLS_PER_PAGE);
  assert.equal(first.more, true);
  assert.ok(first.rows.every((b) => b.last_final));
  // Newest first.
  assert.ok(first.rows[0].last_final >= first.rows[19].last_final);
  const rest = await billList(db, { level: "federal", offset: 20 });
  const last = await billList(db, { level: "federal", offset: 40 });
  const finals = sqlite.prepare("SELECT COUNT(*) AS n FROM bill_list WHERE last_final IS NOT NULL").get().n;
  assert.equal(first.rows.length + rest.rows.length + last.rows.length, finals);
  assert.equal(last.more, false);
  const ids = [...first.rows, ...rest.rows, ...last.rows].map((b) => b.bill_id);
  assert.equal(new Set(ids).size, ids.length, "no bill twice across pages");
  // All recorded votes: every bill.
  const all = await billList(db, { level: "federal", all: true, limit: 100 });
  assert.equal(all.rows.length, 50);
  assert.deepEqual(await billList(db, { level: "state" }), { rows: [], more: false });
});

test("pages before the first build: no heavy fallback, an honest state", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  sqlite.exec(readFileSync(new URL("0001_init.sql", MIGRATIONS), "utf8"));
  assert.equal(await billList(db, { level: "federal" }), null);
  // Vote counts: null rather than counted from every position on a visit.
  const off = await withVoteCounts(db, (c) => `SELECT o.*${c.select} FROM officials o ${c.join}`);
  assert.deepEqual(off, []);
});

test("Happening now reads the bill list and leaves out routine bills", async () => {
  const { sqlite, db } = freshDb();
  seed(sqlite, { bills: 6 });
  sqlite.prepare("INSERT INTO bill_relevance (bill_id, verdict, category, reason, local, model, prompt_version) VALUES ('us-119-hr-6', 'skip', 'naming', 'x', 'none', 'm', 'p')").run();
  await buildSummaries(db);
  const rows = await happeningNow(db, "federal", { limit: 4, officialIds: ["o1"] });
  assert.deepEqual(rows.map((r) => r.bill_id), ["us-119-hr-5", "us-119-hr-3", "us-119-hr-2", "us-119-hr-1"]);
  assert.ok(rows.every((r) => r.vote_type === "final_passage" && r.positions.length === 1));
});

test("one section failing doesn't fail the page", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(await loadSection("ok", async () => 5), 5);
    assert.equal(await loadSection("broken", async () => { throw new Error("D1_ERROR: exceeded limits"); }), FAILED);
    assert.equal(await loadSection("missing", async () => { throw new Error("no such table: bill_list"); }, []).then((v) => v.length), 0);
    assert.equal(await loadSection("missing, no fallback", async () => { throw new Error("no such table: x"); }), FAILED);
    assert.equal(anyFailed(1, FAILED), true);
    assert.equal(anyFailed(1, null), false);
    assert.match(sectionError("Votes"), /Couldn't load this section/);
    // A page with a failed section is never cached.
    assert.equal(page("T", "<p>x</p>", { partial: true }).headers.get("Cache-Control"), "no-store");
    assert.equal(page("T", "<p>x</p>").headers.get("Cache-Control"), "public, max-age=300");
    // A whole page throwing shows the site's own error page, not Cloudflare's.
    const res = await guard(async () => { throw new Error("boom"); }, { tab: "laws" })({ request: new Request("https://example.org/laws/") });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.match(await res.text(), /Couldn't load this page/);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((m) => /broken/.test(m)), "failures are logged");
});

test("edge cache: shared pages are stored; personal and failed ones aren't", async () => {
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone() || undefined,
      put: async (req, res) => void store.set(req.url, res),
    },
  };
  const waits = [];
  const ctx = (url) => ({ request: new Request(url), waitUntil: (p) => waits.push(p) });
  let renders = 0;
  const render = (opts) => async () => (renders++, page("T", "<p>x</p>", opts));
  const first = await edgeCached(ctx("https://example.org/laws/"), 300, render());
  await Promise.all(waits);
  assert.equal(first.headers.get("Cache-Control"), "public, max-age=300");
  await edgeCached(ctx("https://example.org/laws/"), 300, render());
  assert.equal(renders, 1, "the second visit is served from the edge");
  await edgeCached(ctx("https://example.org/laws/?votes=all"), 300, render());
  assert.equal(renders, 2, "the query string is part of the key");
  await edgeCached(ctx("https://example.org/a/"), 300, render({ partial: true }));
  await edgeCached(ctx("https://example.org/b/"), 300, render({ personal: true }));
  await Promise.all(waits);
  assert.equal(store.has("https://example.org/a/") || store.has("https://example.org/b/"), false);
  delete globalThis.caches;
});

test("scale: the Laws query no longer reads every vote position", async () => {
  // Roughly a Congress's worth: 1,200 bills, 3,000 votes, 435 members.
  const { sqlite, db } = freshDb();
  const n = { bills: 1200, officials: 435 };
  sqlite.exec("BEGIN");
  seed(sqlite, n);
  sqlite.exec("COMMIT");
  const positions = sqlite.prepare("SELECT COUNT(*) AS n FROM vote_positions").get().n;
  // The old Laws query (two of these per visit).
  const old = `SELECT b.*, MAX(v.vote_date) AS last_vote, COUNT(DISTINCT v.id) AS vote_count
    FROM bills b JOIN votes v ON v.bill_id = b.id JOIN vote_positions p ON p.vote_id = v.id
    WHERE b.level = 'federal' AND v.vote_type = 'final_passage' GROUP BY b.id ORDER BY last_vote DESC LIMIT 40`;
  let t = performance.now();
  sqlite.prepare(old).all();
  const oldMs = performance.now() - t;
  const build = await buildSummaries(db);
  t = performance.now();
  const list = await billList(db, { level: "federal" });
  const newMs = performance.now() - t;
  console.log(`  ${positions} positions: old query ${oldMs.toFixed(0)} ms per level; bill_list page ${newMs.toFixed(1)} ms; build during sync: ${build.message}`);
  assert.equal(list.rows.length, 20);
  assert.ok(newMs < oldMs / 10, "the page query is far cheaper than the old one");
  const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM bill_list WHERE level = ? AND last_final IS NOT NULL ORDER BY last_final DESC, bill_id DESC LIMIT 21 OFFSET 0").all("federal");
  assert.ok(plan.some((p) => /bill_list_final/.test(p.detail)), `uses the index: ${JSON.stringify(plan)}`);
});
