// node --test test/trade-scans.test.mjs
// Scanned OGE Form 278-T reports (docs/trades.md): the checks on two AI
// readings, the scanned-trades step with fake model answers (agreed rows publish
// labeled as AI), the admin page's confirm / take down / read again, the public
// labels, and the migration guard that keeps the Worker from applying 0025 to
// 0027 a second time. Real schema in SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { checkReadings, blocking, contained, textLayerType } from "../src/trades/scan-check.js";
import { syncScannedTrades } from "../src/trades/scan-sync.js";
import { ensureSchema } from "../src/db.js";
import { scanChange, scanItem, scanList } from "../../../functions/_lib/trade-scan-review.js";
import { memberTrades, tradeRow } from "../../../functions/_lib/trades.js";

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (s) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const x of s) out.push(await x.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const MIG = new URL("../migrations/", import.meta.url);
const migrationFiles = () => readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of migrationFiles()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec(`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)`);
  sqlite
    .prepare(
      `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, party, state, source_url, last_verified, active)
       VALUES ('p1', 'the-president', 'Pat President', 'President', 'President of the United States', 'federal', 'us-executive', 'us-executive', 'Party A', NULL, 'https://example.org/o', '2026-10-01', 1)`
    )
    .run();
  const rep = sqlite.prepare(
    `INSERT INTO trade_reports (id, chamber, official_id, filer_name, filed_on, report_url, paper, parsed, trade_count, source_url) VALUES (?, 'us-executive', 'p1', 'Pat President', ?, ?, 0, 0, 0, ?)`
  );
  rep.run("oge:a", "2026-09-08", "https://example.org/a.pdf", "https://example.org/a.pdf");
  rep.run("oge:b", "2026-08-12", "https://example.org/b.pdf", "https://example.org/b.pdf");
  sqlite.exec(`INSERT INTO trade_scans (report_id, text_rows) VALUES ('oge:a', 2), ('oge:b', 0)`);
  sqlite.exec(`INSERT INTO trade_scan_lines (report_id, n, line) VALUES
    ('oge:a', 1, 'MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00 % Due Oct 1, 2031 lourchaso 717'),
    ('oge:a', 2, 'Abbott labs sale 5/512026')`);
  sqlite.exec(`INSERT INTO sec_tickers (ticker, cik, company, sic, sector) VALUES ('ABT', '1800', 'Abbott Laboratories', '2834', 'Manufacturing')`);
  return sqlite;
}

const ROWS = [
  { n: 1, description: "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00 % Due Oct 1, 2031", type: "Purchase", date: "7/7/2026", amount: "$1,000,001 - $5,000,000", uncertain: false, note: "" },
  { n: 2, description: "Abbott Labs (ABT)", type: "Sale", date: "5/5/2026", amount: "$15,001 - $50,000", uncertain: false, note: "" },
];
const copy = (rows) => ({ rows: rows.map((r) => ({ ...r })) });

test("two agreeing readings that fit the text layer pass", () => {
  const { rows, problems } = checkReadings(copy(ROWS), copy(ROWS), { 1: "MIAMI DADE CNTY FL AVIATION REV RFDG lourchaso 717", 2: "Abbott labs sale 5/512026" });
  assert.equal(blocking(problems), false, JSON.stringify(problems));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { n: 2, description: "Abbott Labs (ABT)", type: "Sale", date: "2026-05-05", amount: "$15,001 - $50,000", amount_min: 15001, amount_max: 50000, owner: null, ticker: "ABT" });
});

test("spacing and punctuation don't count; letters, dates, types and amounts do", () => {
  const b = copy(ROWS);
  b.rows[0].description = "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00% Due Oct 1 2031";
  assert.equal(blocking(checkReadings(copy(ROWS), b).problems), false);
  for (const [field, value] of [["amount", "$1,000,001 - $5,000,001"], ["date", "7/1/2026"], ["type", "Sale"], ["description", "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00 % Due Oct 1, 2032"]]) {
    const c = copy(ROWS);
    c.rows[0][field] = value;
    const { problems } = checkReadings(copy(ROWS), c);
    assert.ok(problems.some((p) => p.kind === "block" && p.text.includes(`differ on the ${field}`)), field);
  }
});

