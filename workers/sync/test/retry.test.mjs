// node workers/sync/test/retry.test.mjs
// Temporary errors are retried with backoff (src/util.js Budget.fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Budget, UpstreamError, isTemporary, retryAfterMs, backoffMs } from "../src/util.js";

function budget(responses, env = {}) {
  const b = new Budget({ MAX_SUBREQUESTS: "100", ...env }, 10 * 60 * 1000);
  const waits = [];
  const calls = [];
  b.sleep = async (ms) => waits.push(ms);
  b.fetchImpl = async (url) => {
    calls.push(url);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body || "", { status: r.status, headers: r.headers || {} });
  };
  return { b, waits, calls };
}

test("a 429 with Retry-After is retried after that wait, then succeeds", async () => {
  const { b, waits, calls } = budget([{ status: 429, headers: { "Retry-After": "7" } }, { status: 200, body: "ok" }]);
  const res = await b.fetch("https://example.org/a", {}, "test");
  assert.equal(await res.text(), "ok");
  assert.deepEqual(waits, [7000]);
  assert.equal(calls.length, 2);
  assert.equal(b.retries, 1);
});

test("a 524 is retried with growing backoff, then given up after FETCH_RETRIES", async () => {
  const { b, waits, calls } = budget([{ status: 524 }, { status: 524 }, { status: 524 }, { status: 524 }]);
  await assert.rejects(b.fetch("https://example.org/b", {}, "test"), (e) => e instanceof UpstreamError && e.status === 524 && isTemporary(e));
  assert.equal(calls.length, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] >= 1500 && waits[0] <= 2500 && waits[1] > waits[0] && waits[2] > waits[1], JSON.stringify(waits));
});

test("a network failure is retried; a 404 isn't", async () => {
  const net = budget([new TypeError("fetch failed: network connection lost"), { status: 200, body: "ok" }]);
  assert.equal(await (await net.b.fetch("https://example.org/c", {}, "t")).text(), "ok");
  assert.equal(net.calls.length, 2);
  const nf = budget([{ status: 404 }, { status: 200 }]);
  await assert.rejects(nf.b.fetch("https://example.org/d", {}, "t"), (e) => e.status === 404 && !isTemporary(e));
  assert.equal(nf.calls.length, 1);
});

test("a Retry-After longer than the cap isn't waited for", async () => {
  const { b, waits, calls } = budget([{ status: 429, headers: { "Retry-After": "3600" } }, { status: 200 }]);
  await assert.rejects(b.fetch("https://example.org/e", {}, "t"), (e) => e.status === 429);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("helpers", () => {
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs(new Date(Date.now() + 10000).toUTCString(), Date.now()) > 8000, true);
  assert.equal(retryAfterMs(null), null);
  assert.equal(backoffMs(1, null, { random: () => 0.5 }), 2000);
  assert.equal(backoffMs(3, null, { random: () => 0.5 }), 18000);
  assert.equal(backoffMs(2, 1234), 1234);
  for (const s of [429, 500, 502, 503, 504, 520, 522, 524]) assert.ok(isTemporary(new UpstreamError("u", s, "")), String(s));
  for (const s of [400, 401, 403, 404, 410]) assert.ok(!isTemporary(new UpstreamError("u", s, "")), String(s));
});
