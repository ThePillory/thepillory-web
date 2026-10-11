// node --test test/trades.test.mjs
// Stock trades (docs/trades.md) on the pages: a member who files electronically
// (with spouse trades and one filed more than 45 days after the trade), a member
// who files on paper, /reps/<slug>/trades/ paging, /trades/ filters, and Quick
// mode's one line. Served from the real schema in SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { summaryLine, filedLate, tradeFilters } from "../../../functions/_lib/trades.js";

const ROOT = new URL("../../../", import.meta.url);
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};
const queries = [];
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => (queries.push(sql), { results: sqlite.prepare(sql).all(...binds) }),
    first: async () => (queries.push(sql), sqlite.prepare(sql).get(...binds) ?? null),
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())) };
}
const YEAR = new Date().getUTCFullYear();

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  const off = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, district_code, party, state, bioguide_id, source_url, last_verified, active)
     VALUES (?, ?, ?, ?, ?, 'federal', ?, ?, ?, ?, 'Party A', ?, ?, 'https://example.org/o', '2026-10-01', 1)`
  );
  off.run("h1", "erin-electronic", "Erin Electronic", "Electronic", "U.S. Representative", "us-house", "us-house", "CA-5", "5", "CA", "E000001");
  off.run("h2", "pat-paper", "Pat Paper", "Paper", "U.S. Representative", "us-house", "us-house", "TX-12", "12", "TX", "P000001");
  off.run("s1", "sam-senator", "Sam Senator", "Senator", "U.S. Senator", "us-senate", "us-senate", null, null, "WA", "S000001");
  const r = (id, chamber, official, filed, paper, parsed, n) =>
    sqlite.prepare(`INSERT INTO trade_reports (id, chamber, official_id, filer_name, state, filed_on, report_url, paper, parsed, trade_count, source_url) VALUES (?, ?, ?, 'Filer', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chamber, official, chamber === "us-senate" ? "WA" : official === "h1" ? "CA" : "TX", filed, `https://example.org/${id}.pdf`, paper, parsed, n, `https://example.org/${id}.pdf`);
  r("house:1", "us-house", "h1", `${YEAR}-09-15`, 0, 1, 30);
  r("house:2", "us-house", "h2", `${YEAR}-08-01`, 1, 0, 0);
  r("senate:a", "us-senate", "s1", `${YEAR}-09-01`, 0, 1, 1);
  r("house:9", "us-house", null, `${YEAR}-09-02`, 0, 1, 0);
  const t = sqlite.prepare(
    `INSERT INTO trades (report_id, n, official_id, chamber, state, transaction_date, filed_on, days_to_file, owner, asset_name, ticker, asset_type, type, amount, amount_min, amount_max, sic, sector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ST', ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 1; i <= 30; i++) {
    const day = String(Math.min(28, i)).padStart(2, "0");
    const month = i <= 28 ? "07" : "06";
    t.run("house:1", i, "h1", "us-house", "CA", `${YEAR}-${month}-${day}`, `${YEAR}-09-15`, i === 28 ? 49 : 20, i % 2 ? "Spouse" : "Self",
      `Example Company ${String(i).padStart(2, "0")} Inc.`, `EX${i}`, i === 2 ? "Sale" : "Purchase", "$1,001 - $15,000", 1001, 15000, "3571", "Manufacturing");
  }
  t.run("senate:a", 1, "s1", "us-senate", "WA", `${YEAR}-08-20`, `${YEAR}-09-01`, 12, "Joint", "Bank of Example", "BEX", "Purchase", "$15,001 - $50,000", 15001, 50000, "6022", "Finance, Insurance and Real Estate");
  sqlite.exec(`INSERT INTO trade_summary (official_id, year, trades, total_min, total_max, open_ended, paper) VALUES ('h1', ${YEAR}, 30, 30030, 450000, 0, 0), ('h2', ${YEAR}, 0, 0, 0, 0, 1), ('s1', ${YEAR}, 1, 15001, 50000, 0, 0)`);
  sqlite.exec(`INSERT INTO congress_committees (official_id, committee_id, name, parent, title, source_url) VALUES
    ('h1', 'HSBA', 'Committee on Financial Services', NULL, NULL, 'https://theunitedstates.io/congress-legislators/committee-membership-current.json'),
    ('h1', 'HSBA16', 'Subcommittee on Capital Markets', 'Committee on Financial Services', 'Ranking Member', 'https://theunitedstates.io/congress-legislators/committee-membership-current.json')`);
  // The executive branch: a President whose 278-T is posted, and a Cabinet member's released only on request.
  sqlite.exec(`INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, rank, source_url, last_verified, active) VALUES
    ('p1', 'pat-president', 'Pat President', 'President', 'President of the United States', 'federal', 'us-executive', 'us-executive', 1, 'https://example.org/o', '2026-10-01', 1),
    ('c1', 'cam-cabinet', 'Cam Cabinet', 'Cabinet', 'Secretary of Example', 'federal', 'us-executive', 'us-executive', 12, 'https://example.org/o', '2026-10-01', 1)`);
  sqlite.exec(`INSERT INTO disclosures (id, official_id, source, kind, doc_type, filer_name, position, agency, filed_on, document_url, request_url, source_url) VALUES
    ('oge:p', 'p1', 'oge', 'financial', '278 Transaction', 'President, Pat', 'President', 'Executive Office of the President', '${YEAR}-03-25', 'https://extapps2.oge.gov/p.pdf', NULL, 'https://www.oge.gov/'),
    ('oge:c', 'c1', 'oge', 'financial', '278 Transaction', 'Cabinet, Cam', 'Secretary', 'Department of Example', '${YEAR}-04-02', NULL, 'https://extapps2.oge.gov/201/request', 'https://www.oge.gov/')`);
  sqlite.exec(`INSERT INTO trade_reports (id, chamber, official_id, filer_name, filed_on, report_url, request_url, paper, parsed, trade_count, source_url, position, agency) VALUES
    ('oge:p1', 'us-executive', 'p1', 'President, Pat', '${YEAR}-03-20', 'https://extapps2.oge.gov/p.pdf', NULL, 0, 1, 2, 'https://extapps2.oge.gov/p.pdf', 'President', 'Executive Office of the President'),
    ('oge:c1', 'us-executive', 'c1', 'Cabinet, Cam', '${YEAR}-04-02', NULL, 'https://extapps2.oge.gov/201/request', 0, 0, 0, 'https://extapps2.oge.gov/201/request', 'Secretary', 'Department of Example')`);
  t.run("oge:p1", 1, "p1", "us-executive", null, `${YEAR}-02-02`, `${YEAR}-03-20`, 46, null, "Example Motors Inc. (EXM)", "EXM", "Purchase", "$1,001 - $15,000", 1001, 15000, "3711", "Manufacturing");
  t.run("oge:p1", 2, "p1", "us-executive", null, `${YEAR}-02-10`, `${YEAR}-03-20`, 38, "Spouse", "Example Municipal Bond Fund (spouse)", null, "Sale", "$50,001 - $100,000", 50001, 100000, null, null);
  sqlite.exec(`INSERT INTO trade_summary (official_id, year, trades, total_min, total_max, open_ended, paper) VALUES ('p1', ${YEAR}, 2, 51002, 115000, 0, 0)`);
  return d1(sqlite);
}

const reps = (await import("../../../functions/reps/[[path]].js")).onRequestGet;
const trades = (await import("../../../functions/trades/[[path]].js")).onRequestGet;
async function get(fn, path, db = seeded()) {
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await fn({ request, env: { DB: db, ASSETS }, params: { path: parts }, waitUntil: () => {} });
  return { res, html: await res.text() };
}
const fold = (html, id) => {
  const at = html.indexOf(`id="${id}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</details>", at));
};

