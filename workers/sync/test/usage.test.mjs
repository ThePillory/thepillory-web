// node --test test/usage.test.mjs
// What Cloudflare usage costs (src/usage/, functions/_lib/usage.js, /admin/usage/): D1 rows
// counted per query without changing results, route patterns and SQL shapes that keep nothing
// about a visitor or a value, GraphQL rows folded into days and priced at Workers Paid rates,
// the month's projection, the alert's two triggers, and the admin page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { newTally, meterD1, sqlShape, sqlKey, routePattern, visitorKind } from "../src/usage/meter.js";
import { dailyUsage, priceMonth, dayCost, PRICES } from "../src/usage/cloudflare.js";
import { monthOutlook, alertReasons, jumps } from "../src/usage/outlook.js";
import { usageEmail, recordStepUsage, syncUsageCheck } from "../src/usage/sync.js";
import { startUsage, finishUsage, flush } from "../../../functions/_lib/usage.js";
import { usageData, adminUsageMain } from "../../../functions/_lib/usage-pages.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds), meta: { rows_read: 7, rows_written: 0 } }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => { const r = sqlite.prepare(sql).run(...binds); return { meta: { rows_read: 1, rows_written: Number(r.changes), changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  return { sqlite, db: d1(sqlite) };
}

