// node --test test/trade-scans.test.mjs
// Scanned OGE Form 278-T reports (docs/trades.md): the checks on two AI
// readings, the scanned-trades step with fake model answers (rows the text layer
// backs and both readings agree on publish, labeled as AI, with no person's
// check first; a share is spot-checked), the admin page's confirm / take down /
// read again, the public
// labels, and the migration guard that keeps the Worker from applying 0025 to
// 0027 a second time. Real schema in SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { checkReadings, blocking, contained, textLayerType, rowsLine } from "../src/trades/scan-check.js";
import { syncScannedTrades, mergeChunks, accountError, textBacks, rowRanges, pdfSource, toBase64 } from "../src/trades/scan-sync.js";
import { ensureSchema } from "../src/db.js";
import { scanChange, scanItem, scanList } from "../../../functions/_lib/trade-scan-review.js";
import { memberTrades, memberReports, tradeRow, tradesSection } from "../../../functions/_lib/trades.js";

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

// A text layer that backs both rows (the seeded one is garbled, as on a real scan).
const CLEAN = {
  1: "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00 % Due Oct 1, 2031  Purchase  7/7/2026  $1,000,001 - $5,000,000",
  2: "Abbott Labs (ABT)  Sale  5/5/2026  $15,001 - $50,000",
};
function cleanLines(sqlite, ids = ["oge:a", "oge:b"], ns = [1, 2]) {
  for (const id of ids) {
    sqlite.prepare("DELETE FROM trade_scan_lines WHERE report_id = ?").run(id);
    for (const n of ns) sqlite.prepare("INSERT INTO trade_scan_lines (report_id, n, line) VALUES (?, ?, ?)").run(id, n, CLEAN[n]);
  }
}
const form = (o) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

// A fake model: answers each chunk ("rows 81 to 160") with the rows in that range.
const ranged = (rowsFor) => async (env, { model, message }) => {
  const [, first, last] = message[1].text.match(/rows (\d+) to (\d+)/).map(Number);
  const rows = rowsFor(model, message[0].source.url).filter((r) => r.n >= first && r.n <= last);
  return { data: { rows }, model };
};

test("two agreeing readings that fit the text layer: every row publishes", () => {
  const { rows, unread, total, problems } = checkReadings(copy(ROWS), copy(ROWS), { 1: "MIAMI DADE CNTY FL AVIATION REV RFDG lourchaso 717", 2: "Abbott labs sale 5/512026" });
  assert.equal(blocking(problems), false, JSON.stringify(problems));
  assert.equal(rows.length, 2);
  assert.deepEqual(unread, []);
  assert.equal(total, 2);
  assert.deepEqual(rows[1], { n: 2, description: "Abbott Labs (ABT)", type: "Sale", date: "2026-05-05", amount: "$15,001 - $50,000", amount_min: 15001, amount_max: 50000, owner: null, ticker: "ABT" });
  assert.equal(rowsLine(84, 90), "84 of 90 rows transcribed.");
});

test("the form's endnote marker isn't kept in the description", () => {
  const a = copy(ROWS);
  a.rows[1].description = "Abbott Labs (ABT) See Endnote";
  const { rows } = checkReadings(a, copy(a.rows));
  assert.equal(rows[1].description, "Abbott Labs (ABT)");
});

test("one row the readings differ on stays unread; the other rows still publish", () => {
  const b = copy(ROWS);
  b.rows[0].description = "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00% Due Oct 1 2031";
  assert.equal(checkReadings(copy(ROWS), b).rows.length, 2, "spacing and punctuation don't count");
  for (const [field, value] of [["amount", "$1,000,001 - $5,000,001"], ["date", "7/1/2026"], ["type", "Sale"], ["description", "MIAMI DADE CNTY FL AVIATION REV RFDG SER A B/E PTC 5.00 % Due Oct 1, 2032"]]) {
    const c = copy(ROWS);
    c.rows[0][field] = value;
    const { rows, unread, problems } = checkReadings(copy(ROWS), c);
    assert.deepEqual(rows.map((r) => r.n), [2], field);
    assert.equal(unread[0].n, 1);
    assert.match(unread[0].reason, new RegExp(`differ on the ${field}`));
    assert.equal(blocking(problems), false, "a row, not the report");
  }
});

