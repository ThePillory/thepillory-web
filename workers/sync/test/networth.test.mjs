// node --test test/networth.test.mjs
// "Net worth, as reported" (docs/funding.md) on the pages: a member who files
// electronically, a member who files on paper, a member first elected recently
// (a candidate report before taking office), a long-serving member (the
// earliest report online), the President (scanned reports) and a justice.
// Served from the real schema in SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { networthPoints, networthLine, compactMoney, rangeText } from "../../../functions/_lib/networth.js";
import { rangeBands } from "../../../functions/_lib/charts.js";

const ROOT = new URL("../../../", import.meta.url);
const JUSTICES = {
  justices: [{
    slug: "ann-able", name: "Ann Able", title: "Associate Justice", oath_date: "January 1, 2010", state: "Example", appointed_by: "Example",
    biography: [], senate: null, sources: { senate: "https://www.senate.gov/x", biography: "https://www.supremecourt.gov/x", members: "https://www.supremecourt.gov/y" },
  }],
};
const ASSETS = {
  fetch: async (u) => {
    const path = new URL(u).pathname;
    if (path === "/data/scotus/justices.json") return new Response(JSON.stringify(JUSTICES));
    if (path === "/data/constitution.json") return new Response(readFileSync(new URL("data/constitution.json", ROOT), "utf8"));
    return new Response("not found", { status: 404 });
  },
};
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())) };
}

function seeded({ withTable = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (!withTable && f.startsWith("0036")) continue;
    sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  const off = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, district_code, party, state, bioguide_id, source_url, last_verified, active)
     VALUES (?, ?, ?, ?, ?, 'federal', ?, ?, ?, ?, 'Party A', ?, ?, 'https://example.org/o', '2026-10-01', 1)`
  );
  off.run("h1", "erin-electronic", "Erin Electronic", "Electronic", "U.S. Representative", "us-house", "us-house", "CA-5", "5", "CA", "E000001");
  off.run("h2", "pat-paper", "Pat Paper", "Paper", "U.S. Representative", "us-house", "us-house", "TX-12", "12", "TX", "P000001");
  off.run("h3", "nell-new", "Nell New", "New", "U.S. Representative", "us-house", "us-house", "OH-3", "3", "OH", "N000001");
  off.run("s1", "lou-long", "Lou Long", "Long", "U.S. Senator", "us-senate", "us-senate", null, null, "WA", "L000001");
  off.run("p1", "pres", "Example President", "President", "President of the United States", "us-executive", "us-executive", null, null, null, null);
  if (!withTable) return d1(sqlite);
  const r = sqlite.prepare(
    `INSERT INTO networth_reports (id, official_id, source, kind, amended, year, filed_on, before_office, status, reason, method, assets, liabilities, low, high, low_open, high_open, report_url, parser)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const read = (id, who, src, kind, year, filed, low, high, { amended = 0, before = 0, highOpen = 0 } = {}) =>
    r.run(id, who, src, kind, amended, year, filed, before, "read", null, src === "senate" ? "html" : "text", 40, 2, low, high, 0, highOpen, `https://example.org/${id}.pdf`);
  const not = (id, who, src, kind, year, filed, status, { before = 0 } = {}) =>
    r.run(id, who, src, kind, 0, year, filed, before, status, status, null, null, null, null, null, 0, 0, `https://example.org/${id}.pdf`);
  // Electronic: three annual reports, the 2023 one amended (the amendment wins).
  read("house:11", "h1", "house", "annual", 2022, "2023-05-15", 900000, 2400000);
  read("house:12", "h1", "house", "annual", 2023, "2024-05-15", 1000000, 2500000);
  read("house:13", "h1", "house", "annual", 2023, "2024-08-01", 1100000, 2600000, { amended: 1 });
  read("house:14", "h1", "house", "annual", 2024, "2025-05-15", 3193041, 15155998, { highOpen: 1 });
  // Paper: nothing read.
  not("house:81", "h2", "house", "annual", 2024, "2025-05-15", "scan");
  not("house:82", "h2", "house", "annual", 2023, "2024-05-15", "scan");
  // Recently elected: a candidate report before taking office, then one annual report.
  read("house:21", "h3", "house", "candidate", 2024, "2024-05-10", 1419053, 3736000, { before: 1 });
  read("house:22", "h3", "house", "annual", 2024, "2025-05-15", 1500000, 3900000);
  // Long-serving: annual reports back to 2012, the earliest online.
  read("senate:a", "s1", "senate", "annual", 2012, "2013-05-15", -315941, 3538995);
  read("senate:b", "s1", "senate", "annual", 2024, "2025-05-15", 331041, 2189999);
  // The President: scanned reports, and a candidate report released only on request.
  not("oge:1", "p1", "oge", "annual", 2024, "2025-06-13", "scan");
  not("oge:2", "p1", "oge", "candidate", 2023, "2023-04-14", "request", { before: 1 });
  // A justice.
  read("judiciary:ann-able:2024", "justice:ann-able", "judiciary", "annual", 2024, null, 13965036, 50979999);
  return d1(sqlite);
}

