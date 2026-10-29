// Times a page's own Function code against the production D1 database,
// read-only, with every query timed: which section is slow, and why.
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node --import ./workers/sync/test/sql-stub.mjs tools/time_page.mjs /calaveras/ /place/ca/calaveras/
// Queries go through D1's HTTP API (one request each, so times include about
// 100 ms of network); only SELECT, WITH and EXPLAIN are allowed through.
// Static files the page reads (env.ASSETS) come from this checkout.
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const DB_ID = "b6afd5de-4804-4c2b-bb14-af4314190e9d"; // workers/sync/wrangler.toml
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed");

const log = [];
async function query(sql, params) {
  if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql)) throw new Error(`read-only: refused ${sql.slice(0, 60)}`);
  const t = Date.now();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  const ms = Date.now() - t;
  const r = body.result && body.result[0];
  log.push({ sql: sql.replace(/\s+/g, " ").trim().slice(0, 110), ms, d1_ms: r && r.meta ? Math.round(r.meta.duration) : null, rows_read: r && r.meta ? r.meta.rows_read : null, ok: body.success });
  if (!body.success) throw new Error((body.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`);
  return r;
}
const stmt = (sql, params = []) => ({
  bind: (...p) => stmt(sql, p),
  first: async (col) => { const r = (await query(sql, params)).results[0] ?? null; return col && r ? r[col] : r; },
  all: async () => ({ results: (await query(sql, params)).results }),
  raw: async () => (await query(sql, params)).results.map((r) => Object.values(r)),
  run: async () => { throw new Error("read-only: run() refused"); },
});
const DB = { prepare: (sql) => stmt(sql), batch: async () => { throw new Error("read-only: batch() refused"); } };
const ASSETS = { fetch: async (u) => { try { return new Response(await readFile(new URL(`.${new URL(u).pathname}`, ROOT))); } catch { return new Response("", { status: 404 }); } } };

const ROUTES = [
  [/^\/calaveras\/$/, "functions/calaveras/index.js"],
  [/^\/briefing\/$/, "functions/briefing/index.js"],
  [/^\/$/, "functions/index.js"],
];
// Any other page: its folder's catch-all ([[path]].js) or index.js.
import { existsSync } from "node:fs";
function routeFile(path) {
  const hit = ROUTES.find(([re]) => re.test(path.split("?")[0]));
  if (hit) return hit[1];
  const seg = path.split("?")[0].split("/").filter(Boolean)[0];
  for (const f of [`functions/${seg}/[[path]].js`, `functions/${seg}/index.js`, `functions/${seg}.js`]) if (existsSync(new URL(f, ROOT))) return f;
  return null;
}
for (const path of process.argv.slice(2)) {
  const file = routeFile(path);
  if (!file) { console.log(`${path}: no route here`); continue; }
  log.length = 0;
  const headers = path.startsWith("/briefing/") ? { cookie: "pillory_districts=st=CA&cd=5&su=4&sl=8&co=06009" } : {};
  const t = Date.now();
  // Catch-all routes ([[path]].js) get the segments after their prefix, as Pages passes them.
  const params = file.includes("[[path]]") ? { path: path.split("?")[0].split("/").filter(Boolean).slice(1) } : {};
  const handler = (await import(new URL(file, ROOT))).onRequestGet || (await import(new URL(file, ROOT))).onRequest;
  const res = await handler({ request: new Request(`https://thepillory.co${path}`, { headers }), env: { DB, ASSETS }, params, next: async () => new Response(""), waitUntil: () => {} });
  const html = await res.text();
  console.log(`\n=== ${path}: ${Date.now() - t} ms, HTTP ${res.status}, ${html.length} bytes, ${log.length} queries, ${log.reduce((a, q) => a + (q.rows_read || 0), 0)} rows read${/Couldn.t load this section/.test(html) ? ", a section failed" : ""}`);
  for (const q of [...log].sort((a, b) => b.ms - a.ms)) console.log(`${String(q.ms).padStart(6)} ms  d1 ${String(q.d1_ms ?? "?").padStart(5)} ms  ${String(q.rows_read ?? "?").padStart(9)} rows  ${q.ok ? "" : "FAILED "}${q.sql}`);
}