test("a cell marked hard to read, a missing row, a half range or a partial date: that row only", () => {
  const u = copy(ROWS);
  u.rows[1].uncertain = true;
  u.rows[1].note = "amount blurred";
  assert.match(checkReadings(copy(ROWS), u).unread[0].reason, /hard to read \(amount blurred\)/);
  const gap = { rows: [ROWS[0], { ...ROWS[1], n: 3 }] };
  const g = checkReadings(gap, copy(gap.rows));
  assert.equal(g.total, 3);
  assert.deepEqual(g.rows.map((r) => r.n), [1, 3]);
  assert.deepEqual(g.unread, [{ n: 2, reason: "Not found in either reading." }]);
  const only = checkReadings(copy(ROWS), { rows: [ROWS[0]] });
  assert.match(only.unread[0].reason, /Only in the first reading/);
  const half = copy(ROWS);
  half.rows[1].amount = "$15,001 -";
  assert.match(checkReadings(half, copy(half.rows)).unread[0].reason, /whole amount range/);
  const day = copy(ROWS);
  day.rows[0].date = "7/7";
  assert.match(checkReadings(day, copy(day.rows)).unread[0].reason, /whole date/);
  assert.ok(blocking(checkReadings({ rows: [] }, copy(ROWS)).problems), "a reading that found nothing holds the report");
});

test("the text layer: a contradicting type unreads the row; a row past the end is a note; a shift holds the report", () => {
  const t = checkReadings(copy(ROWS), copy(ROWS), { 2: "Abbott labs lourchaso 5/512026" });
  assert.deepEqual(t.rows.map((r) => r.n), [1]);
  assert.match(t.unread[0].reason, /looks like a purchase, not a sale/);
  const past = checkReadings(copy(ROWS), copy(ROWS), { 3: "Some Company Inc purchase 5/5/2026 $1,001 - $15,000" });
  assert.equal(past.rows.length, 2);
  assert.ok(past.problems.some((p) => p.kind === "look" && /past the last row/.test(p.text)));
  const none = checkReadings(copy(ROWS), copy(ROWS), {});
  assert.equal(blocking(none.problems), false);
  assert.ok(none.problems.some((p) => p.kind === "look" && /no usable text layer/.test(p.text)));
  // Ten rows whose descriptions each match the next line: both readings shifted by one.
  const names = ["Apple Inc", "Boeing Company", "Chevron Corp", "Danaher Corp", "Exxon Mobil", "Ford Motor", "General Mills", "Honeywell Intl", "Intel Corp", "Johnson Controls", "Kellogg Company"];
  const shifted = { rows: names.slice(0, 10).map((d, i) => ({ ...ROWS[1], n: i + 1, description: d })) };
  const lines = Object.fromEntries(names.slice(0, 10).map((d, i) => [i + 2, `${d} sale`]));
  assert.ok(blocking(checkReadings(shifted, copy(shifted.rows), lines).problems));
  const aligned = Object.fromEntries(names.slice(0, 10).map((d, i) => [i + 1, `${d} sale`]));
  assert.equal(blocking(checkReadings(shifted, copy(shifted.rows), aligned).problems), false);
  assert.equal(textLayerType("Ipurchase 7/16"), "Purchase");
  assert.ok(contained("Danaher Corp", "12 Danahor Coro sale") >= 0.5);
});

test("chunks merge in order and end where a chunk ends short", () => {
  const c = (first_n, last_n, ns) => ({ first_n, last_n, reading: { rows: ns.map((n) => ({ n })) } });
  assert.deepEqual(mergeChunks([]), { rows: [], done: false, next: 1 });
  const m = mergeChunks([c(11, 20, [11, 12]), c(1, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99])]);
  assert.equal(m.done, true);
  assert.deepEqual(m.rows.map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "a row outside its chunk's range is dropped");
  assert.equal(mergeChunks([c(1, 10, [1, 10])]).next, 11);
  assert.equal(accountError(new Error('400 {"message":"Your credit balance is too low to access the Anthropic API."}')), true);
  assert.equal(accountError(new Error("answer cut off at the output limit")), false);
});

