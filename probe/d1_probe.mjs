// TEMPORARY (removed before merge): read-only, how often the page summaries were rebuilt.
const DB_ID = "b6afd5de-4804-4c2b-bb14-af4314190e9d";
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
async function q(sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
  const b = await res.json();
  return b.success ? b.result[0].results : b.errors;
}
const rows = await q("SELECT substr(started_at, 1, 10) AS d, SUM(status = 'ok') AS builds, COUNT(*) AS runs FROM sync_log WHERE step = 'page-summaries' AND started_at >= '2026-09-29' GROUP BY d ORDER BY d");
let total = 0;
for (const r of rows) { total += r.builds; console.log(`${r.d} builds ${r.builds} of ${r.runs}`); }
console.log(`total builds since 2026-09-29: ${total}`);
const sample = await q("SELECT started_at, message FROM sync_log WHERE step = 'page-summaries' AND status = 'ok' ORDER BY id DESC LIMIT 3");
console.log(JSON.stringify(sample));
const big = await q("SELECT step, COUNT(*) AS n FROM sync_log WHERE started_at >= '2026-10-01' AND status IN ('ok','partial') GROUP BY step ORDER BY n DESC LIMIT 12");
console.log(JSON.stringify(big));
