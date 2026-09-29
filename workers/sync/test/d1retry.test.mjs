// Unit tests for retrying temporary D1 errors (src/d1retry.js), with a fake
// D1 binding. Run: node workers/sync/test/d1retry.test.mjs
import assert from "node:assert/strict";
import { retryingD1, withD1Retry, isTransient, withRetry } from "../src/d1retry.js";

const noSleep = { sleep: async () => {} };
console.warn = () => {};
let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log(`ok   ${name}`);
};

// A fake D1 whose calls fail with `errors` (in order) before succeeding.
function fakeDb(errors = []) {
  const calls = { run: 0, batch: 0, first: 0 };
  const failNext = (kind) => {
    calls[kind] += 1;
    const e = errors.shift();
    if (e) throw new Error(e);
  };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    run: async () => (failNext("run"), { success: true, sql, args }),
    first: async (col) => (failNext("first"), col ? { [col]: 1 }[col] : { sql, args }),
    all: async () => ({ results: [] }),
    raw: async () => [],
  });
  return { calls, prepare: (sql) => stmt(sql), batch: async (s) => (failNext("batch"), s.map((x) => x.sql)), exec: async () => ({}) };
}

await test("recognizes temporary errors", () => {
  assert.ok(isTransient(new Error("D1_ERROR: Network connection lost.")));
  assert.ok(isTransient(new Error("Internal error in D1 DB storage caused object to be reset.")));
  assert.ok(!isTransient(new Error("D1_ERROR: UNIQUE constraint failed: bills.id")));
  assert.ok(!isTransient(new Error("no such table: bills")));
});

await test("a write retries through temporary errors and succeeds", async () => {
  const raw = fakeDb(["Network connection lost.", "storage caused object to be reset"]);
  const db = retryingD1(raw, noSleep);
  const r = await db.prepare("INSERT INTO x VALUES (?)").bind(7).run();
  assert.deepEqual(r.args, [7]);
  assert.equal(raw.calls.run, 3);
});

await test("a batch retries, passing the unwrapped statements to D1", async () => {
  const raw = fakeDb(["Network connection lost."]);
  const db = retryingD1(raw, noSleep);
  const out = await db.batch([db.prepare("A"), db.prepare("B").bind(1)]);
  assert.deepEqual(out, ["A", "B"]);
  assert.equal(raw.calls.batch, 2);
});

await test("first(column) keeps its argument", async () => {
  const db = retryingD1(fakeDb(["Network connection lost."]), noSleep);
  assert.equal(await db.prepare("SELECT").first("n"), 1);
});

await test("other errors are thrown at once, without retrying", async () => {
  const raw = fakeDb(["UNIQUE constraint failed: bills.id"]);
  const db = retryingD1(raw, noSleep);
  await assert.rejects(db.prepare("INSERT").run(), /UNIQUE/);
  assert.equal(raw.calls.run, 1);
});

await test("gives up after the last attempt and throws the error", async () => {
  const raw = fakeDb(Array(10).fill("Network connection lost."));
  const db = retryingD1(raw, { ...noSleep, attempts: 4 });
  await assert.rejects(db.prepare("INSERT").run(), /Network connection lost/);
  assert.equal(raw.calls.run, 4);
});

await test("backoff doubles between attempts", async () => {
  const waits = [];
  let i = 0;
  await withRetry(
    async () => {
      if (i++ < 3) throw new Error("Network connection lost.");
      return "done";
    },
    { baseMs: 100, sleep: async (ms) => waits.push(ms) }
  );
  assert.equal(waits.length, 3);
  assert.ok(waits[0] >= 75 && waits[0] <= 125 && waits[1] >= 150 && waits[2] >= 300, JSON.stringify(waits));
});

await test("withD1Retry keeps the other bindings and wraps DB once", () => {
  const env = { DB: fakeDb(), SYNC_TOKEN: "t", OTHER: { x: 1 } };
  const e = withD1Retry(env);
  assert.equal(e.SYNC_TOKEN, "t");
  assert.equal(e.OTHER.x, 1);
  assert.ok(e.DB.__retrying);
  assert.equal(withD1Retry(e).DB, e.DB);
});

console.log(`\n${n} passed`);