test("a cell marked hard to read, a gap, a half range or a partial date blocks", () => {
  const u = copy(ROWS);
  u.rows[1].uncertain = true;
  u.rows[1].note = "amount blurred";
  assert.ok(checkReadings(copy(ROWS), u).problems.some((p) => p.kind === "block" && /hard to read \(amount blurred\)/.test(p.text)));
  const gap = { rows: [ROWS[0], { ...ROWS[1], n: 3 }] };
  assert.ok(blocking(checkReadings(gap, gap).problems));
  const half = copy(ROWS);
  half.rows[1].amount = "$15,001 -";
  assert.ok(checkReadings(half, copy(half.rows)).problems.some((p) => /whole amount range/.test(p.text)));
  const day = copy(ROWS);
  day.rows[0].date = "7/7";
  assert.ok(checkReadings(day, copy(day.rows)).problems.some((p) => /whole date/.test(p.text)));
  assert.ok(blocking(checkReadings({ rows: [] }, copy(ROWS)).problems));
});

test("the text layer: a row it shows must be read, and its type mustn't contradict", () => {
  assert.ok(checkReadings(copy(ROWS), copy(ROWS), { 3: "Some Company Inc purchase 5/5/2026" }).problems.some((p) => p.kind === "block" && /Row 3 is in the report's text layer/.test(p.text)));
  assert.ok(checkReadings(copy(ROWS), copy(ROWS), { 2: "Abbott labs lourchaso 5/512026" }).problems.some((p) => p.kind === "block" && /looks like a purchase, not a sale/.test(p.text)));
  const none = checkReadings(copy(ROWS), copy(ROWS), {});
  assert.equal(blocking(none.problems), false);
  assert.ok(none.problems.some((p) => p.kind === "look" && /no usable text layer/.test(p.text)));
  assert.equal(textLayerType("Ipurchase 7/16"), "Purchase");
  assert.ok(contained("Danaher Corp", "12 Danahor Coro sale") >= 0.5);
});

test("the step reads each queued report twice; agreed rows publish labeled as AI, the rest stay links", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  const asked = [];
  const call = async (env, { model, message }) => {
    asked.push([model, message[0].source.url]);
    const rows = copy(ROWS);
    if (message[0].source.url.endsWith("b.pdf") && model === "claude-opus-5-5") rows.rows[1].amount = "$50,001 - $100,000";
    return { data: rows, model };
  };
  const r = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call, random: () => 0.05 });
  assert.match(r.message, /1 scanned report\(s\) published.*1 not agreeing/);
  assert.deepEqual(asked.map((x) => x[0]), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  const a = sqlite.prepare("SELECT * FROM trade_scans WHERE report_id = 'oge:a'").get();
  const b = sqlite.prepare("SELECT * FROM trade_scans WHERE report_id = 'oge:b'").get();
  assert.equal(a.status, "agreed");
  assert.equal(a.spot_check, 1, "picked for a spot check (random below SPOT_CHECK_RATE)");
  assert.equal(b.status, "disagree");
  assert.match(b.problems, /differ on the amount/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:a'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:b'").get().n, 0, "readings that disagree publish nothing");
  const rep = sqlite.prepare("SELECT parsed, trade_count, transcribed_by, transcribed_at FROM trade_reports WHERE id = 'oge:a'").get();
  assert.equal(rep.parsed, 1);
  assert.equal(rep.trade_count, 2);
  assert.equal(rep.transcribed_by, null);
  assert.ok(rep.transcribed_at);
  const abt = sqlite.prepare("SELECT * FROM trades WHERE report_id = 'oge:a' AND n = 2").get();
  assert.equal(abt.sector, "Manufacturing");
  assert.equal(abt.days_to_file, null, "no filer's date on a scan: no timeliness line");
  const sum = sqlite.prepare("SELECT * FROM trade_summary WHERE official_id = 'p1' AND year = 2026").get();
  assert.equal(sum.trades, 2);
  assert.equal(sum.total_min, 1000001 + 15001);
  const html = (await memberTrades(db, "p1")).rows.map((t) => tradeRow(t)).join("");
  assert.match(html, /Transcribed by AI from a scanned report, auto-checked/);
  const again = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call });
  assert.equal(again.message, "no scanned reports waiting");
});

