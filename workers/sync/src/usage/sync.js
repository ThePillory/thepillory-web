// What the account's Cloudflare usage costs, checked once a day in the sync's last steps
// (docs/data-sync.md, "What Cloudflare costs"):
//   recordStepUsage()  after every step: its D1 rows read and written (usage_steps), and its
//                      most expensive queries' SQL shapes (usage_queries)
//   syncUsageCheck()   the "usage-check" step: the last 35 days from Cloudflare's GraphQL
//                      Analytics API (CF_ANALYTICS_TOKEN, a secret with Account Analytics Read;
//                      CF_ACCOUNT_ID) into usage_daily, priced at Workers Paid rates; without the
//                      token, the D1 rows ThePillory counts itself. One email through ALERT_EMAIL
//                      when the projected month passes USAGE_ALERT_DOLLARS (default 150) or a day
//                      costs more than 3 times the 7 days before it, saying what jumped and where.
import { getState, setState } from "../util.js";
import { fetchUsage, dailyUsage, dayCost } from "./cloudflare.js";
import { alertReasons, jumps } from "./outlook.js";
import { sqlKey } from "./meter.js";
import { mimeMessage } from "../health/check.js";

const STEP_QUERY_ROWS = 10000; // a step's query below this many rows isn't kept by its shape

const missing = (err) => /no such table/i.test(String(err && err.message));