test("a member who files electronically: summary, committees as facts, spouse trades, the 45-day line", async () => {
  const { res, html } = await get(reps, "/reps/erin-electronic/");
  assert.equal(res.status, 200);
  const sec = fold(html, "more-trades");
  assert.ok(sec, "a Stock trades section on the More tab");
  assert.match(sec, new RegExp(`30 trades reported in ${YEAR}, totaling \\$30,030–\\$450,000 in ranges as filed\\.`));
  assert.match(sec, /Committee on Financial Services: Subcommittee on Capital Markets/);
  assert.match(sec, /Ranking Member/);
  assert.match(sec, /Owner: Spouse/);
  assert.match(sec, /Filed 49 days after the trade/);
  assert.equal((sec.match(/Filed \d+ days after/g) || []).length, 1, "only the trade past 45 days");
  assert.doesNotMatch(sec, /\blate\b|violation|conflict|suspicious/i);
  assert.equal((sec.match(/class="compact-row trade-row"/g) || []).length, 25, "25 at a time");
  assert.match(sec, /href="\/reps\/erin-electronic\/trades\/\?offset=25" data-load-more="trade-list"/);
  assert.match(sec, /may not be used for commercial purposes/);
  assert.match(html, /Reported 30 stock trades this year/, "Quick mode's one line");
  // The newest first.
  assert.ok(sec.indexOf("Example Company 28") < sec.indexOf("Example Company 27"));
});

test("Load more: the next page of a member's trades", async () => {
  const { html } = await get(reps, "/reps/erin-electronic/trades/?offset=25");
  assert.equal((html.match(/class="compact-row trade-row"/g) || []).length, 5);
  assert.match(html, /id="trade-list"/);
  assert.doesNotMatch(html, /data-load-more=/);
});