test("the meter adds each query's rows without changing what the caller gets", async () => {
  const { sqlite, db } = freshDb();
  sqlite.exec("INSERT INTO sync_state (key, value) VALUES ('a', '1')");
  const tally = newTally();
  const m = meterD1(db, tally);
  assert.deepEqual({ ...(await m.prepare("SELECT value FROM sync_state WHERE key = ?").bind("a").first()) }, { value: "1" });
  assert.equal(await m.prepare("SELECT value FROM sync_state WHERE key = 'a'").first("value"), "1");
  await m.batch([m.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?)").bind("b", "2")]);
  assert.equal(tally.rowsRead, 7 + 7 + 1);
  assert.equal(tally.rowsWritten, 1);
  assert.deepEqual([...tally.queries.keys()], ["SELECT value FROM sync_state WHERE key = ?", "INSERT INTO sync_state (key, value) VALUES (?…)"], "literals become ?: one shape for both lookups");
});

test("SQL shapes, route patterns and visitor kinds keep nothing about a value or a visitor", () => {
  assert.equal(sqlShape("SELECT *  FROM officials WHERE slug = 'jane-doe' AND id IN (1, 2, 3) LIMIT 25"), "SELECT * FROM officials WHERE slug = ? AND id IN (?…) LIMIT ?");
  assert.equal(sqlKey("x"), sqlKey("x"));
  assert.equal(routePattern("/reps/jane-doe/votes/"), "/reps/:id/votes/");
  assert.equal(routePattern("/laws/bills/us-119-hr-1/rollcall/"), "/laws/bills/:id/rollcall/");
  assert.equal(routePattern("/elections/2026-11-03/measure/prop-40/"), "/elections/:id/measure/:id/");
  assert.equal(routePattern("/place/ca/santa-clara/"), "/place/:id/:id/");
  assert.equal(routePattern("/"), "/");
  assert.equal(routePattern("/assets/pillory.css"), "/assets/*.css");
  assert.equal(routePattern("/search/?q=jane"), "/search/");
  const req = (ua, cf = {}) => Object.assign(new Request("https://x.test/", { headers: ua ? { "user-agent": ua } : {} }), {}) && Object.defineProperty(new Request("https://x.test/", { headers: ua ? { "user-agent": ua } : {} }), "cf", { value: cf });
  assert.equal(visitorKind(req("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605")), "person");
  assert.equal(visitorKind(req("Mozilla/5.0 (compatible; Googlebot/2.1)", { verifiedBotCategory: "Search Engine Crawler" })), "verified-bot");
  assert.equal(visitorKind(req("Mozilla/5.0 (compatible; SemrushBot/7)")), "likely-bot");
  assert.equal(visitorKind(req("")), "likely-bot");
  assert.equal(visitorKind(req("Mozilla/5.0 Safari", { botManagement: { score: 5 } })), "likely-bot");
});

test("a page request's rows go to usage_routes and usage_queries by route and visitor kind, never the URL", async () => {
  const { sqlite, db } = freshDb();
  const context = { request: new Request("https://x.test/reps/jane-doe/?tab=votes", { headers: { "user-agent": "Mozilla/5.0 Safari" } }), env: { DB: db }, data: {}, waitUntil: () => {} };
  const u = startUsage(context);
  u.tally.rowsRead = 150000;
  u.tally.queries.set("SELECT v.* FROM votes v WHERE v.id IN (?…)", { calls: 1, rowsRead: 150000, rowsWritten: 0 });
  finishUsage(context, u);
  await flush(db);
  const r = sqlite.prepare("SELECT * FROM usage_routes").all();
  assert.deepEqual(r.map((x) => [x.route, x.visitor, x.requests, x.rows_read]), [["/reps/:id/", "person", 1, 150000]]);
  assert.doesNotMatch(JSON.stringify(sqlite.prepare("SELECT * FROM usage_routes, usage_queries").all()), /jane-doe|tab=votes|Safari/);
  assert.equal(sqlite.prepare("SELECT rows_read FROM usage_queries WHERE source = 'pages'").get().rows_read, 150000);
});

test("a sync step's rows go to usage_steps, and its expensive queries by shape", async () => {
  const { sqlite, db } = freshDb();
  const t = newTally();
  t.rowsRead = 330000;
  t.rowsWritten = 1400000;
  t.queries.set("INSERT INTO bill_list (…) SELECT …", { calls: 1, rowsRead: 300000, rowsWritten: 1400000 });
  t.queries.set("SELECT value FROM sync_state WHERE key = ?", { calls: 3, rowsRead: 3, rowsWritten: 0 });
  await recordStepUsage(db, "2026-10-20", "page-summaries", t);
  await recordStepUsage(db, "2026-10-20", "page-summaries", t);
  assert.deepEqual({ ...sqlite.prepare("SELECT rounds, rows_read, rows_written FROM usage_steps").get() }, { rounds: 2, rows_read: 660000, rows_written: 2800000 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM usage_queries").get().n, 1, "small queries aren't kept by shape");
});

// A month like October 2026: the page summaries rewriting bill_list (8 indexes) many times a day.
const GQL = {
  d1: Array.from({ length: 28 }, (_, i) => ({ dimensions: { date: `2026-10-${String(i + 1).padStart(2, "0")}`, databaseId: "db" }, sum: { readQueries: 1, writeQueries: 1, rowsRead: 4e9, rowsWritten: 17e6 } })),
  workers: [{ dimensions: { date: "2026-10-01", scriptName: "pillory-sync" }, sum: { requests: 1000, errors: 0, subrequests: 0, cpuTimeUs: 2e9 } }],
  doPeriodic: [{ dimensions: { date: "2026-10-01", namespaceId: "n" }, sum: { activeTime: 3600e6, cpuTime: 1e6, storageReadUnits: 0, storageWriteUnits: 0 } }],
  r2Ops: [{ dimensions: { date: "2026-10-01", bucketName: "pillory-sources", actionType: "PutObject" }, sum: { requests: 10 } }, { dimensions: { date: "2026-10-01", bucketName: "pillory-sources", actionType: "GetObject" }, sum: { requests: 20 } }, { dimensions: { date: "2026-10-01", bucketName: "pillory-sources", actionType: "DeleteObject" }, sum: { requests: 5 } }],
  pages: { error: "not authorized" },
};

test("GraphQL rows folded into days and priced after the included amounts", () => {
  const days = dailyUsage(GQL);
  assert.equal(days.length, 28);
  assert.equal(days[0].workersCpuMs, 2e6);
  assert.equal(days[0].doGbSeconds, 3600 * (128 / 1024));
  assert.deepEqual([days[0].r2ClassA, days[0].r2ClassB], [10, 20], "deletes are free");
  const priced = priceMonth(days);
  const writes = priced.lines.find((l) => l.key === "d1RowsWritten");
  assert.equal(writes.used, 28 * 17e6);
  assert.equal(Math.round(writes.dollars), Math.round((28 * 17e6 - 50e6) / 1e6));
  assert.equal(priced.lines[0].key, "d1RowsWritten", "the biggest line first");
  assert.equal(PRICES.d1RowsRead.price, 0.001);
  assert.ok(dayCost(days[0]) > 17);
});

test("the month's projection, and the alert: over the line, or a day over 3 times the week before", () => {
  const days = dailyUsage(GQL);
  const o = monthOutlook(days, "2026-10-28");
  assert.equal(o.inMonth, 31);
  assert.ok(o.projected.total > o.soFar.total);
  assert.match(alertReasons(days, "2026-10-28", 150).reasons[0], /projected at \$\d+\.\d\d, over the \$150 alert line/);
  assert.equal(alertReasons(days, "2026-10-28", 100000).reasons.length, 0, "steady days under a high line: no alert");
  const spiky = days.map((d) => (d.day === "2026-10-27" ? { ...d, d1RowsWritten: 200e6 } : d));
  const r = alertReasons(spiky, "2026-10-28", 100000);
  assert.match(r.reasons[0], /^2026-10-27 cost about \$\d+\.\d\d, more than 3 times the 7 days before/);
  const j = jumps(spiky, "2026-10-27");
  assert.equal(j[0].key, "d1RowsWritten");
  const mail = usageEmail({ ...r, jumped: j, where: { routes: [{ route: "/votes/", requests: 10, rows_read: 3e6, rows_written: 0 }], steps: [{ step: "page-summaries", rounds: 40, rows_read: 1e7, rows_written: 2e8 }], queries: [] }, source: "test" });
  assert.match(mail.subject, /jumped/);
  assert.match(mail.body, /D1 rows written: 200,000,000 \(average 17,000,000\)/);
  assert.match(mail.body, /page-summaries: 40 rounds/);
  assert.match(mail.body, /\/votes\/: 10 requests/);
});

test("the usage-check step: without the analytics token, D1 only from ThePillory's own counts; alerts once a day", async () => {
  const { sqlite, db } = freshDb();
  const today = new Date().toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO usage_steps (day, step, rounds, rows_read, rows_written) VALUES (?, 'page-summaries', 30, 1e9, 400e6)").run(today);
  const sent = [];
  const env = { ALERT_TO: "a@example.org", ALERT_EMAIL: { send: async (m) => sent.push(m) }, USAGE_ALERT_DOLLARS: "150" };
  const r = await syncUsageCheck(env, db);
  assert.equal(r.status, "ok");
  assert.match(r.message, /projected \$\d+\.\d\d \(alert line \$150\)\. The month is projected at/);
  // cloudflare:email exists only inside Workers: here the email fails, and the step says so instead of failing.
  assert.match(r.message, /Alert: not sent: /);
  assert.match(r.message, /CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID isn't set: D1 only/);
  assert.equal((await syncUsageCheck(env, db)).status, "skipped", "once a day");
});

test("/admin/usage/: the month, the days, pages, steps, queries, and the AI cost labeled as Anthropic's", async () => {
  const { sqlite, db } = freshDb();
  const today = new Date().toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO usage_routes (day, route, visitor, requests, rows_read, rows_written) VALUES (?, '/votes/', 'person', 100, 31000000, 0), (?, '/votes/', 'likely-bot', 300, 93000000, 0)").run(today, today);
  sqlite.prepare("INSERT INTO usage_steps (day, step, rounds, rows_read, rows_written) VALUES (?, 'page-summaries', 30, 1e9, 40e6)").run(today);
  sqlite.prepare("INSERT INTO ai_usage (day, step, model, calls, cost_usd) VALUES (?, 'analysis', 'm', 4, 1.25)").run(today);
  const html = adminUsageMain(await usageData(db));
  assert.match(html, /<h1>Cloudflare usage<\/h1>/);
  assert.match(html, /CF_ANALYTICS_TOKEN isn&#x27;t set|CF_ANALYTICS_TOKEN isn't set/);
  assert.match(html, /<th scope="row">\/votes\/<\/th><td>400<\/td><td>124,000,000<\/td><td>310,000<\/td><td>75%<\/td>/);
  assert.match(html, /<th scope="row">Likely bots<\/th><td>300<\/td><td>75%<\/td>/);
  assert.match(html, /page-summaries/);
  assert.match(html, /AI cost, beside it: billed by Anthropic, not Cloudflare/);
  assert.match(html, /\$1\.25/);
});