/** After a step: its rows into usage_steps, and its expensive queries into usage_queries. */
export async function recordStepUsage(db, day, step, tally) {
  const stmts = [
    db
      .prepare(
        `INSERT INTO usage_steps (day, step, rounds, rows_read, rows_written) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (day, step) DO UPDATE SET rounds = rounds + 1, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`
      )
      .bind(day, step, tally.rowsRead, tally.rowsWritten),
  ];
  for (const [shape, q] of tally.queries) {
    if (q.rowsRead + q.rowsWritten < STEP_QUERY_ROWS) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO usage_queries (day, source, sql_key, sql, calls, rows_read, rows_written) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (day, source, sql_key) DO UPDATE SET calls = calls + excluded.calls, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`
        )
        .bind(day, step, sqlKey(shape), shape, q.calls, q.rowsRead, q.rowsWritten)
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    if (!missing(err)) console.error(`usage (${step}): ${err && err.message}`);
  }
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** usage_daily rows (from the GraphQL API) in the shape dailyUsage() returns. */
async function storedDays(db, since) {
  const { results } = await db.prepare("SELECT * FROM usage_daily WHERE day >= ? ORDER BY day").bind(since).all();
  return results.map((r) => ({
    day: r.day, workersRequests: r.workers_requests, workersCpuMs: r.workers_cpu_ms, pagesRequests: r.pages_requests,
    d1RowsRead: r.d1_rows_read, d1RowsWritten: r.d1_rows_written, d1StorageGb: r.d1_storage_gb,
    doRequests: r.do_requests, doGbSeconds: r.do_gb_seconds, r2StorageGb: r.r2_storage_gb, r2ClassA: r.r2_class_a, r2ClassB: r.r2_class_b,
    aiNeurons: r.ai_neurons, byScript: JSON.parse(r.by_script || "{}"),
  }));
}

/** Without the analytics token: D1 rows by day from what ThePillory counts itself (pages + sync steps). */
async function ownDays(db, since) {
  const { results } = await db
    .prepare(
      `SELECT day, SUM(r) AS rows_read, SUM(w) AS rows_written FROM (
         SELECT day, rows_read AS r, rows_written AS w FROM usage_steps WHERE day >= ?
         UNION ALL SELECT day, rows_read, rows_written FROM usage_routes WHERE day >= ?)
       GROUP BY day ORDER BY day`
    )
    .bind(since, since)
    .all();
  return results.map((r) => ({ day: r.day, d1RowsRead: r.rows_read, d1RowsWritten: r.rows_written, byScript: {} }));
}

/** Where the rows went on one day: the top routes, steps and queries. */
export async function whereItWent(db, day, n = 5) {
  const q = async (sql) => {
    try {
      return (await db.prepare(sql).bind(day).all()).results;
    } catch (err) {
      if (missing(err)) return [];
      throw err;
    }
  };
  return {
    routes: await q(`SELECT route, SUM(requests) AS requests, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written FROM usage_routes WHERE day = ? GROUP BY route ORDER BY rows_read + rows_written * 1000 DESC LIMIT ${n}`),
    steps: await q(`SELECT step, rounds, rows_read, rows_written FROM usage_steps WHERE day = ? ORDER BY rows_written * 1000 + rows_read DESC LIMIT ${n}`),
    queries: await q(`SELECT source, sql, calls, rows_read, rows_written FROM usage_queries WHERE day = ? ORDER BY rows_written * 1000 + rows_read DESC LIMIT ${n}`),
  };
}

const num = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");

/** The email: what jumped, and on which routes, steps and queries. Pure. */
export function usageEmail({ reasons, outlook, latest, jumped, where, source }) {
  const lines = [
    ...reasons,
    "",
    `Source: ${source}.`,
    "",
    "This month by line (estimated, Workers Paid rates):",
    ...outlook.projected.lines.filter((l) => l.dollars >= 0.01).map((l) => `  ${l.label}: $${l.dollars.toFixed(2)} projected`),
  ];
  if (latest && jumped.length) {
    lines.push("", `What jumped on ${latest.day} (against the 7 days before):`);
    for (const j of jumped) lines.push(`  ${j.label}: ${num(j.today)} (average ${num(j.avg)}), about $${j.dollars.toFixed(2)} that day`);
  }
  if (where.routes.length) {
    lines.push("", "Pages that read the most D1 rows that day:");
    for (const r of where.routes) lines.push(`  ${r.route}: ${num(r.requests)} requests, ${num(r.rows_read)} rows read, ${num(r.rows_written)} written`);
  }
  if (where.steps.length) {
    lines.push("", "Sync steps:");
    for (const s of where.steps) lines.push(`  ${s.step}: ${num(s.rounds)} rounds, ${num(s.rows_read)} rows read, ${num(s.rows_written)} written`);
  }
  if (where.queries.length) {
    lines.push("", "Queries (SQL only, no values):");
    for (const q of where.queries) lines.push(`  [${q.source}] ${num(q.rows_read)} read, ${num(q.rows_written)} written, ${num(q.calls)} calls: ${q.sql.slice(0, 200)}`);
  }
  lines.push("", "Details: https://thepillory.co/admin/usage/");
  return { subject: `ThePillory: Cloudflare usage ${reasons.length > 1 ? "is high" : /projected/.test(reasons[0] || "") ? "projected over the alert line" : "jumped"}`, body: lines.join("\n") };
}

async function send(env, msg) {
  if (!env.ALERT_EMAIL) return "not sent: the ALERT_EMAIL binding isn't set up";
  const from = env.ALERT_FROM || "data-health@thepillory.co";
  const to = env.ALERT_TO;
  if (!to) return "not sent: ALERT_TO isn't set";
  try {
    const { EmailMessage } = await import("cloudflare:email");
    await env.ALERT_EMAIL.send(new EmailMessage(from, to, mimeMessage({ from, to, subject: msg.subject, body: msg.body })));
    return `sent to ${to}`;
  } catch (err) {
    // A failed email doesn't fail the check; the step's message says so.
    return `not sent: ${err && err.message}`;
  }
}

/** The sync step. */
export async function syncUsageCheck(env, db) {
  const today = iso(Date.now());
  if ((await getState(db, "usage_check_done")) === today) return { status: "skipped", message: "already checked today" };
  try {
    await db.prepare("SELECT 1 FROM usage_daily LIMIT 1").all();
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "migration 0046 not applied yet" };
    throw err;
  }
  const since = iso(Date.now() - 35 * 86400000);
  let days;
  let source;
  const token = env.CF_ANALYTICS_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  let note = "";
  if (token && account) {
    const data = await fetchUsage({ accountId: account, token, since, until: today });
    const failed = Object.entries(data).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => `${k}: ${v.error}`);
    days = dailyUsage(data);
    if (failed.length) note = ` Not read: ${failed.join("; ").slice(0, 300)}.`;
    const now = new Date().toISOString();
    const stmts = days.map((d) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO usage_daily (day, workers_requests, workers_cpu_ms, pages_requests, d1_rows_read, d1_rows_written, d1_storage_gb,
             do_requests, do_gb_seconds, r2_storage_gb, r2_class_a, r2_class_b, ai_neurons, cost_usd, by_script, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(d.day, d.workersRequests, d.workersCpuMs, d.pagesRequests, d.d1RowsRead, d.d1RowsWritten, d.d1StorageGb, d.doRequests, d.doGbSeconds, d.r2StorageGb, d.r2ClassA, d.r2ClassB, d.aiNeurons, dayCost(d), JSON.stringify(d.byScript), now)
    );
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    if (!days.length) days = await storedDays(db, since);
    source = "Cloudflare's GraphQL Analytics API";
  } else {
    days = await ownDays(db, since);
    source = "D1 rows counted inside ThePillory (pages and sync steps); Workers, Durable Object and R2 usage need CF_ANALYTICS_TOKEN";
    note = " CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID isn't set: D1 only, from ThePillory's own counts.";
  }
  const limit = Number(env.USAGE_ALERT_DOLLARS) || 150;
  const { reasons, outlook, latest } = alertReasons(days, today, limit);
  let sent = "";
  if (reasons.length && (await getState(db, "usage_alert_day")) !== today) {
    const where = latest ? await whereItWent(db, latest.day) : { routes: [], steps: [], queries: [] };
    sent = ` Alert: ${await send(env, usageEmail({ reasons, outlook, latest, jumped: latest ? jumps(days, latest.day) : [], where, source }))}.`;
    await setState(db, "usage_alert_day", today);
  }
  await setState(db, "usage_check_done", today);
  return {
    status: "ok",
    message: `${days.length} days; ${outlook.month} so far $${outlook.soFar.total.toFixed(2)}, projected $${outlook.projected.total.toFixed(2)} (alert line $${limit}).${reasons.length ? ` ${reasons.join(" ")}` : ""}${sent}${note}`,
  };
}
