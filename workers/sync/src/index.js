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
import { summarizeFlags } from "./analysis/flags.js";
import { syncExecutiveOfficials, syncExecutiveOrders, syncBillOutcomes, syncNominations } from "./executive/sync.js";
import { DurableObject } from "cloudflare:workers";
import { ensureSchema, log } from "./db.js";
import { Budget, redact, getState, setState, isTemporary } from "./util.js";
import { syncCounty } from "./county.js";
import { syncStateOfficials, syncStateVotes } from "./openstates.js";
import { syncFederalOfficials, syncHouseVotes } from "./congress.js";
import { syncSenateVotes } from "./senate.js";
import { runAnalysis } from "./analysis/index.js";
import { syncCountyMeetings } from "./meetings/county.js";
import { syncStateHearings } from "./meetings/state.js";
import { withD1Retry } from "./d1retry.js";
import { syncFederalFunding, syncFederalLobbying } from "./funding/sync.js";
import { syncExecutiveFunding } from "./funding/executive.js";
import { syncSummaries, buildSummaries } from "./summaries.js";
import { syncIssuesPages } from "./promises/finder-sync.js";
import { syncOrderTexts, syncOrderCourts } from "./executive/orders-sync.js";
import { syncHistoryOfficials, syncHistoryOrders, syncHistoryFunding, syncHistoryNominations, syncHistoryVotes } from "./history/sync.js";

// Order matters: officials before votes; state officials first because the
// Open States lookup also detects the U.S. House district. State hearings come
// before state votes, which can use up the Open States daily cap. County
// meetings come next: the county portal asks for a minute between requests.
const STEPS = [
  ["county-officials", syncCounty],
  ["state-officials", syncStateOfficials],
  ["federal-officials", syncFederalOfficials],
  ["executive-officials", syncExecutiveOfficials],
  ["state-hearings", syncStateHearings],
  ["house-votes", syncHouseVotes],
  ["senate-votes", syncSenateVotes],
  ["state-votes", syncStateVotes],
  ["county-meetings", syncCountyMeetings],
  // After the votes: California outcomes are looked up for bills that passed both houses.
  ["bill-outcomes", syncBillOutcomes],
  ["executive-orders", syncExecutiveOrders],
  ["nominations", syncNominations],
  // Each executive order's text and the authority it claims (read once), and
  // court records on CourtListener that mention it (src/executive/orders-sync.js).
  ["order-texts", syncOrderTexts],
  ["order-courts", syncOrderCourts],
  // Executive money and disclosures: small, so they run before federal-funding
  // rather than wait behind its first load.
  ["executive-funding", syncExecutiveFunding],
  // Officials' Issues and Priorities pages, found by following links from their
  // own websites (src/promises/finder-sync.js), a few dozen officials a day.
  ["issues-pages", syncIssuesPages],
  // Paced and long-running (the first full load takes a few days): last.
  ["federal-funding", syncFederalFunding],
  ["federal-lobbying", syncFederalLobbying],
  // The Time Machine: past officeholders, executive orders, money, confirmations
  // and votes, a little each day (HISTORY_DAILY_REQUESTS), newest first.
  ["history-officials", syncHistoryOfficials],
  ["history-orders", syncHistoryOrders],
  ["history-funding", syncHistoryFunding],
  ["history-nominations", syncHistoryNominations],
  ["history-votes", syncHistoryVotes],
  // What the pages show, precomputed from everything above (src/summaries.js).
  // Rebuilt only when the votes, bills, outcomes or relevance checks changed.
  ["page-summaries", syncSummaries],
];

const ROUND_MS = 12 * 60 * 1000; // stop starting new requests after this; the alarm limit is 15 minutes
const MAX_ROUNDS = 20; // safety cap on automatic continuation per run
const MAX_ANALYSIS_ROUNDS = 10; // same, for the analysis step
const STALE_MS = 20 * 60 * 1000; // a round that hasn't finished after this is treated as dead