const reps = (await import("../../../functions/reps/[[path]].js")).onRequestGet;
const justices = (await import("../../../functions/justices/[[path]].js")).onRequestGet;
async function get(fn, path, db = seeded()) {
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await fn({ request, env: { DB: db, ASSETS }, params: { path: parts }, waitUntil: () => {} });
  return { res, html: await res.text() };
}
const fold = (html, id) => {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const next = html.indexOf('<details class="fold', at); // the next section (the chart's own table is a <details> too)
  return html.slice(at, next < 0 ? undefined : next);
};
const head = (html) => html.slice(html.indexOf('<header class="page-head'), html.indexOf("</header>", html.indexOf('<header class="page-head')));
const line = (html) => (head(html).match(/<p class="small networth-line">.*?<\/p>/) || [""])[0];

test("money in short form, and ranges with open ends", () => {
  assert.equal(compactMoney(3193041), "$3.2M");
  assert.equal(compactMoney(15155998), "$15M");
  assert.equal(compactMoney(-315941), "−$316K");
  assert.equal(compactMoney(999999), "$1M");
  assert.equal(compactMoney(203329048), "$203M");
  assert.equal(compactMoney(950), "$950");
  assert.equal(rangeText({ low: 3193041, high: 15155998, low_open: 0, high_open: 1 }), "$3.2M–$15M or more");
});