test("rows the text layer backs and both readings agree on publish at once, labeled as AI; a row they differ on stays linked", async () => {
  const sqlite = seeded();
  cleanLines(sqlite);
  const db = d1(sqlite);
  const asked = [];
  const call = async (env, args) => {
    asked.push([args.model, args.message[0].source.url, args.message[1].text]);
    assert.deepEqual(args.message[0].cache_control, { type: "ephemeral" }, "the document is cached across chunks");
    return ranged((model, url) => {
      const rows = copy(ROWS).rows;
      if (url.endsWith("b.pdf") && model === "claude-opus-5-5") rows[1].amount = "$50,001 - $100,000";
      return rows;
    })(env, args);
  };
  const r = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call, random: () => 0.5 });
  assert.match(r.message, /2 scanned report\(s\) published \(3 of 4 rows transcribed\), 0 didn't agree/);
  assert.deepEqual(asked.map((x) => x[0]), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.match(asked[0][2], /rows 1 to 80/);
  assert.match(asked[1][2], /rows 1 to 2\b/, "the second model reads the rows the text layer backs");
  const a = sqlite.prepare("SELECT * FROM trade_scans WHERE report_id = 'oge:a'").get();
  const b = sqlite.prepare("SELECT * FROM trade_scans WHERE report_id = 'oge:b'").get();
  assert.equal(a.status, "agreed");
  assert.equal(a.spot_check, 0);
  assert.equal(b.rows_total, 2);
  assert.match(b.unread, /differ on the amount/);
  // Public at once, with no person's check: the rows that passed.
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:a'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:b'").get().n, 1, "only the row both readings agree on");
  const rep = sqlite.prepare("SELECT parsed, trade_count, transcribed_by, transcribed_at FROM trade_reports WHERE id = 'oge:a'").get();
  assert.equal(rep.parsed, 1);
  assert.equal(rep.trade_count, 2);
  assert.equal(rep.transcribed_by, null);
  assert.ok(rep.transcribed_at);
  assert.deepEqual({ ...sqlite.prepare("SELECT rows_total, unread_rows FROM trade_reports WHERE id = 'oge:b'").get() }, { rows_total: 2, unread_rows: "[2]" });
  const abt = sqlite.prepare("SELECT * FROM trades WHERE report_id = 'oge:a' AND n = 2").get();
  assert.equal(abt.sector, "Manufacturing");
  assert.equal(abt.days_to_file, null, "no filer's date on a scan: no timeliness line");
  assert.equal(sqlite.prepare("SELECT trades FROM trade_summary WHERE official_id = 'p1' AND year = 2026").get().trades, 3);
  let html = (await memberTrades(db, "p1")).rows.map((t) => tradeRow(t)).join("");
  assert.match(html, /Read by AI from the scanned report, auto-checked\. See the original/);
  assert.match(html, /href="https:\/\/example\.org\/a\.pdf"/, "each row opens the original report");
  const reports = await memberReports(db, "p1");
  assert.deepEqual(reports.map((x) => x.id), ["oge:b"], "the partly read report is linked; the fully read one isn't");
  const section = tradesSection({ chamber: "us-executive", name: "Pat President", slug: "the-president", office: "President" }, { summary: [], page: { rows: [], more: false }, reports });
  assert.match(section, /1 of 2 rows transcribed: see the report/);
  assert.match(section, /Row 2 couldn&#x27;t be read with confidence · Filed Aug 12, 2026/);
  assert.match(section, /Read by AI from the scanned report, auto-checked/);
  // A person can still confirm one: "Checked by".
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", compared: "1", reviewer: "Rae Reviewer" }), "")).done, /now show "Checked by Rae Reviewer"/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:a'").get().n, 2, "unchanged");
  html = (await memberTrades(db, "p1")).rows.map((t) => tradeRow(t)).join("");
  assert.match(html, /Read by AI from the scanned report · Checked by Rae Reviewer/);
  const again = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call });
  assert.equal(again.message, "no scanned reports waiting");
});