export async function runSync(rawEnv, { trigger, deadlineMs, runId }) {
  if (!rawEnv.DB) throw new Error("D1 binding DB is missing (see wrangler.toml)");
  const env = withD1Retry(rawEnv); // temporary D1 errors are retried (src/d1retry.js)
  await ensureSchema(env.DB);
  // The page summaries are built at the end of each round; on a database where
  // they've never been built (just after migration 0010), build them first, so
  // the Laws page doesn't wait a whole round.
  if (!(await getState(env.DB, "summaries_fingerprint"))) {
    try {
      const r = await buildSummaries(env.DB);
      console.log(`page summaries (first build): ${r.message}`);
    } catch (err) {
      console.error(`page summaries (first build) failed: ${redact(`${err.name}: ${err.message}`)}`);
    }
  }
  const run = { id: runId || crypto.randomUUID(), trigger };
  const budget = new Budget(env, deadlineMs);
  const summary = [];
  const day = new Date().toISOString().slice(0, 10);
  for (const [step, fn] of STEPS) {
    const started = new Date().toISOString();
    const before = budget.used;
    let result;
    // A step that failed waits for the next day's run instead of failing again
    // every round. A manual run (/run) retries a step that failed in an
    // earlier run today, e.g. after a fix is deployed.
    const failed = JSON.parse((await getState(env.DB, `step_failed_${step}`)) || "null");
    if (failed && failed.day === day && (failed.run === run.id || trigger === "cron")) {
      result = { status: "skipped", message: `failed earlier today (${failed.message}); tried again in tomorrow's run or a manual run` };
    } else {
      try {
        result = await fn(env, env.DB, budget);
      } catch (err) {
        if (isTemporary(err)) {
          // A rate limit or an unavailable server, still failing after the
          // retries: not a failure for the day. The step keeps its place and is
          // tried again in a later round (TEMPORARY_RETRY_MS).
          result = { status: "partial", message: redact(`temporary error, tried again later: ${err.name}: ${err.message}`) };
          console.warn(`[${run.id}] ${step}: ${result.message}`);
        } else {
          // Logged, never swallowed: one failing source doesn't stop the others.
          result = { status: "error", message: redact(`${err.name}: ${err.message}`) };
          console.error(`[${run.id}] ${step}: ${result.message}`);
          await setState(env.DB, `step_failed_${step}`, JSON.stringify({ day, run: run.id, message: result.message.slice(0, 300) }));
        }
      }
    }
    await log(env.DB, run, step, result.status, budget.used - before, result.message, started);
    summary.push({ step, ...result, requests: budget.used - before });
  }
  const temporary = summary.filter((s) => s.status === "partial" && /^temporary error/.test(s.message || ""));
  const partialVotes = summary.filter((s) => (s.step.endsWith("-votes") || ["county-meetings", "bill-outcomes", "executive-orders", "nominations", "order-texts", "order-courts", "executive-funding", "federal-funding", "federal-lobbying"].includes(s.step)) && s.status === "partial");
  return {
    run_id: run.id,
    trigger,
    requests_used: budget.used,
    steps: summary,
    more_to_do: partialVotes.length > 0 || temporary.length > 0,
    // Worth another round now only if a step stopped at this round's request or time
    // budget. A daily limit (Open States) resets tomorrow; the daily cron picks it up.
    continue_now: partialVotes.some((s) => /request budget used up|run time limit reached/.test(s.message || "")),
    // A step that stopped on a temporary error (after its retries) gets another
    // round after a pause, rather than waiting for tomorrow.
    retry_later: temporary.map((s) => s.step),
    retries: budget.retries || 0,
  };
}

// The secrets the sync uses: whether each is set (never its value), plus any
// set name that looks like one but isn't spelled the same (a stray space, a
// different case, FEC_KEY…), so a mistyped secret shows up in /status.
const SECRETS = ["CONGRESS_API_KEY", "FEC_API_KEY", "OPENSTATES_API_KEY", "ANTHROPIC_API_KEY", "COURTLISTENER_API_TOKEN", "LDA_API_KEY", "SYNC_TOKEN"];
export function keyReport(env) {
  const names = [];
  for (const k in env || {}) names.push(k);
  const set = Object.fromEntries(SECRETS.map((k) => [k, typeof env[k] === "string" && env[k].trim().length > 0]));
  const norm = (k) => k.trim().toUpperCase().replace(/[^A-Z]/g, "");
  const setting = /_(BASE|URL|MS|LIMIT|DAYS|SHARE|DAILY|INTERVAL)$|_MIN_/; // the Worker's own settings, not keys
  const near = names.filter((n) => !SECRETS.includes(n) && !setting.test(n.trim()) && SECRETS.some((s) => norm(n) === norm(s) || (/FEC/i.test(n) && /FEC/.test(s))));
  return {
    set,
    look_alike_names: near,
    fec_key_in_use: set.FEC_API_KEY ? "FEC_API_KEY" : set.CONGRESS_API_KEY ? "CONGRESS_API_KEY (FEC_API_KEY isn't set for this Worker)" : "none",
  };
}

