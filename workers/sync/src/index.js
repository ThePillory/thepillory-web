// Sync Worker entry point.
//
//   scheduled                 the daily Cron Trigger (see wrangler.toml) starts a run.
//   GET/POST /run?token=…     starts a run and answers immediately with "started".
//   GET/POST /analyze?token=… starts only the constitutional-analysis step (see src/analysis/).
//   GET      /status?token=…  progress of the current or last run, row counts, and recent log rows.
//
// The token is the SYNC_TOKEN secret. Both routes refuse to run without it.
//
// Runs happen in the background, inside a Durable Object (SyncRunner), because a
// Worker can only keep working ~30 seconds after it responds. The Durable Object
// works in rounds (each up to ~12 minutes, via its alarm), keeps going on its own
// while a round stops at the request/time budget, and never runs two syncs at once.
// After the sync rounds, it drafts constitutional analyses for new bills, also
// in rounds, capped per day (ANALYSIS_DAILY_LIMIT).
import { DurableObject } from "cloudflare:workers";
import { ensureSchema, log } from "./db.js";
import { Budget, redact } from "./util.js";
import { syncCounty } from "./county.js";
import { syncStateOfficials, syncStateVotes } from "./openstates.js";
import { syncFederalOfficials, syncHouseVotes } from "./congress.js";
import { syncSenateVotes } from "./senate.js";
import { runAnalysis } from "./analysis/index.js";
import { withD1Retry } from "./d1retry.js";

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

const ROUND_MS = 12 * 60 * 1000; // stop starting new requests after this; the alarm limit is 15 minutes
const MAX_ROUNDS = 20; // safety cap on automatic continuation per run
const MAX_ANALYSIS_ROUNDS = 10; // same, for the analysis step
const STALE_MS = 20 * 60 * 1000; // a round that hasn't finished after this is treated as dead

export async function runSync(rawEnv, { trigger, deadlineMs, runId }) {
  if (!rawEnv.DB) throw new Error("D1 binding DB is missing (see wrangler.toml)");
  const env = withD1Retry(rawEnv); // temporary D1 errors are retried (src/d1retry.js)
  await ensureSchema(env.DB);
  const run = { id: runId || crypto.randomUUID(), trigger };
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
  const partialVotes = summary.filter((s) => s.step.endsWith("-votes") && s.status === "partial");
  return {
    run_id: run.id,
    trigger,
    requests_used: budget.used,
    steps: summary,
    more_to_do: partialVotes.length > 0,
    // Worth another round now only if a step stopped at this round's request or time
    // budget. A daily limit (Open States) resets tomorrow; the daily cron picks it up.
    continue_now: partialVotes.some((s) => /request budget used up|run time limit reached/.test(s.message || "")),
  };
}

function roundSummary(result, round, startedAt) {
  return {
    round,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    requests: result.requests_used,
    steps: result.steps.map((s) => ({ step: s.step, status: s.status, requests: s.requests, message: s.message })),
  };
}

