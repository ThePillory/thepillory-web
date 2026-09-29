// Sync Worker entry point.
//
//   scheduled  — the daily Cron Trigger (see wrangler.toml) runs every step.
//   GET/POST /run?token=…     run the sync now (same steps, shorter time limit).
//   GET      /status?token=…  the latest log rows, as JSON.
//
// The token is the SYNC_TOKEN secret. Both routes refuse to run without it.
import { ensureSchema, log } from "./db.js";
import { Budget, redact } from "./util.js";
import { syncCounty } from "./county.js";
import { syncStateOfficials, syncStateVotes } from "./openstates.js";
import { syncFederalOfficials, syncHouseVotes } from "./congress.js";
import { syncSenateVotes } from "./senate.js";

// Order matters: officials before votes; state officials first because the
// Open States lookup also detects the U.S. House district.
const STEPS = [
  ["county-officials", syncCounty],
  ["state-officials", syncStateOfficials],
  ["federal-officials", syncFederalOfficials],
  ["house-votes", syncHouseVotes],
  ["senate-votes", syncSenateVotes],
  ["state-votes", syncStateVotes],
];

export async function runSync(env, { trigger, deadlineMs }) {
  if (!env.DB) throw new Error("D1 binding DB is missing (see wrangler.toml)");
  await ensureSchema(env.DB);
  const run = { id: crypto.randomUUID(), trigger };
  const budget = new Budget(env, deadlineMs);
  const summary = [];
  for (const [step, fn] of STEPS) {
    const started = new Date().toISOString();
    const before = budget.used;
    let result;
    try {
      result = await fn(env, env.DB, budget);
    } catch (err) {
      // Logged, never swallowed: one failing source doesn't stop the others.
      result = { status: "error", message: redact(`${err.name}: ${err.message}`) };
      console.error(`[${run.id}] ${step}: ${result.message}`);
    }
    await log(env.DB, run, step, result.status, budget.used - before, result.message, started);
    summary.push({ step, ...result, requests: budget.used - before });
  }
  return { run_id: run.id, trigger, requests_used: budget.used, steps: summary };
}

async function authorized(request, env) {
  const url = new URL(request.url);
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") || "";
  const expected = env.SYNC_TOKEN || "";
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async scheduled(event, env, ctx) {
    // Cron runs may use up to ~15 minutes of wall time; stop cleanly before that.
    const result = await runSync(env, { trigger: "cron", deadlineMs: 13 * 60 * 1000 });
    console.log(JSON.stringify(result));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/run" && pathname !== "/status") {
      return json({ ok: true, routes: ["/run?token=…", "/status?token=…"] });
    }
    if (!(await authorized(request, env))) return json({ error: "unauthorized: pass ?token= or Authorization: Bearer" }, 401);

    if (pathname === "/status") {
      await ensureSchema(env.DB);
      const { results } = await env.DB.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 30").all();
      const counts = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM officials WHERE active = 1) AS officials, (SELECT COUNT(*) FROM bills) AS bills, " +
          "(SELECT COUNT(*) FROM votes) AS votes, (SELECT COUNT(*) FROM vote_positions) AS positions"
      ).first();
      return json({ counts, recent: results });
    }

    // Manual run: a shorter time limit, so the response comes back in time.
    // Run it again to continue a backfill; each run picks up where the last stopped.
    try {
      const result = await runSync(env, { trigger: "manual", deadlineMs: 80 * 1000 });
      const more = result.steps.some((s) => s.step.endsWith("-votes") && s.status === "partial");
      return json({ ...result, more_to_do: more, hint: more ? "Run again to continue." : "Up to date." });
    } catch (err) {
      return json({ error: redact(`${err.name}: ${err.message}`) }, 500);
    }
  },
};
