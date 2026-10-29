// The Cloudflare usage report: the last 30 days by day from the GraphQL
// Analytics API, priced at Workers Paid rates (workers/sync/src/usage/cloudflare.js),
// so a month's bill can be traced to its line. Read-only.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node tools/cf_usage.mjs [--days 30] [--json out.json]
//
// The token needs Account Analytics Read (and D1 Read, only for the databases' names).
// It's printed nowhere; the report holds counts and dollars only.
import { writeFileSync } from "node:fs";
import { fetchUsage, dailyUsage, priceMonth, dayCost, PRICES } from "../workers/sync/src/usage/cloudflare.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}
const days = Number(arg("--days", 30));
const until = new Date().toISOString().slice(0, 10);
const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

const data = await fetchUsage({ accountId, token, since, until });
const fmt = (v, d = 0) => (v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }));
const usd = (v) => `$${Number(v).toFixed(2)}`;
const out = [];
const p = (s = "") => out.push(s);

p(`# Cloudflare usage, ${since} to ${until}`);
p();
p("## Datasets");
for (const [name, rows] of Object.entries(data)) p(`- ${name}: ${Array.isArray(rows) ? `${rows.length} rows` : `not read: ${rows.error}`}`);

// The databases' names, when the token may list them.
let dbNames = {};
try {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  for (const d of j.result || []) dbNames[d.uuid] = d.name;
} catch {}

const daily = dailyUsage(data);
p();
p("## By day");
p("| Day | Workers req | Pages Fn req | CPU ms | D1 rows read | D1 rows written | DO GB-s | R2 A | R2 B | AI neurons | Est. $ (marginal) |");
p("|---|---|---|---|---|---|---|---|---|---|---|");
for (const d of daily) p(`| ${d.day} | ${fmt(d.workersRequests)} | ${fmt(d.pagesRequests)} | ${fmt(d.workersCpuMs)} | ${fmt(d.d1RowsRead)} | ${fmt(d.d1RowsWritten)} | ${fmt(d.doGbSeconds)} | ${fmt(d.r2ClassA)} | ${fmt(d.r2ClassB)} | ${fmt(d.aiNeurons)} | ${usd(dayCost(d))} |`);

const sum = (rows, f) => rows.reduce((a, d) => a + f(d), 0);
const byKey = (rows, field) => {
  const t = {};
  for (const d of rows) for (const [k, v] of Object.entries(d[field])) for (const [m, x] of Object.entries(v)) ((t[k] ||= {})[m] = ((t[k] || {})[m] || 0) + x);
  return t;
};
p();
p("## Workers scripts (requests, CPU), the whole period");
p("| Script | Requests | CPU ms | Errors |");
p("|---|---|---|---|");
for (const [k, v] of Object.entries(byKey(daily, "byScript")).sort((a, b) => b[1].requests - a[1].requests)) p(`| ${k} | ${fmt(v.requests)} | ${fmt(v.cpuMs)} | ${fmt(v.errors)} |`);
p();
p("## D1 databases, the whole period");
p("| Database | Rows read | Rows written | Read queries | Write queries |");
p("|---|---|---|---|---|");
for (const [k, v] of Object.entries(byKey(daily, "byDatabase")).sort((a, b) => b[1].rowsRead - a[1].rowsRead)) p(`| ${dbNames[k] || k} | ${fmt(v.rowsRead)} | ${fmt(v.rowsWritten)} | ${fmt(v.readQueries)} | ${fmt(v.writeQueries)} |`);

// This calendar month so far, and projected to the month's end.
const month = until.slice(0, 7);
const mDays = daily.filter((d) => d.day.startsWith(month));
const [y, m] = month.split("-").map(Number);
const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
const counted = Number(until.slice(8, 10));
for (const [title, priced] of [
  [`## ${month} so far (${counted} days)`, priceMonth(mDays)],
  [`## ${month} projected to ${inMonth} days`, priceMonth(mDays, { scale: inMonth / counted })],
  [`## The last ${days} days, priced as one month`, priceMonth(daily)],
]) {
  p();
  p(title);
  p("| Line | Used | Included | Billable | $ |");
  p("|---|---|---|---|---|");
  for (const l of priced.lines) p(`| ${l.label} | ${l.used == null ? "—" : `${fmt(l.used, 2)} ${l.unit}`} | ${l.included == null ? "—" : fmt(l.included)} | ${l.billable == null ? "—" : fmt(l.billable, 2)} | ${usd(l.dollars)} |`);
  p(`| **Total** | | | | **${usd(priced.total)}** |`);
}
p();
p(`Rates: ${Object.entries(PRICES).filter(([k]) => k !== "base").map(([, v]) => `${v.label} ${usd(v.price)} per ${fmt(v.per)} ${v.unit} after ${fmt(v.included)}`).join("; ")}.`);
console.log(out.join("\n"));
const json = arg("--json", null);
if (json) writeFileSync(json, JSON.stringify({ since, until, errors: Object.fromEntries(Object.entries(data).filter(([, v]) => !Array.isArray(v))), daily }, null, 1));