test("a row the text layer doesn't back can't publish, so it isn't read a second time", async () => {
  // Row 1 isn't in the text layer: only row 2 is read again, and only row 2 publishes.
  const sqlite = seeded();
  cleanLines(sqlite, ["oge:a"], [2]);
  sqlite.exec(`DELETE FROM trade_scans WHERE report_id = 'oge:b'`);
  const asked = [];
  const call = async (env, args) => (asked.push(`${args.model} ${args.message[1].text.match(/rows \d+ to \d+/)[0]}`), ranged(() => copy(ROWS).rows)(env, args));
  await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, d1(sqlite), null, { call });
  assert.deepEqual(asked, ["claude-sonnet-5-5 rows 1 to 80", "claude-opus-5-5 rows 2 to 2"]);
  const a = sqlite.prepare("SELECT status, models, problems, unread FROM trade_scans WHERE report_id = 'oge:a'").get();
  assert.equal(a.status, "agreed");
  assert.equal(a.models, "claude-sonnet-5-5, claude-opus-5-5");
  assert.match(a.problems, /1 of 2 rows .*read again by claude-opus-5-5; the other 1 can't be published/);
  assert.match(a.unread, /"n":1,"reason":"The report's own text doesn't confirm it\."/);
  assert.deepEqual(sqlite.prepare("SELECT n FROM trades WHERE report_id = 'oge:a'").all().map((x) => x.n), [2]);

  // A garbled text layer that backs nothing: no second reading, nothing published, the report stays a link.
  const sqlite2 = seeded();
  sqlite2.exec(`DELETE FROM trade_scans WHERE report_id = 'oge:b'`);
  const asked2 = [];
  const call2 = async (env, args) => (asked2.push(args.model), ranged(() => copy(ROWS).rows)(env, args));
  const r = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, d1(sqlite2), null, { call: call2 });
  assert.deepEqual(asked2, ["claude-sonnet-5-5"]);
  assert.match(r.message, /0 scanned report\(s\) published .*1 didn't agree/);
  const a2 = sqlite2.prepare("SELECT status, problems FROM trade_scans WHERE report_id = 'oge:a'").get();
  assert.equal(a2.status, "disagree");
  assert.match(a2.problems, /The report's own text doesn't confirm any of the 2 rows/);
  assert.equal(sqlite2.prepare("SELECT COUNT(*) AS n FROM trades").get().n, 0);
});

test("a share of published reports is picked for a spot check; nothing waits on it", async () => {
  const sqlite = seeded();
  cleanLines(sqlite);
  const db = d1(sqlite);
  let i = 0;
  await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call: ranged(() => copy(ROWS).rows), random: () => (i++ === 0 ? 0.05 : 0.5) });
  assert.deepEqual(sqlite.prepare("SELECT report_id, spot_check FROM trade_scans ORDER BY report_id").all().map((x) => `${x.report_id} ${x.spot_check}`), ["oge:a 1", "oge:b 0"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades").get().n, 4, "both public; the spot check waits on nothing");
  const list = await scanList(db);
  assert.match(list.main, /Spot checks \(1\)/);
  assert.match(list.main, /Published by AI \(1\)/);
});