test("a member who files on paper: the report linked, nothing guessed", async () => {
  const { html } = await get(reps, "/reps/pat-paper/");
  const sec = fold(html, "more-trades");
  assert.match(sec, /Filed on paper: see the report/);
  assert.match(sec, /href="https:\/\/example\.org\/house:2\.pdf"/);
  assert.equal((sec.match(/class="compact-row trade-row"/g) || []).length, 0);
  assert.doesNotMatch(html, /Reported \d+ stock trade/);
});

test("/trades/: newest first, filters, paging, member names; unmatched reports never shown", async () => {
  queries.length = 0;
  const all = await get(trades, "/trades/");
  assert.equal(all.res.status, 200);
  assert.equal((all.html.match(/class="compact-row trade-row"/g) || []).length, 25);
  assert.ok(all.html.indexOf("Bank of Example") < all.html.indexOf("Example Company 28"), "newest first: the August trade, then July");
  assert.match(all.html, /Erin Electronic, CA/);
  assert.match(all.html, /href="\/trades\/\?offset=25" data-load-more="trade-list"/);
  const senate = await get(trades, "/trades/?chamber=us-senate");
  assert.equal((senate.html.match(/class="compact-row trade-row"/g) || []).length, 1);
  assert.match(senate.html, /Bank of Example \(BEX\)/);
  assert.match(senate.html, /Owner: Joint/);
  const sector = await get(trades, `/trades/?sector=${encodeURIComponent("Finance, Insurance and Real Estate")}`);
  assert.equal((sector.html.match(/trade-row/g) || []).length, 1);
  const byName = await get(trades, "/trades/?q=erin");
  assert.equal((byName.html.match(/class="compact-row trade-row"/g) || []).length, 25);
  const state = await get(trades, "/trades/?state=WA");
  assert.equal((state.html.match(/class="compact-row trade-row"/g) || []).length, 1);
  for (const sql of queries.filter((s) => /FROM trades/.test(s))) assert.match(sql, /LIMIT \?/, "every list is paged");
  assert.match(all.html, /Ethics in Government Act/);
});

test("before the first load: an honest empty state", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const { html } = await get(trades, "/trades/", d1(sqlite));
  assert.match(html, /none are loaded yet/);
});

test("wording", () => {
  assert.equal(summaryLine({ year: 2026, trades: 2, total_min: 16002, total_max: 65000 }), "2 trades reported in 2026, totaling $16,002–$65,000 in ranges as filed.");
  assert.equal(summaryLine({ year: 2026, trades: 1, total_min: 50000001, total_max: null, open_ended: 1 }), "1 trade reported in 2026, totaling at least $50,000,001 in ranges as filed (one range is open-ended).");
  assert.equal(filedLate({ days_to_file: 45 }), "");
  assert.equal(filedLate({ days_to_file: 112 }), "Filed 112 days after the trade");
  assert.deepEqual(tradeFilters(new URLSearchParams("chamber=us-senate&state=wa&sector=Nope&q=50%25")), { chamber: "us-senate", state: "", sector: "", q: "50", offset: 0 });
});

test("the President's 278-T: office and agency as facts, trades as filed, the 45-day line", async () => {
  const { res, html } = await get(reps, "/reps/pat-president/");
  assert.equal(res.status, 200);
  const sec = fold(html, "more-trades");
  assert.ok(sec, "the same Stock trades section on the More tab");
  assert.match(sec, /<p class="label">Office<\/p>[\s\S]*?President[\s\S]*?Executive Office of the President/);
  assert.match(sec, new RegExp(`2 trades reported in ${YEAR}, totaling \\$51,002–\\$115,000 in ranges as filed\\.`));
  assert.match(sec, /Example Motors Inc\. \(EXM\)/);
  assert.match(sec, /Filed 46 days after the trade/);
  assert.match(sec, /Owner: Spouse/);
  assert.match(sec, /Office of Government Ethics/);
  assert.match(sec, /may not be used for commercial purposes/);
  assert.doesNotMatch(sec, /Committee assignments/);
});

test("a Cabinet member's 278-T released only on request: the request link, nothing guessed", async () => {
  const { html } = await get(reps, "/reps/cam-cabinet/");
  const sec = fold(html, "more-trades");
  assert.match(sec, /href="https:\/\/extapps2\.oge\.gov\/201\/request"[\s\S]*?Available from OGE on request/);
  assert.match(sec, /Department of Example/);
  assert.equal((sec.match(/class="compact-row trade-row"/g) || []).length, 0);
});

test("/trades/: the Executive branch filter", async () => {
  const { html } = await get(trades, "/trades/?chamber=us-executive");
  assert.match(html, /<option value="us-executive" selected>Executive branch<\/option>/);
  assert.equal((html.match(/class="compact-row trade-row"/g) || []).length, 2);
  assert.match(html, /Pat President/);
  const all = await get(trades, "/trades/?chamber=us-house");
  assert.doesNotMatch(all.html, /Pat President/);
});