/** One instance ("main") owns all runs, so two syncs never overlap. */
export class SyncRunner extends DurableObject {
  async getState() {
    return (await this.ctx.storage.get("state")) || { running: false };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start") {
      const trigger = url.searchParams.get("trigger") || "manual";
      // "analysis" skips the sync and only drafts analyses.
      const phase = url.searchParams.get("only") === "analysis" ? "analysis" : "sync";
      const state = await this.getState();
      const since = Date.parse(state.round_started_at || state.started_at || 0);
      if (state.running && Date.now() - since < STALE_MS) {
        return Response.json({ status: "already running", run_id: state.run_id, started_at: state.started_at, round: state.round });
      }
      const next = {
        running: true,
        run_id: crypto.randomUUID(),
        trigger,
        phase,
        started_at: new Date().toISOString(),
        round: 0,
        rounds: [],
        analysis_round: 0,
        analysis: null,
        outcome: null,
        error: null,
      };
      await this.ctx.storage.put("state", next);
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return Response.json({ status: "started", run_id: next.run_id, started_at: next.started_at });
    }
    if (url.pathname === "/state") return Response.json(await this.getState());
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const state = await this.getState();
    if (!state.running) return;
    if (state.phase === "analysis") return this.analysisRound(state);
    state.round += 1;
    state.round_started_at = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    try {
      const result = await runSync(this.env, { trigger: state.trigger, deadlineMs: ROUND_MS, runId: state.run_id });
      state.rounds = [...state.rounds, roundSummary(result, state.round, state.round_started_at)].slice(-10);
      if (result.continue_now && state.round < MAX_ROUNDS) {
        // More to fetch and this round only stopped at its budget: keep going.
        await this.ctx.storage.put("state", state);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      state.outcome = result.more_to_do
        ? state.round >= MAX_ROUNDS
          ? `stopped after ${MAX_ROUNDS} rounds with work left; start another run to continue`
          : "caught up except for sources at a daily limit; the daily sync continues them"
        : "up to date";
    } catch (err) {
      // Caught so the alarm isn't retried in a loop; the error is visible in /status.
      state.error = redact(`${err.name}: ${err.message}`);
      state.outcome = "error";
      console.error(`[${state.run_id}] run failed: ${state.error}`);
    }
    // Sync done (or failed): draft analyses for whatever bills are in D1.
    state.phase = "analysis";
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async analysisRound(state) {
    state.analysis_round = (state.analysis_round || 0) + 1;
    state.round_started_at = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    try {
      const r = await runAnalysis(this.env, { deadlineMs: ROUND_MS, runId: state.run_id, trigger: state.trigger });
      const prev = state.analysis || { drafted: 0 };
      state.analysis = {
        status: r.status,
        rounds: state.analysis_round,
        drafted: prev.drafted + r.analyzed,
        today: r.used === undefined ? null : `${r.used} of ${r.limit}`,
      };
      if (r.more_now && state.analysis_round < MAX_ANALYSIS_ROUNDS) {
        await this.ctx.storage.put("state", state);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
    } catch (err) {
      state.analysis = { ...(state.analysis || {}), status: "error", error: redact(`${err.name}: ${err.message}`) };
      console.error(`[${state.run_id}] analysis failed: ${state.analysis.error}`);
    }
    state.running = false;
    state.finished_at = new Date().toISOString();
    await this.ctx.storage.put("state", state);
  }
}

function runner(env) {
  if (!env.SYNC_RUNNER) throw new Error("Durable Object binding SYNC_RUNNER is missing (see wrangler.toml)");
  return env.SYNC_RUNNER.get(env.SYNC_RUNNER.idFromName("main"));
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
  async scheduled(event, env) {
    const res = await runner(env).fetch("https://sync-runner/start?trigger=cron");
    console.log(`cron: ${JSON.stringify(await res.json())}`);
  },

  async fetch(request, rawEnv) {
    const env = withD1Retry(rawEnv);
    const url = new URL(request.url);
    if (!["/run", "/analyze", "/status"].includes(url.pathname)) {
      return json({ ok: true, routes: ["/run?token=…", "/analyze?token=…", "/status?token=…"] });
    }
    if (!(await authorized(request, env))) return json({ error: "unauthorized: pass ?token= or Authorization: Bearer" }, 401);

    try {
      if (url.pathname === "/run") {
        const res = await runner(env).fetch("https://sync-runner/start?trigger=manual");
        const started = await res.json();
        return json({
          ...started,
          next: "Working in the background. Open /status (with the same token) to follow progress.",
        });
      }

      if (url.pathname === "/analyze") {
        const res = await runner(env).fetch("https://sync-runner/start?trigger=manual&only=analysis");
        return json({
          ...(await res.json()),
          next: "Drafting analyses in the background. Open /status (with the same token) to follow progress.",
        });
      }

      // /status
      const run = await (await runner(env).fetch("https://sync-runner/state")).json();
      let counts = null;
      let recent = [];
      if (env.DB) {
        await ensureSchema(env.DB);
        counts = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM officials WHERE active = 1) AS officials, (SELECT COUNT(*) FROM bills) AS bills, " +
            "(SELECT COUNT(*) FROM votes) AS votes, (SELECT COUNT(*) FROM vote_positions) AS positions, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'ai_draft') AS analyses_awaiting_review, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'reviewed') AS analyses_reviewed"
        ).first();
        recent = (await env.DB.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 30").all()).results;
      }
      return json({
        run: {
          status: run.running ? "running" : run.run_id ? "finished" : "never run",
          run_id: run.run_id || null,
          trigger: run.trigger || null,
          started_at: run.started_at || null,
          finished_at: run.finished_at || null,
          phase: run.phase || null,
          round: run.round || 0,
          outcome: run.outcome || null,
          analysis: run.analysis || null,
          error: run.error || null,
          rounds: run.rounds || [],
        },
        counts,
        recent_log: recent,
      });
    } catch (err) {
      return json({ error: redact(`${err.name}: ${err.message}`) }, 500);
    }
  },
};
