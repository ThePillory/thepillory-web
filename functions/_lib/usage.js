// What each kind of page costs in D1, recorded per day (docs/data-sync.md, "What Cloudflare costs").
//   startUsage()   functions/_middleware.js, at the start of every request: a tally, the route
//                  pattern ("/reps/:id/") and who it's from (person, likely bot, verified bot)
//   usageEnv()     guard(): the page's env with DB counted into that tally
//   finishUsage()  the middleware, when the response is ready: added to this isolate's totals,
//                  written to usage_routes and usage_queries every few minutes in one batch
// Nothing about a visitor is kept: the route pattern, never the URL or query string; the SQL's
// shape, never its values; the kind of visitor, never an address or user agent. Totals still in
// memory when an isolate is recycled are lost, so the numbers are a floor, not an exact count.
import { newTally, meteredEnv, meterD1, routePattern, visitorKind, sqlKey } from "../../workers/sync/src/usage/meter.js";

const FLUSH_MS = 5 * 60 * 1000;
const FLUSH_REQUESTS = 500;
const MIN_QUERY_ROWS = 1000; // a query's rows this flush below this are summed into one "(smaller queries)" line

const routes = new Map();
const queries = new Map();
let pending = 0;
let lastFlush = Date.now();
let off = false; // the tables aren't there yet (before the sync's migration 0046): stop trying in this isolate

/** At the start of a request: the tally its pages and the middleware add to. */
export function startUsage(context) {
  const tally = newTally();
  const u = { tally, route: routePattern(new URL(context.request.url).pathname), visitor: visitorKind(context.request) };
  if (context.data && typeof context.data === "object") context.data.usage = u;
  return u;
}

/** The env a page gets: DB counted into this request's tally (when the middleware started one). */
export function usageEnv(context) {
  const u = context && context.data && context.data.usage;
  return u ? meteredEnv(context.env, u.tally) : context.env;
}

/** The middleware's own D1 binding, counted into the same tally. */
export function usageDb(context) {
  const u = context && context.data && context.data.usage;
  return u && context.env.DB ? meterD1(context.env.DB, u.tally) : context.env.DB;
}

/** When the response is ready: into this isolate's totals, and written out every few minutes. */
export function finishUsage(context, u) {
  if (!u || off) return;
  const day = new Date().toISOString().slice(0, 10);
  const rk = `${day}|${u.route}|${u.visitor}`;
  const r = routes.get(rk) || { day, route: u.route, visitor: u.visitor, requests: 0, rowsRead: 0, rowsWritten: 0 };
  r.requests++;
  r.rowsRead += u.tally.rowsRead;
  r.rowsWritten += u.tally.rowsWritten;
  routes.set(rk, r);
  for (const [shape, q] of u.tally.queries) {
    const qk = `${day}|${shape}`;
    const t = queries.get(qk) || { day, shape, calls: 0, rowsRead: 0, rowsWritten: 0 };
    t.calls += q.calls;
    t.rowsRead += q.rowsRead;
    t.rowsWritten += q.rowsWritten;
    queries.set(qk, t);
  }
  pending++;
  if (context.env.DB && (pending >= FLUSH_REQUESTS || Date.now() - lastFlush >= FLUSH_MS)) {
    const p = flush(context.env.DB);
    if (context.waitUntil) context.waitUntil(p);
  }
}

/** This isolate's totals, written in one batch (upserts that add to the day's rows). */
export async function flush(db) {
  const rs = [...routes.values()];
  const all = [...queries.values()];
  routes.clear();
  queries.clear();
  pending = 0;
  lastFlush = Date.now();
  if (!rs.length && !all.length) return;
  const big = all.filter((q) => q.rowsRead + q.rowsWritten >= MIN_QUERY_ROWS);
  const small = new Map();
  for (const q of all) {
    if (q.rowsRead + q.rowsWritten >= MIN_QUERY_ROWS) continue;
    const s = small.get(q.day) || { day: q.day, shape: "(smaller queries)", calls: 0, rowsRead: 0, rowsWritten: 0 };
    s.calls += q.calls;
    s.rowsRead += q.rowsRead;
    s.rowsWritten += q.rowsWritten;
    small.set(q.day, s);
  }
  const stmts = [
    ...rs.map((r) =>
      db
        .prepare(
          `INSERT INTO usage_routes (day, route, visitor, requests, rows_read, rows_written) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (day, route, visitor) DO UPDATE SET requests = requests + excluded.requests, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`
        )
        .bind(r.day, r.route, r.visitor, r.requests, r.rowsRead, r.rowsWritten)
    ),
    ...[...big, ...small.values()].map((q) =>
      db
        .prepare(
          `INSERT INTO usage_queries (day, source, sql_key, sql, calls, rows_read, rows_written) VALUES (?, 'pages', ?, ?, ?, ?, ?)
           ON CONFLICT (day, source, sql_key) DO UPDATE SET calls = calls + excluded.calls, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`
        )
        .bind(q.day, sqlKey(q.shape), q.shape, q.calls, q.rowsRead, q.rowsWritten)
    ),
  ];
  try {
    await db.batch(stmts);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) off = true;
    else console.error(`usage: ${err && err.message}`);
  }
}