function roundSummary(result, round, startedAt) {
  return {
    round,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    requests: result.requests_used,
    retries: result.retries || 0,
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
      // restart=1 replaces a run in progress (e.g. after a deploy, so new code takes over).
      const restart = url.searchParams.get("restart") === "1";
      if (state.running && Date.now() - since < STALE_MS && !restart) {
        return Response.json({ status: "already running", run_id: state.run_id, started_at: state.started_at, round: state.round });
      }
      const replaced = state.running ? state.run_id : null;
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
      return Response.json({ status: "started", run_id: next.run_id, started_at: next.started_at, ...(replaced ? { replaced } : {}) });
    }
    if (url.pathname === "/stop") {
      const state = await this.getState();
      if (!state.running) return Response.json({ status: "not running", run_id: state.run_id || null });
      state.running = false;
      state.outcome = "stopped by hand";
      state.finished_at = new Date().toISOString();
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.deleteAlarm();
      return Response.json({ status: "stopped", run_id: state.run_id });
    }
    if (url.pathname === "/state") return Response.json(await this.getState());
    return new Response("not found", { status: 404 });
  }

  // A round that finishes after its run was stopped or replaced (/stop, /run?restart=1)
  // keeps what it saved to D1 but doesn't touch the newer state or schedule more rounds.
  async superseded(state) {
    const now = await this.getState();
    return !now.running || now.run_id !== state.run_id;
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
      if (await this.superseded(state)) return;
      state.rounds = [...state.rounds, roundSummary(result, state.round, state.round_started_at)].slice(-10);
      if ((result.continue_now || result.retry_later.length) && state.round < MAX_ROUNDS) {
        // More to fetch and this round only stopped at its budget: keep going.
        // A temporary error alone (a rate limit, a server timing out) waits
        // TEMPORARY_RETRY_MS (5 minutes) first, so the source can recover.
        await this.ctx.storage.put("state", state);
        const pause = result.continue_now ? 1000 : parseInt(this.env.TEMPORARY_RETRY_MS || "300000", 10);
        await this.ctx.storage.setAlarm(Date.now() + pause);
        return;
      }
      state.outcome = result.more_to_do
        ? state.round >= MAX_ROUNDS
          ? `stopped after ${MAX_ROUNDS} rounds with work left; start another run to continue`
          : "caught up except for sources at a daily limit; the daily sync continues them"
        : "up to date";
    } catch (err) {
      if (await this.superseded(state)) return;
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
      if (await this.superseded(state)) return;
      const prev = state.analysis || { drafted: 0 };
      state.analysis = {
        status: r.status,
        rounds: state.analysis_round,
        drafted: prev.drafted + r.analyzed,
        today: r.used === undefined ? null : `${r.used} of ${r.limit}`,
        agendas: r.agendas ? { drafted: ((prev.agendas && prev.agendas.drafted) || 0) + r.agendas.drafted, today: r.agendas.limit ? `${r.agendas.used} of ${r.agendas.limit}` : null } : null,
      };
      if (r.more_now && state.analysis_round < MAX_ANALYSIS_ROUNDS) {
        await this.ctx.storage.put("state", state);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
    } catch (err) {
      if (await this.superseded(state)) return;
      state.analysis = { ...(state.analysis || {}), status: "error", error: redact(`${err.name}: ${err.message}`) };
      console.error(`[${state.run_id}] analysis failed: ${state.analysis.error}`);
    }
    // The relevance checks just run decide which bills Happening now leaves out.
    try {
      state.summaries = (await buildSummaries(withD1Retry(this.env).DB)).message;
    } catch (err) {
      state.summaries = redact(`error: ${err.name}: ${err.message}`);
      console.error(`[${state.run_id}] page summaries failed: ${state.summaries}`);
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
    if (!["/run", "/stop", "/analyze", "/status", "/summaries"].includes(url.pathname)) {
      return json({ ok: true, routes: ["/run?token=…", "/run?restart=1&token=…", "/stop?token=…", "/analyze?token=…", "/summaries?token=…", "/status?token=…"] });
    }
    if (!(await authorized(request, env))) return json({ error: "unauthorized: pass ?token= or Authorization: Bearer" }, 401);

    try {
      if (url.pathname === "/run") {
        const restart = url.searchParams.get("restart") === "1" ? "&restart=1" : "";
        const res = await runner(env).fetch(`https://sync-runner/start?trigger=manual${restart}`);
        const started = await res.json();
        return json({
          ...started,
          next:
            started.status === "already running"
              ? "A run is already going. To replace it with a fresh one (e.g. after a deploy), open /run?restart=1 (with the same token)."
              : `Working in the background. Open /status (with the same token) to follow progress.${
                  started.replaced ? " The replaced run's round in progress finishes its current requests first, then this run starts." : ""
                }`,
        });
      }

      if (url.pathname === "/stop") {
        const res = await runner(env).fetch("https://sync-runner/stop");
        return json({
          ...(await res.json()),
          next: "No more rounds will start. A round already in progress finishes its current requests (up to about 12 minutes); what it saved is kept.",
        });
      }

      // Rebuilds the page summaries (the Laws list, vote counts) now, from what's
      // already in D1. No outside requests; takes a few seconds.
      if (url.pathname === "/summaries") {
        await ensureSchema(env.DB);
        const r = await buildSummaries(env.DB, { force: true });
        await log(env.DB, { id: `summaries-${Date.now()}`, trigger: "manual" }, "page-summaries", r.status, 0, r.message, new Date().toISOString());
        return json({ ...r, next: "The Laws page shows the new list within 5 minutes (Cloudflare keeps each copy that long)." });
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
      let flags = null;
      if (env.DB) {
        await ensureSchema(env.DB);
        counts = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM officials WHERE active = 1) AS officials, (SELECT COUNT(*) FROM bills) AS bills, " +
            "(SELECT COUNT(*) FROM votes) AS votes, (SELECT COUNT(*) FROM vote_positions) AS positions, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'ai_draft' AND ai_review = 'pass') AS analyses_auto_checked, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'ai_draft' AND ai_review = 'flag') AS analyses_flagged_by_ai, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'ai_draft' AND ai_review IS NULL) AS analyses_awaiting_ai_review, " +
            "(SELECT COUNT(*) FROM bill_analyses WHERE current = 1 AND status = 'reviewed') AS analyses_reviewed, " +
            "(SELECT COUNT(*) FROM bill_relevance WHERE verdict = 'skip' AND override IS NULL) AS bills_skipped_as_ceremonial, " +
            "(SELECT COUNT(*) FROM bill_list) AS laws_page_bills"
        ).first();
        recent = (await env.DB.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 30").all()).results;
        // Why drafts are flagged: the current flags, and the earlier reviews of
        // drafts re-reviewed under the reviewer's newer rules (with the new outcome).
        const rows = (
          await env.DB.prepare(
            `SELECT bill_id, ai_review, ai_review_detail FROM bill_analyses
             WHERE current = 1 AND status = 'ai_draft' AND (ai_review = 'flag' OR json_extract(ai_review_detail, '$.previous') IS NOT NULL)`
          ).all()
        ).results.map((r) => ({ bill_id: r.bill_id, verdict: r.ai_review, detail: JSON.parse(r.ai_review_detail || "{}") }));
        const rereviewed = rows.filter((r) => r.detail.previous);
        flags = {
          flagged_now: summarizeFlags(rows.filter((r) => r.verdict === "flag")),
          rereviewed_under_new_rules: {
            ...summarizeFlags(rereviewed, { which: "previous" }),
            now_published: rereviewed.filter((r) => r.verdict === "pass").length,
            still_flagged: rereviewed.filter((r) => r.verdict === "flag").length,
          },
        };
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
        keys: keyReport(env),
        ai_review_flags: flags,
        recent_log: recent,
      });
    } catch (err) {
      return json({ error: redact(`${err.name}: ${err.message}`) }, 500);
    }
  },
};
