// Retry D1 calls that fail with a temporary error ("Network connection lost",
// "... caused object to be reset", and similar), with exponential backoff.
// Any other error is thrown at once. Wraps the binding, so every query and
// batch made through it retries; callers don't change.
//
// A write that failed this way may or may not have been applied, so the sync's
// writes are safe to repeat: upserts, "INSERT OR IGNORE", and "mark every
// current draft of this bill old" before inserting a new one. At worst a
// repeat adds a duplicate log or history row.

const TRANSIENT = [
  /network connection lost/i,
  /object to be reset/i,
  /reset because its code was updated/i,
  /transient issue/i,
  /D1 DB is overloaded/i,
  /too many requests queued/i,
  /internal error/i,
];

// D1 saying it's overloaded ("D1 DB is overloaded. Requests queued for too long.") needs longer
// than a dropped connection: the queue drains in tens of seconds, so these wait longer between tries.
const OVERLOADED = [/queued for too long/i, /too many requests queued/i];
export const OVERLOAD_RETRY = { attempts: 8, baseMs: 2000, maxMs: 30000 }; // about 2 minutes in all

export function isOverloaded(err) {
  const msg = String((err && (err.message || err)) || "");
  return !TOO_HEAVY.test(msg) && (OVERLOADED.some((re) => re.test(msg)) || /D1 DB is overloaded/i.test(msg));
}

// "D1 DB is overloaded. Too many resources consumed within a 10 second window." is one query
// costing too much, not a busy queue: the same query fails the same way however long we wait, so
// it isn't retried (page-summaries hit it every day from Nov 12, 2026). The query has to change.
export const TOO_HEAVY = /too many resources consumed/i;

export function isTransient(err) {
  const msg = String((err && (err.message || err)) || "");
  if (TOO_HEAVY.test(msg)) return false;
  return TRANSIENT.some((re) => re.test(msg));
}

export async function withRetry(fn, { attempts = 5, baseMs = 250, maxMs = 8000, label = "D1", sleep, overload = OVERLOAD_RETRY } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const busy = isOverloaded(err);
      const max = busy ? Math.max(attempts, overload.attempts) : attempts;
      if (i >= max || !isTransient(err)) throw err;
      const ms = busy
        ? Math.min(overload.maxMs, overload.baseMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5)
        : Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5);
      console.warn(`${label}: temporary error (${err.message}); retry ${i} of ${max - 1} in ${Math.round(ms)} ms`);
      await wait(ms);
    }
  }
}

function statement(stmt, opts) {
  return {
    __stmt: stmt,
    bind: (...args) => statement(stmt.bind(...args), opts),
    run: () => withRetry(() => stmt.run(), opts),
    all: () => withRetry(() => stmt.all(), opts),
    first: (col) => withRetry(() => (col === undefined ? stmt.first() : stmt.first(col)), opts),
    raw: (o) => withRetry(() => stmt.raw(o), opts),
  };
}

/** A D1 binding whose queries and batches retry on temporary errors. */
export function retryingD1(db, opts = {}) {
  if (!db || db.__retrying) return db;
  return {
    __retrying: true,
    prepare: (sql) => statement(db.prepare(sql), opts),
    batch: (stmts) => withRetry(() => db.batch(stmts.map((s) => (s && s.__stmt) || s)), opts),
    exec: (sql) => withRetry(() => db.exec(sql), opts),
  };
}

/** The same env, with DB wrapped. Other bindings and vars are untouched. */
export function withD1Retry(env) {
  if (!env || !env.DB || env.DB.__retrying) return env;
  return Object.create(env, { DB: { value: retryingD1(env.DB), enumerable: true } });
}