test("a member who files electronically: earliest report online to the latest, the amendment counted", async () => {
  const { res, html } = await get(reps, "/reps/erin-electronic/");
  assert.equal(res.status, 200);
  assert.match(line(html), /Net worth, as reported: \$900K–\$2\.4M \(2022, earliest report online\) → \$3\.2M–\$15M or more \(2024\)/);
  assert.match(line(html), /href="#more-networth" data-mode-set="detailed"/);
  const sec = fold(html, "more-networth");
  assert.match(sec, /Estimated net worth: \$3,193,041–\$15,155,998 or more \(2024\), as reported in ranges\./);
  // One band per year, each linked to its report; the 2023 band is the amendment's.
  assert.equal((sec.match(/<i class="band/g) || []).length, 3);
  assert.match(sec, /href="https:\/\/example\.org\/house:13\.pdf"/);
  assert.doesNotMatch(sec, /house:12\.pdf/);
  assert.match(sec, /Show the numbers/);
  assert.match(sec, /<td>\$1,100,000<\/td><td>\$2,600,000<\/td>/);
  // The limits, always with the chart, and the rule on commercial use.
  assert.match(sec, /Reports give values in ranges, not exact amounts\. A personal home that doesn't earn income isn't reported, and neither are some government retirement accounts/);
  assert.match(sec, /reported only as "Over \$1,000,000"/);
  assert.match(sec, /So this is an estimate from the reports, not an exact figure\./);
  assert.match(sec, /may not be used for commercial purposes/);
  // No rankings, comparisons or change in percent.
  const words = (sec + line(html)).replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(words, /%|richest|rank|salary|grew/i);
});

test("a member who files on paper: no line, the reports linked", async () => {
  const { html } = await get(reps, "/reps/pat-paper/");
  assert.equal(line(html), "");
  assert.doesNotMatch(html, /Net worth, as reported:/);
  const sec = fold(html, "more-networth");
  assert.match(sec, /No financial disclosure report for Pat Paper has been read yet\./);
  assert.match(sec, /2024: Scanned report: not read yet/);
  assert.match(sec, /2023: Scanned report: not read yet/);
});

test("a member first elected recently: before taking office", async () => {
  const { html } = await get(reps, "/reps/nell-new/");
  assert.match(line(html), /Net worth, as reported: \$1\.4M–\$3\.7M \(2024, before taking office\) → \$1\.5M–\$3\.9M \(2024\)/);
  const sec = fold(html, "more-networth");
  assert.match(sec, /2024, before taking office/);
  assert.match(sec, /The lighter band is the report filed before taking office\./);
  assert.match(sec, /band is-before/);
});

test("a long-serving member: the earliest report online, a negative low end", async () => {
  const { html } = await get(reps, "/reps/lou-long/");
  assert.match(line(html), /Net worth, as reported: −\$316K–\$3\.5M \(2012, earliest report online\) → \$331K–\$2\.2M \(2024\)/);
  assert.match(fold(html, "more-networth"), /range-bands-zero/);
});

test("the President: scanned reports and one on request, no line", async () => {
  const { html } = await get(reps, "/reps/pres/");
  assert.equal(line(html), "");
  const sec = fold(html, "more-networth");
  assert.match(sec, /2024: Scanned report: not read yet/);
  assert.match(sec, /2023, before taking office: Available from OGE on request/);
});

test("a justice: the line under the title and the chart on More", async () => {
  const { res, html } = await get(justices, "/justices/ann-able/");
  assert.equal(res.status, 200);
  assert.match(line(html), /Net worth, as reported: \$14M–\$51M \(2024, earliest report online\)/);
  assert.doesNotMatch(line(html), /→/);
  assert.match(fold(html, "more-networth"), /Estimated net worth: \$13,965,036–\$50,979,999 \(2024\)/);
});

test("before the table exists: no line, the page still loads", async () => {
  const { res, html } = await get(reps, "/reps/erin-electronic/", seeded({ withTable: false }));
  assert.equal(res.status, 200);
  assert.equal(line(html), "");
});

test("the earliest report read, when an earlier one isn't read", () => {
  const p = networthPoints([
    { id: "a", kind: "annual", year: 2019, filed_on: "2020-05-01", status: "scan", amended: 0, before_office: 0, report_url: "https://x/a" },
    { id: "b", kind: "annual", year: 2020, filed_on: "2021-05-01", status: "read", amended: 0, before_office: 0, low: 1, high: 2, low_open: 0, high_open: 0, report_url: "https://x/b" },
  ]);
  assert.match(networthLine(p), /\(2020, earliest report read\)<\/a>/);
  assert.equal(p.unread.length, 1);
});

test("range bands: heights only, one band per point, a table", () => {
  const html = rangeBands([{ label: "2024", tick: "2024", low: 100, high: 300, href: "https://x/y" }, { label: "2025", tick: "2025", low: 200, high: 400, highOpen: true }], { format: String });
  assert.equal((html.match(/<i class="band/g) || []).length, 2);
  assert.doesNotMatch(html, /style="(?!height:)/);
  assert.match(html, /band is-open/);
  assert.match(html, /<td>400 or more<\/td>/);
  assert.equal(rangeBands([], {}), "");
});