test("a person confirms a transcription or takes it down; read again requeues", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  const call = async (env, { model }) => ({ data: copy(ROWS), model });
  await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call, random: () => 0.5 });
  assert.equal(sqlite.prepare("SELECT spot_check FROM trade_scans WHERE report_id = 'oge:a'").get().spot_check, 0);
  const form = (o) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", reviewer: "Rae Reviewer" }), "rae@example.org")).error, /compared every row/);
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", compared: "1" }), "")).error, /Enter your name/);
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", compared: "1", reviewer: "Rae Reviewer" }), "rae@example.org")).done, /Checked by Rae Reviewer/);
  assert.equal(sqlite.prepare("SELECT transcribed_by FROM trade_reports WHERE id = 'oge:a'").get().transcribed_by, "Rae Reviewer");
  const html = (await memberTrades(db, "p1")).rows.map((t) => tradeRow(t)).join("");
  assert.match(html, /Transcribed by AI from a scanned report · Checked by Rae Reviewer/);

  // Take oge:b down: its trades go, the summary follows, the report is a link again.
  assert.match((await scanChange(db, "oge:b", form({ action: "reject", reviewer: "Rae Reviewer" }), "")).error, /Say what's wrong/);
  assert.match((await scanChange(db, "oge:b", form({ action: "reject", reviewer: "Rae Reviewer", reason: "Row 2's amount is wrong on the scan" }), "")).done, /link again/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:b'").get().n, 0);
  assert.deepEqual({ ...sqlite.prepare("SELECT parsed, transcribed_at FROM trade_reports WHERE id = 'oge:b'").get() }, { parsed: 0, transcribed_at: null });
  assert.equal(sqlite.prepare("SELECT trades FROM trade_summary WHERE official_id = 'p1' AND year = 2026").get().trades, 2, "only oge:a's trades count");
  assert.match((await scanChange(db, "oge:b", form({ action: "approve", compared: "1", reviewer: "Rae Reviewer" }), "")).error, /Only a transcription published by AI/);
  assert.match((await scanChange(db, "oge:b", form({ action: "reread" }), "")).done, /Back in the queue/);
  assert.equal(sqlite.prepare("SELECT status FROM trade_scans WHERE report_id = 'oge:b'").get().status, "pending");

  const list = await scanList(db);
  assert.match(list.main, /Confirmed by a person \(1\)/);
  assert.match(list.main, /Waiting to be read \(1\)/);
  const item = await scanItem(db, {}, "oge:a");
  assert.match(item.main, /Open the scanned report/);
  assert.match(item.main, /Confirmed by Rae Reviewer/);
  assert.match(item.main, /Take down/);
});

test("the Worker records 0025 to 0027 instead of applying them again", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const files = migrationFiles();
  for (const f of files) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  // As tools/load_trades.py left it before it recorded what it applied: 0025 and 0026 in place, not recorded.
  sqlite.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const f of files.filter((f) => f < "0025")) sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
  sqlite
    .prepare("INSERT INTO trade_reports (id, chamber, official_id, filer_name, filed_on, report_url, request_url, position, agency, source_url) VALUES ('oge:r', 'us-executive', NULL, 'X', '2026-01-01', NULL, ?, 'Secretary', 'Department', ?)")
    .run("https://example.org/request", "https://example.org/request");
  await ensureSchema(d1(sqlite));
  const row = sqlite.prepare("SELECT request_url, position, agency FROM trade_reports WHERE id = 'oge:r'").get();
  assert.deepEqual({ ...row }, { request_url: "https://example.org/request", position: "Secretary", agency: "Department" });
  const names = sqlite.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name);
  assert.ok(["0025_executive_trades.sql", "0026_trade_scans.sql", "0027_trade_scans_auto.sql"].every((n) => names.includes(n)));
});
