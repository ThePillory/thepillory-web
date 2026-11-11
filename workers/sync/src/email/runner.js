// The weekly email's run (docs/email.md): Sunday at 5 p.m. Pacific the cron starts it here,
// in its own Durable Object so it never waits on, or slows, the daily sync. Round 1 re-maps
// subscribers if the districts changed and builds every edition; then each round sends up to
// SEND_PER_ROUND emails, until all are sent (at most MAX_ROUNDS rounds). Each round first sets
// a safety alarm past the alarm time limit, so a round that's killed is picked up by the next.
// Every round's D1 rows read and written go to usage_steps as "weekly-email".
import { DurableObject } from "cloudflare:workers";
import { withD1Retry } from "../d1retry.js";
import { log } from "../db.js";
import { newTally, meteredEnv } from "../usage/meter.js";
import { recordStepUsage } from "../usage/sync.js";
import { noteInterrupted } from "../run-state.js";
import { buildWeek, sendRound, remapIfNewDistricts, siteJson, rollout } from "./send.js";
import { pacific } from "./schedule.js";

const ROUND_MS = 10 * 60 * 1000;
const SAFETY_ALARM_MS = 16 * 60 * 1000;
const MAX_ROUNDS = 60;

export class EmailRunner extends DurableObject {
  async getState() {
    return (await this.ctx.storage.get("state")) || { running: false };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start") {
      const week = url.searchParams.get("week");
      const state = await this.getState();
      if (state.running && state.week === week) return Response.json({ status: "already running", week });
      const next = { running: true, run_id: crypto.randomUUID(), week, today: pacific().date, trigger: url.searchParams.get("trigger") || "cron", phase: "build", round: 0, sent: 0, errors: 0, started_at: new Date().toISOString() };
      await this.ctx.storage.put("state", next);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ status: "started", week, run_id: next.run_id });
    }
    if (url.pathname === "/state") return Response.json(await this.getState());
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const state = await this.getState();
    if (!state.running) return;
    state.round += 1;
    noteInterrupted(state);
    state.round_started_at = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    const tally = newTally();
    const env = meteredEnv(withD1Retry(this.env), tally);
    const db = env.DB;
    const run = { id: `email-${state.run_id}`, trigger: state.trigger };
    let message = "";
    let status = "ok";
    try {
      if (state.phase === "build") {
        const remap = await remapIfNewDistricts(env, db, siteJson(env));
        const built = await buildWeek(env, db, state.week, state.today);
        state.phase = "send";
        state.editions = built;
        message = `week of ${state.week} (sending ${rollout(env).mode}): ${built.built} edition(s) built, ${built.keys.length} with something new, ${built.empty} with nothing new (not sent)${remap.remapped || remap.split ? `; districts changed: ${remap.remapped} re-mapped, ${remap.split} asked to confirm their place` : ""}`;
      } else {
        const r = await sendRound(env, db, state.week, { deadline: Date.now() + ROUND_MS });
        state.sent += r.sent;
        state.errors += r.errors;
        message = `week of ${state.week}: ${r.sent} sent this round (${state.sent} in all), ${r.errors} error(s), ${r.left} left`;
        if (r.errors) status = "partial";
        if (!r.left || state.round >= MAX_ROUNDS) state.running = false;
      }
    } catch (err) {
      status = "error";
      message = `week of ${state.week}: ${err.name}: ${err.message}`;
      state.error = message;
      state.running = false;
    }
    state.round_open = false;
    state.finished_at = state.running ? null : new Date().toISOString();
    await this.ctx.storage.put("state", state);
    try {
      await log(db, run, "weekly-email", status, 0, message, state.round_started_at);
      await recordStepUsage(withD1Retry(this.env).DB, pacific().date, "weekly-email", tally);
    } catch (err) {
      console.error(`weekly-email: couldn't log: ${err.message}`);
    }
    if (state.running) await this.ctx.storage.setAlarm(Date.now() + 1000);
    else await this.ctx.storage.deleteAlarm();
  }
}
