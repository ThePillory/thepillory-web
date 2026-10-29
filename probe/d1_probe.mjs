// TEMPORARY (removed before merge): read-only D1 facts for the usage analysis.
const DB_ID = "b6afd5de-4804-4c2b-bb14-af4314190e9d";
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
let rowsTotal = 0;
async function q(sql, params = []) {
  if (!/^\s*(SELECT|WITH|EXPLAIN)/i.test(sql)) throw new Error("read-only");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }) });
  const body = await res.json();
  const r = (body.result || [])[0];
  if (!body.success) return { error: JSON.stringify(body.errors), results: [], meta: {} };
  rowsTotal += (r.meta && r.meta.rows_read) || 0;
  return r;
}
const out = (s) => console.log(s);
// 1. Sync rounds and steps by day.
const steps = await q("SELECT substr(started_at, 1, 10) AS d, step, COUNT(*) AS n, SUM(requests) AS req, SUM((julianday(finished_at) - julianday(started_at)) * 86400) AS secs FROM sync_log WHERE started_at >= '2026-09-25' GROUP BY d, step");
const byDay = {};
for (const r of steps.results) { const x = (byDay[r.d] ||= { rounds: 0, secs: 0, steps: {} }); x.rounds = Math.max(x.rounds, r.n); x.secs += r.secs; x.steps[r.step] = r.secs; }
out("## Sync rounds by day (max times any step ran), total step seconds");
for (const [d, x] of Object.entries(byDay).sort()) out(`${d} rounds ${x.rounds} step-seconds ${Math.round(x.secs)} slowest: ${Object.entries(x.steps).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, v]) => `${s} ${Math.round(v)}s`).join(", ")}`);
const triggers = await q("SELECT substr(started_at, 1, 10) AS d, trigger, COUNT(DISTINCT run_id) AS runs FROM sync_log WHERE started_at >= '2026-10-01' GROUP BY d, trigger");
out("\n## Runs by day and trigger");
for (const r of triggers.results) out(`${r.d} ${r.trigger} ${r.runs}`);
// 2. Table sizes.
const tables = await q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
out("\n## Tables (rows)");
const sizes = [];
for (const t of tables.results) {
  const r = await q(`SELECT COUNT(*) AS n FROM "${t.name}"`);
  sizes.push([t.name, (r.results[0] || {}).n]);
}
for (const [t, n] of sizes.sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 40)) out(`${t} ${n}`);
const idx = await q("SELECT tbl_name, COUNT(*) AS n FROM sqlite_master WHERE type = 'index' GROUP BY tbl_name ORDER BY n DESC LIMIT 25");
out("\n## Indexes per table");
for (const r of idx.results) out(`${r.tbl_name} ${r.n}`);
// 3. What a round's own checks read: the page summaries' fingerprint.
const { fingerprint } = await import("../workers/sync/src/summaries.js");
const logged = [];
const stmt = (sql, params = []) => ({ bind: (...p) => stmt(sql, p), first: async (c) => { const r = await q(sql, params); logged.push([r.meta.rows_read, sql]); const row = r.results[0] ?? null; return c && row ? row[c] : row; }, all: async () => { const r = await q(sql, params); logged.push([r.meta.rows_read, sql]); return { results: r.results }; } });
await fingerprint({ prepare: (sql) => stmt(sql) });
out("\n## The page summaries' fingerprint (runs every round)");
for (const [n, sql] of logged) out(`${n} rows  ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
// 4. Other states' loads: positions per state.
const sp = await q("SELECT COUNT(*) AS n FROM state_positions");
out(`\nstate_positions ${JSON.stringify(sp.results)}`);
out(`\nRows read by this probe: ${rowsTotal}`);
