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

export function isTransient(err) {
  const msg = String((err && (err.message || err)) || "");
  return TRANSIENT.some((re) => re.test(msg));
}

export async function withRetry(fn, { attempts = 5, baseMs = 250, maxMs = 8000, label = "D1", sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      const ms = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5);
      console.warn(`${label}: temporary error (${err.message}); retry ${i} of ${attempts - 1} in ${Math.round(ms)} ms`);
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