test("a long report is read in chunks that resume in the next round; the President's reports go first", async () => {
  const sqlite = seeded();
  sqlite
    .prepare(
      `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, party, state, source_url, last_verified, active)
       VALUES ('c1', 'cab', 'Casey Cabinet', 'Cabinet', 'Secretary of Commerce', 'federal', 'us-executive', 'us-executive', 'Party A', NULL, 'https://example.org/o', '2026-10-01', 1)`
    )
    .run();
  sqlite.exec(`INSERT INTO trade_reports (id, chamber, official_id, filer_name, filed_on, report_url, paper, parsed, trade_count, source_url) VALUES ('oge:c', 'us-executive', 'c1', 'Casey Cabinet', '2026-10-01', 'https://example.org/c.pdf', 0, 0, 0, 'https://example.org/c.pdf')`);
  sqlite.exec(`INSERT INTO trade_scans (report_id, text_rows) VALUES ('oge:c', 0)`);
  const db = d1(sqlite);
  const many = Array.from({ length: 25 }, (_, i) => ({ ...ROWS[1], n: i + 1, description: `Company ${String.fromCharCode(65 + i)} Inc` }));
  // The text layer backs rows 2 to 25; row 1's line is garbled.
  sqlite.exec(`DELETE FROM trade_scan_lines WHERE report_id = 'oge:a' AND n > 1`);
  for (const t of many.slice(1)) sqlite.prepare("INSERT INTO trade_scan_lines (report_id, n, line) VALUES ('oge:a', ?, ?)").run(t.n, `${t.description}  Sale  5/5/2026  $15,001 - $50,000`);
  const asked = [];
  const call = async (env, args) => {
    asked.push(`${args.message[0].source.url.slice(-5)} ${args.model} ${args.message[1].text.match(/rows \d+ to \d+/)[0]}`);
    return ranged(() => copy(many).rows)(env, args);
  };
  let left = 3;
  const budget = { timeLeft: () => (left-- > 0 ? 10 * 60 * 1000 : 1000) };
  const env = { SCANNED_TRADES_DAILY: "1", SCAN_CHUNK_ROWS: "10" };
  const stopped = await syncScannedTrades(env, db, budget, { call });
  assert.equal(stopped.status, "partial", "out of time isn't a failure: the step isn't held until tomorrow");
  assert.match(stopped.message, /run time limit reached before the second reading of rows 2-11 of oge:a/);
  assert.deepEqual(asked, ["a.pdf claude-sonnet-5-5 rows 1 to 10", "a.pdf claude-sonnet-5-5 rows 11 to 20", "a.pdf claude-sonnet-5-5 rows 21 to 30"], "the President's newest report first");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trade_scan_chunks WHERE report_id = 'oge:a'").get().n, 3);
  asked.length = 0;
  const r = await syncScannedTrades(env, db, null, { call, random: () => 0.5 });
  assert.deepEqual(asked, ["a.pdf claude-opus-5-5 rows 2 to 11", "a.pdf claude-opus-5-5 rows 12 to 21", "a.pdf claude-opus-5-5 rows 22 to 25"], "resumes: the first model's chunks aren't read again, and the second reads only the rows the text layer backs");
  // Row 1's text-layer line is garbled: it can't publish and stays linked.
  assert.match(r.message, /1 scanned report\(s\) published \(24 of 25 rows transcribed\)/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:a'").get().n, 24);
  assert.equal(JSON.parse(sqlite.prepare("SELECT reading FROM trade_scans WHERE report_id = 'oge:a'").get().reading).length, 24);
  assert.equal(sqlite.prepare("SELECT status FROM trade_scans WHERE report_id = 'oge:c'").get().status, "pending", "the daily limit: one report");
});

test("the text layer backs a row only when it shows the same date, amount and description", () => {
  const row = { n: 1, description: "Abbott Labs (ABT)", type: "Sale", date: "5/5/2026", amount: "$15,001 - $50,000", uncertain: false };
  assert.equal(textBacks(row, "1  Abbott Labs (ABT)   Sale   5/5/2026   $15,001 - $50,000"), true);
  assert.equal(textBacks(row, "1  Abbott Labs (ABT)   Sale   05/05/26   $15,001-$50,000"), true, "a two-digit year, padding and spacing aside");
  assert.equal(textBacks(row, "1  Abbott Labs (ABT)   Sale   5/6/2026   $15,001 - $50,000"), false, "another date");
  assert.equal(textBacks(row, "1  Abbott Labs (ABT)   Sale   5/5/2026   $1,001 - $15,000"), false, "another range");
  assert.equal(textBacks(row, "1  Abbott Labs (ABT)   Purchase   5/5/2026   $15,001 - $50,000"), false, "another type");
  assert.equal(textBacks(row, "1  Medtronic PLC   Sale   5/5/2026   $15,001 - $50,000"), false, "another asset");
  assert.equal(textBacks(row, "Abbott labs sale 5/512026"), false, "garbled");
  assert.equal(textBacks({ ...row, uncertain: true }, "1  Abbott Labs (ABT)   Sale   5/5/2026   $15,001 - $50,000"), false, "marked hard to read");
  assert.equal(textBacks({ ...row, amount: "Over $50,000,000" }, "Abbott Labs (ABT) Sale 5/5/2026 Over $50,000,000"), true);
  assert.deepEqual(rowRanges([7, 1, 2, 3, 5, 30, 31], 80), [[1, 7], [30, 31]]);
  assert.deepEqual(rowRanges([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("errors are recorded, don't count against the limit, and an account error stops the step", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  const credit = async () => {
    throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
  };
  const r = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call: credit });
  assert.equal(r.status, "error");
  assert.match(r.message, /credit balance/);
  assert.equal(sqlite.prepare("SELECT value FROM sync_state WHERE key LIKE 'scanned_trades_%'").get(), undefined, "nothing counted");
  assert.equal(sqlite.prepare("SELECT tries FROM trade_scans WHERE report_id = 'oge:a'").get().tries, 0);
  const flaky = async () => {
    throw new Error("answer cut off at the output limit");
  };
  for (let i = 1; i <= 3; i++) {
    const out = await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call: flaky });
    assert.match(out.message, /failed: oge:a: answer cut off/);
  }
  const a = sqlite.prepare("SELECT status, tries, error, problems FROM trade_scans WHERE report_id = 'oge:a'").get();
  assert.equal(a.status, "disagree", "held after three tries");
  assert.equal(a.tries, 3);
  assert.match(a.problems, /Couldn't be read after 3 tries/);
  const item = await scanItem(db, {}, "oge:a");
  assert.match(item.main, /Last error reading it \(3 tries\): answer cut off/);
});

test("a person confirms a transcription or takes it down; read again requeues", async () => {
  const sqlite = seeded();
  cleanLines(sqlite);
  const db = d1(sqlite);
  const call = ranged(() => copy(ROWS).rows);
  await syncScannedTrades({ SCANNED_TRADES_DAILY: "5" }, db, null, { call, random: () => 0.5 });
  assert.equal(sqlite.prepare("SELECT spot_check FROM trade_scans WHERE report_id = 'oge:a'").get().spot_check, 0);
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", reviewer: "Rae Reviewer" }), "rae@example.org")).error, /compared every row/);
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", compared: "1" }), "")).error, /Enter your name/);
  assert.match((await scanChange(db, "oge:a", form({ action: "approve", compared: "1", reviewer: "Rae Reviewer" }), "rae@example.org")).done, /Checked by Rae Reviewer/);
  assert.equal(sqlite.prepare("SELECT transcribed_by FROM trade_reports WHERE id = 'oge:a'").get().transcribed_by, "Rae Reviewer");
  const html = (await memberTrades(db, "p1")).rows.map((t) => tradeRow(t)).join("");
  assert.match(html, /Read by AI from the scanned report · Checked by Rae Reviewer/);

  // Take oge:b down: its trades go, the summary follows, the report is a link again.
  assert.match((await scanChange(db, "oge:b", form({ action: "reject", reviewer: "Rae Reviewer" }), "")).error, /Say what's wrong/);
  assert.match((await scanChange(db, "oge:b", form({ action: "reject", reviewer: "Rae Reviewer", reason: "Row 2's amount is wrong on the scan" }), "")).done, /link again/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE report_id = 'oge:b'").get().n, 0);
  assert.deepEqual({ ...sqlite.prepare("SELECT parsed, transcribed_at FROM trade_reports WHERE id = 'oge:b'").get() }, { parsed: 0, transcribed_at: null });
  assert.equal(sqlite.prepare("SELECT trades FROM trade_summary WHERE official_id = 'p1' AND year = 2026").get().trades, 2, "only oge:a's trades count");
  assert.match((await scanChange(db, "oge:b", form({ action: "approve", compared: "1", reviewer: "Rae Reviewer" }), "")).error, /Only a transcription published by AI/);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM trade_scan_chunks WHERE report_id = 'oge:b'").get().n > 0);
  assert.match((await scanChange(db, "oge:b", form({ action: "reread" }), "")).done, /Back in the queue/);
  assert.equal(sqlite.prepare("SELECT status FROM trade_scans WHERE report_id = 'oge:b'").get().status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trade_scan_chunks WHERE report_id = 'oge:b'").get().n, 0, "read again from the start");

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

test("the step sends the PDF itself when it can download it, and the link when it can't", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 fake report");
  const fetched = [];
  const budget = { timeLeft: () => 10 * 60 * 1000, fetch: async (url) => (fetched.push(url), { arrayBuffer: async () => pdf.buffer }) };
  const report = { report_id: "oge:a", report_url: "https://example.org/a.pdf" };
  const doc = await pdfSource(report, budget);
  assert.deepEqual(doc, { type: "base64", media_type: "application/pdf", data: toBase64(pdf) });
  assert.equal(atob(doc.data), "%PDF-1.7 fake report");
  await pdfSource(report, budget);
  assert.equal(fetched.length, 1, "downloaded once per report and round");
  const failing = { timeLeft: () => 10 * 60 * 1000, fetch: async () => { throw new Error("524 timeout"); } };
  assert.equal(await pdfSource({ report_id: "oge:b", report_url: "https://example.org/b.pdf" }, failing), "https://example.org/b.pdf");
  const html = { timeLeft: () => 10 * 60 * 1000, fetch: async () => ({ arrayBuffer: async () => new TextEncoder().encode("<html>").buffer }) };
  assert.equal(await pdfSource({ report_id: "oge:c", report_url: "https://example.org/c.pdf" }, html), "https://example.org/c.pdf", "not a PDF: the link");
  assert.equal(await pdfSource({ report_id: "oge:d", report_url: "https://example.org/d.pdf" }, null), "https://example.org/d.pdf");
  const big = new Uint8Array(100000).fill(65);
  assert.equal(atob(toBase64(big)).length, 100000);
});
