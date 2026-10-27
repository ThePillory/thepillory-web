// node --test workers/sync/test/ai-usage.test.mjs
// What AI calls cost (src/ai-usage.js): the price of a call, and the running
// total by day, step and model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dollarsFor, centsFor, setStep, recordUsage } from "../src/ai-usage.js";

test("the price of a call: input, output, cache reads and writes, by model", () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 1e6 };
  assert.equal(dollarsFor("claude-sonnet-5-5", usage), 2 + 10 + 0.2 + 2.5);
  assert.equal(dollarsFor("claude-haiku-4-5-20251001", usage), 1 + 5 + 0.1 + 1.25, "a dated model id is priced as its family");
  assert.equal(dollarsFor("claude-opus-5-5", usage), 4 + 20 + 0.2 + 5, "Opus 5.5 reads cache at a twentieth");
  assert.equal(dollarsFor("unknown-model", { output_tokens: 1e6 }), 20, "unknown: the Opus price");
  assert.equal(centsFor("claude-haiku-4-5", { input_tokens: 1e6 }), 100);
});

// D1's prepare/bind/run over Node's SQLite.
function d1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../migrations/0045_ai_usage.sql", import.meta.url), "utf8"));
  return {
    sql,
    prepare(q) {
      let args = [];
      return { bind(...a) { args = a; return this; }, run: async () => sql.prepare(q).run(...args) };
    },
  };
}

test("each call adds to today's row for the step running and the model", async () => {
  const db = d1();
  setStep("plain-summaries");
  await recordUsage(db, "claude-haiku-4-5", { input_tokens: 1000, output_tokens: 200 });
  await recordUsage(db, "claude-haiku-4-5", { input_tokens: 3000, output_tokens: 100, cache_read_tokens: 500 });
  setStep("analysis-bills");
  await recordUsage(db, "claude-sonnet-5-5", { input_tokens: 10000, output_tokens: 2000 });
  const rows = db.sql.prepare("SELECT step, model, calls, input_tokens, output_tokens, cache_read_tokens, cost_usd FROM ai_usage ORDER BY step").all();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[1], cost_usd: undefined }, { step: "plain-summaries", model: "claude-haiku-4-5", calls: 2, input_tokens: 4000, output_tokens: 300, cache_read_tokens: 500, cost_usd: undefined });
  assert.ok(Math.abs(rows[1].cost_usd - (4000 * 1 + 300 * 5 + 500 * 0.1) / 1e6) < 1e-12);
  assert.equal(rows[0].step, "analysis-bills");
  // No table yet (before migration 0045): reported, never fatal to the call.
  await recordUsage({ prepare() { throw new Error("no such table: ai_usage"); } }, "claude-haiku-4-5", { input_tokens: 1 });
  setStep(null);
});
