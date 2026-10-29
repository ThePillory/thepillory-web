// /admin/usage/ (behind Cloudflare Access, like /admin/health/): what Cloudflare usage costs and
// what drives it (docs/data-sync.md, "What Cloudflare costs").
//   - the estimated cost this month so far and the projected month total, line by line;
//   - by day: D1 rows read and written, requests, CPU, Durable Object time, R2;
//   - the pages (route patterns) and sync steps that read and write the most D1 rows, the
//     share from people, likely bots and verified bots, and the 20 most expensive queries
//     (SQL only, no values);
//   - beside it, the AI cost from ai_usage, "Billed by Anthropic, not Cloudflare".
// Numbers come from usage_daily (Cloudflare's GraphQL Analytics API, written by the sync's
// usage-check step) or, before CF_ANALYTICS_TOKEN is set, from the D1 rows ThePillory counts itself.
import { esc } from "./render.js";
import { monthOutlook } from "../../workers/sync/src/usage/outlook.js";
import { dayCost } from "../../workers/sync/src/usage/cloudflare.js";

const DAYS = 35;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

async function rows(db, sql, binds = []) {
  try {
    return (await db.prepare(sql).bind(...binds).all()).results;
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

export async function usageData(db) {
  const since = iso(Date.now() - DAYS * 86400000);
  const week = iso(Date.now() - 7 * 86400000);
  const [daily, own, routes, visitors, steps, queries, ai] = await Promise.all([
    rows(db, "SELECT * FROM usage_daily WHERE day >= ? ORDER BY day", [since]),
    rows(db, `SELECT day, SUM(r) AS rows_read, SUM(w) AS rows_written, SUM(q) AS requests FROM (
                SELECT day, rows_read AS r, rows_written AS w, 0 AS q FROM usage_steps WHERE day >= ?
                UNION ALL SELECT day, rows_read, rows_written, requests FROM usage_routes WHERE day >= ?) GROUP BY day ORDER BY day`, [since, since]),
    rows(db, `SELECT route, SUM(requests) AS requests, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written,
                SUM(CASE WHEN visitor = 'person' THEN requests ELSE 0 END) AS people,
                SUM(CASE WHEN visitor != 'person' THEN requests ELSE 0 END) AS bots
              FROM usage_routes WHERE day >= ? GROUP BY route ORDER BY rows_read DESC LIMIT 25`, [week]),
    rows(db, "SELECT visitor, SUM(requests) AS requests, SUM(rows_read) AS rows_read FROM usage_routes WHERE day >= ? GROUP BY visitor", [week]),
    rows(db, "SELECT step, SUM(rounds) AS rounds, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written FROM usage_steps WHERE day >= ? GROUP BY step ORDER BY rows_written * 1000 + rows_read DESC LIMIT 25", [week]),
    rows(db, "SELECT source, sql, SUM(calls) AS calls, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written FROM usage_queries WHERE day >= ? GROUP BY source, sql_key ORDER BY rows_written * 1000 + rows_read DESC LIMIT 20", [week]),
    rows(db, "SELECT day, SUM(calls) AS calls, SUM(cost_usd) AS cost FROM ai_usage WHERE day >= ? GROUP BY day ORDER BY day", [since]),
  ]);
  return { daily, own, routes, visitors, steps, queries, ai, since, week };
}

const num = (v, d = 0) => (v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }));
const usd = (v) => `$${(Number(v) || 0).toFixed(2)}`;
const table = (head, body) =>
  `<div class="table-scroll"><table class="usage-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
const tr = (cells) => `<tr>${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`;

function asDays(daily) {
  return daily.map((r) => ({
    day: r.day, workersRequests: r.workers_requests, workersCpuMs: r.workers_cpu_ms, pagesRequests: r.pages_requests,
    d1RowsRead: r.d1_rows_read, d1RowsWritten: r.d1_rows_written, d1StorageGb: r.d1_storage_gb, doRequests: r.do_requests,
    doGbSeconds: r.do_gb_seconds, r2StorageGb: r.r2_storage_gb, r2ClassA: r.r2_class_a, r2ClassB: r.r2_class_b, aiNeurons: r.ai_neurons,
  }));
}

export function adminUsageMain(data) {
  const head = '<header class="page-head"><p class="label">Admin</p><h1>Cloudflare usage</h1>';
  if (!data.daily && !data.own) return `${head}</header><p class="secondary small">The usage tables aren't there yet: the sync creates them (migration 0046) on its next run.</p>`;
  const fromApi = data.daily && data.daily.length;
  const days = fromApi ? asDays(data.daily) : (data.own || []).map((r) => ({ day: r.day, d1RowsRead: r.rows_read, d1RowsWritten: r.rows_written }));
  const today = iso(Date.now());
  const o = monthOutlook(days, today);
  const source = fromApi
    ? "From Cloudflare's GraphQL Analytics API, read once a day by the sync's usage-check step, priced at Workers Paid rates after the included amounts. Cloudflare's invoice is the final word (its month starts on the subscription's renewal day)."
    : "CF_ANALYTICS_TOKEN isn't set, so this is D1 only, from the rows ThePillory counts itself (pages and sync steps): Workers requests, CPU, Durable Objects and R2 appear once the token is set (docs/data-sync.md).";
  const summary = `<section class="card stack-sm" id="month">
  <h2 class="h3">${esc(o.month)}: ${usd(o.soFar.total)} so far, about ${usd(o.projected.total)} projected</h2>
  ${table(["Line", "Projected use", "Included", "Projected $"], o.projected.lines.map((l) => tr([esc(l.label), l.used == null ? "—" : `${num(l.used, 2)} ${esc(l.unit || "")}`, l.included == null ? "—" : num(l.included), usd(l.dollars)])))}
  <p class="hint">${esc(source)} ${o.counted} of ${o.inMonth} days counted.</p>
</section>`;
  const byDay = `<section class="card stack-sm" id="by-day">
  <h2 class="h3">By day</h2>
  ${table(
    fromApi ? ["Day", "Est. $", "D1 rows read", "D1 rows written", "Requests", "CPU ms", "DO GB-s", "R2 A / B"] : ["Day", "D1 rows read", "D1 rows written", "Page requests"],
    [...(fromApi ? data.daily : data.own || [])].reverse().map((r) =>
      fromApi
        ? tr([esc(r.day), usd(r.cost_usd ?? dayCost(asDays([r])[0])), num(r.d1_rows_read), num(r.d1_rows_written), num((r.workers_requests || 0) + (r.pages_requests || 0)), num(r.workers_cpu_ms), num(r.do_gb_seconds), `${num(r.r2_class_a)} / ${num(r.r2_class_b)}`])
        : tr([esc(r.day), num(r.rows_read), num(r.rows_written), num(r.requests)])
    )
  )}
  <p class="hint">Est. $ is that day's use at the marginal rates, before the month's included amounts.</p>
</section>`;
  const visitors = data.visitors || [];
  const vTotal = visitors.reduce((a, v) => ({ requests: a.requests + v.requests, rows_read: a.rows_read + v.rows_read }), { requests: 0, rows_read: 0 });
  const share = (v, k) => (vTotal[k] ? `${Math.round((100 * v[k]) / vTotal[k])}%` : "—");
  const LABEL = { person: "People", "likely-bot": "Likely bots", "verified-bot": "Verified bots" };
  const who = `<section class="card stack-sm" id="visitors">
  <h2 class="h3">Who the requests come from (the last 7 days)</h2>
  ${visitors.length ? table(["", "Requests", "Share", "D1 rows read", "Share"], ["person", "likely-bot", "verified-bot"].map((k) => visitors.find((v) => v.visitor === k) || { visitor: k, requests: 0, rows_read: 0 }).map((v) => tr([LABEL[v.visitor], num(v.requests), share(v, "requests"), num(v.rows_read), share(v, "rows_read")]))) : '<p class="small secondary">Nothing recorded yet.</p>'}
  <p class="hint">Verified bots: Cloudflare's verified bot signal. Likely bots: a bot score under 30 where Cloudflare gives one, or a user agent that says it's automated (or none). Nothing about a visitor is kept but this label.</p>
</section>`;
  const routes = `<section class="card stack-sm" id="routes">
  <h2 class="h3">Pages that read the most D1 rows (the last 7 days)</h2>
  ${(data.routes || []).length ? table(["Route", "Requests", "Rows read", "Rows read per request", "Bots"], data.routes.map((r) => tr([esc(r.route), num(r.requests), num(r.rows_read), num(r.requests ? r.rows_read / r.requests : 0), r.requests ? `${Math.round((100 * r.bots) / r.requests)}%` : "—"]))) : '<p class="small secondary">Nothing recorded yet.</p>'}
  <p class="hint">By route pattern (":id" for a slug or id), never the address or query string. Edge-cached visits count as requests with no rows. Counted in each server process and written every few minutes, so this is a floor.</p>
</section>`;
  const steps = `<section class="card stack-sm" id="steps">
  <h2 class="h3">Sync steps (the last 7 days)</h2>
  ${(data.steps || []).length ? table(["Step", "Rounds", "Rows read", "Rows written"], data.steps.map((s) => tr([esc(s.step), num(s.rounds), num(s.rows_read), num(s.rows_written)]))) : '<p class="small secondary">Nothing recorded yet.</p>'}
  <p class="hint">Rows written cost a thousand times rows read ($1.00 against $0.001 per million), so steps are sorted by writes first.</p>
</section>`;
  const queries = `<section class="card stack-sm" id="queries">
  <h2 class="h3">The 20 most expensive queries (the last 7 days)</h2>
  ${(data.queries || []).length ? `<ol class="plain-list stack-xs small">${data.queries.map((q) => `<li><p class="small"><strong>${esc(q.source)}</strong> · ${num(q.calls)} calls · ${num(q.rows_read)} rows read · ${num(q.rows_written)} written</p><p class="small secondary">${esc(q.sql)}</p></li>`).join("")}</ol>` : '<p class="small secondary">Nothing recorded yet.</p>'}
  <p class="hint">The SQL's shape only: values are never recorded.</p>
</section>`;
  const aiRows = data.ai || [];
  const ai = `<section class="card stack-sm" id="ai">
  <h2 class="h3">AI cost, beside it: billed by Anthropic, not Cloudflare</h2>
  ${aiRows.length ? table(["Day", "Calls", "Cost"], [...aiRows].reverse().map((r) => tr([esc(r.day), num(r.calls), usd(r.cost)]))) : '<p class="small secondary">No AI calls recorded.</p>'}
  <p class="hint">From ai_usage, at list price: every AI call the sync makes. Not part of the Cloudflare estimate above.</p>
</section>`;
  return `${head}<p class="subtitle">${esc(o.month)}: about ${usd(o.projected.total)} projected</p></header>
${summary}${byDay}${who}${routes}${steps}${queries}${ai}`;
}
