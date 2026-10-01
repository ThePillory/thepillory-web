// Agenda watch: for each new county agenda, a plain-language summary of every
// item (2 to 3 neutral sentences), flags in five categories, and suggested
// links to existing issues. Drafted by Claude from the official agenda,
// labeled "AI-drafted from the official agenda", reviewed at /admin/review.
//
// Checks before saving: an item number the agenda doesn't have is dropped; a
// sentence that states a number, amount or date the item's own agenda text
// doesn't contain is removed (and logged); flags and issue slugs are limited to
// the fixed lists by the JSON schema. Issue links start as "suggested".
//
// At most AGENDA_DAILY_LIMIT agendas a day (default 3), separate from bills.
import Anthropic from "@anthropic-ai/sdk";
import { ISSUES } from "../../../../functions/_lib/generated.js";
import { log } from "../db.js";
import { getState, setState, redact } from "../util.js";
import { pacificNow, addDays } from "../meetings/time.js";
import { FLAGS, checkSummaries } from "./agenda-check.js";
import { DEFAULT_MODEL, DraftRefused } from "./claude.js";

export { FLAGS, FLAG_LABELS } from "./agenda-check.js";
export const AGENDA_PROMPT_VERSION = "2026-10-01.1";
// Residents' issues to suggest links to. None until reporting opens: then the
// prompt and the shape leave issue links out entirely.
const HAS_ISSUES = Object.keys(ISSUES).length > 0;
const INSTRUCTIONS = `You write plain-language summaries of county government agenda items for The Pillory, a nonpartisan civic site. People review every summary. Readers are residents who want to know what their Board of Supervisors or Planning Commission is about to decide.

For every agenda item you are given:
- summary: 2 to 3 short, neutral sentences on what the item would do or decide, in plain language. Use only what the agenda says. If the agenda doesn't say something (a cost, a location, who is affected), don't guess; you may say "The agenda doesn't say …". Keep every number, amount and date exactly as the agenda gives it. No adjectives of judgment ("controversial", "costly", "common-sense"), no predictions, no party labels or partisan language.
- flags: any that plainly apply, else none:
  budget: spending, budgets, appropriations, contracts or agreements with a stated amount.
  land_use: zoning, permits, general or community plans, development, CEQA findings, property.
  fees_taxes: fees, rates, charges, assessments, taxes, bonds or measures that raise revenue.
  public_safety: sheriff, fire, emergency services, code enforcement, public health emergencies.
  public_access: public meetings, public comment, records, transparency, elections, appointments.
Closed-session items: summarize only what the agenda states; flag them only when the agenda states a subject that fits.${
  HAS_ISSUES
    ? "\n\nissue_links: only when an item plainly concerns the same subject as one of the listed issues, suggest a link with one neutral sentence on why. Most items won't have one. A person approves each link before it is shown."
    : ""
}`;

function issueList() {
  return Object.entries(ISSUES)
    .map(([slug, i]) => `- ${slug} (${i.level}): ${i.title}. ${i.facts}`)
    .join("\n");
}

function schema(keys) {
  const slugs = Object.keys(ISSUES);
  return {
    type: "object",
    additionalProperties: false,
    required: HAS_ISSUES ? ["items", "issue_links"] : ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item_key", "summary", "flags"],
          properties: {
            item_key: { type: "string", enum: keys },
            summary: { type: "string" },
            flags: { type: "array", items: { type: "string", enum: FLAGS } },
          },
        },
      },
      ...(HAS_ISSUES ? { issue_links: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item_key", "issue_slug", "reason"],
          properties: {
            item_key: { type: "string", enum: keys },
            issue_slug: { type: "string", enum: slugs },
            reason: { type: "string" },
          },
        },
      } } : {}),
    },
  };
}

function agendaMessage(meeting, items) {
  const lines = items.map((it) => {
    const docs = [it.staff_report_url ? "staff report attached" : null, ...JSON.parse(it.attachments || "[]").map((a) => `attachment: ${a.title}`)]
      .filter(Boolean)
      .join("; ");
    return `[${it.item_key}] (${it.section || "no section"}) ${it.title}${docs ? `\n    (${docs})` : ""}`;
  });
  return `${meeting.body}, ${meeting.meeting_type || "meeting"}, ${meeting.starts_at.replace("T", " ")}\n\nAgenda items, as [item number] (section) text:\n${lines.join("\n")}\n\n${HAS_ISSUES ? `Existing issues on The Pillory (slug (level): title. facts):\n${issueList()}\n\n` : ""}Write the summaries.`;
}

async function draftSummaries(env, meeting, items) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2 });
  const stream = client.beta.messages.stream({
    model: env.AGENDA_MODEL || env.ANALYSIS_MODEL || DEFAULT_MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: env.AGENDA_EFFORT || "medium", format: { type: "json_schema", schema: schema(items.map((i) => i.item_key)) } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: agendaMessage(meeting, items) }],
  });
  const msg = await stream.finalMessage();
  const usage = {
    input_tokens: msg.usage.input_tokens || 0,
    output_tokens: msg.usage.output_tokens || 0,
    cache_read_tokens: msg.usage.cache_read_input_tokens || 0,
    cache_write_tokens: msg.usage.cache_creation_input_tokens || 0,
  };
  if (msg.stop_reason === "refusal") throw Object.assign(new DraftRefused(`model declined (${(msg.stop_details || {}).category || "no category"})`), { usage });
  if (msg.stop_reason === "max_tokens") throw Object.assign(new Error("draft cut off at the output limit"), { usage });
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { draft: JSON.parse(text), model: msg.model, usage };
}

// Agendas to summarize: requests from the review page first, then upcoming
// meetings (soonest first), then meetings from the last MEETING_BACKFILL_DAYS
// (latest first), so recent agendas have summaries too.
async function nextAgendas(db, limit, backfillDays) {
  const today = pacificNow().slice(0, 10);
  const now = `${today}T00:00`;
  return (
    await db
      .prepare(
        `SELECT m.*, (SELECT r.id FROM agenda_requests r WHERE r.meeting_id = m.id AND r.status = 'pending' LIMIT 1) AS request_id
         FROM meetings m
         WHERE m.source IN ('iqm2', 'tylermm') AND m.details_file_id IS NOT NULL AND m.status != 'cancelled'
           AND EXISTS (SELECT 1 FROM meeting_items i WHERE i.meeting_id = m.id)
           AND (EXISTS (SELECT 1 FROM agenda_requests r WHERE r.meeting_id = m.id AND r.status = 'pending')
                OR (m.starts_at >= ? AND NOT EXISTS (SELECT 1 FROM agenda_summaries s WHERE s.meeting_id = m.id AND s.agenda_file_id IS m.details_file_id)))
         ORDER BY (request_id IS NULL), m.starts_at < ?, CASE WHEN m.starts_at >= ? THEN m.starts_at END, m.starts_at DESC LIMIT ?`
      )
      .bind(`${addDays(today, -backfillDays)}T00:00`, now, now, limit)
      .all()
  ).results;
}

async function save(db, meeting, draft, meta) {
  const J = JSON.stringify;
  const prev = await db.prepare("SELECT * FROM agenda_summaries WHERE meeting_id = ? AND current = 1").bind(meeting.id).first();
  const stmts = [db.prepare("UPDATE agenda_summaries SET current = 0 WHERE meeting_id = ? AND current = 1").bind(meeting.id)];
  if (prev) {
    stmts.push(
      db
        .prepare("INSERT INTO agenda_summary_revisions (summary_id, meeting_id, action, actor, note, snapshot) VALUES (?, ?, 'superseded', 'pipeline', ?, ?)")
        .bind(prev.id, meeting.id, "replaced by a new draft", J(prev))
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO agenda_summaries (meeting_id, agenda_file_id, current, status, items, model, prompt_version, check_log,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES (?, ?, 1, 'ai_draft', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(meeting.id, meeting.details_file_id, J(draft.items), meta.model, AGENDA_PROMPT_VERSION, J(meta.checkLog), meta.usage.input_tokens, meta.usage.output_tokens, meta.usage.cache_read_tokens, meta.usage.cache_write_tokens)
  );
  for (const l of draft.issue_links) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO item_issue_links (meeting_id, item_key, issue_slug, reason, suggested_by) VALUES (?, ?, ?, ?, 'agenda watch (AI)')")
        .bind(meeting.id, l.item_key, l.issue_slug, l.reason)
    );
  }
  await db.batch(stmts);
  const row = await db.prepare("SELECT * FROM agenda_summaries WHERE meeting_id = ? AND current = 1").bind(meeting.id).first();
  await db
    .prepare("INSERT INTO agenda_summary_revisions (summary_id, meeting_id, action, actor, snapshot) VALUES (?, ?, 'created', 'pipeline', ?)")
    .bind(row.id, meeting.id, J(row))
    .run();
  return row.id;
}

async function finishRequest(db, meeting, status, message) {
  if (!meeting.request_id) return;
  await db.prepare("UPDATE agenda_requests SET status = ?, handled_at = datetime('now'), message = ? WHERE id = ?").bind(status, message, meeting.request_id).run();
}

/** Draft summaries for up to the day's remaining agendas. Returns {drafted, used, limit, more_now}. */
export async function runAgendaWatch(env, db, { run, deadline }) {
  const started = new Date().toISOString();
  if (!env.ANTHROPIC_API_KEY) return { drafted: 0, more_now: false };
  const limit = parseInt(env.AGENDA_DAILY_LIMIT || "3", 10);
  const key = `agendas_${new Date().toISOString().slice(0, 10)}`;
  let used = parseInt((await getState(db, key)) || "0", 10);
  let drafted = 0;
  let stoppedEarly = false;
  const todo = used < limit ? await nextAgendas(db, limit - used, parseInt(env.MEETING_BACKFILL_DAYS || "30", 10)) : [];
  for (const meeting of todo) {
    if (deadline - Date.now() < 3 * 60 * 1000) {
      stoppedEarly = true;
      break;
    }
    const t0 = new Date().toISOString();
    const items = (await db.prepare("SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort").bind(meeting.id).all()).results;
    let status = "ok";
    let message;
    try {
      const { draft, model, usage } = await draftSummaries(env, meeting, items);
      const checkLog = checkSummaries(draft, items);
      const id = await save(db, meeting, draft, { model, usage, checkLog });
      drafted += 1;
      message =
        `${meeting.id}: agenda summary ${id} saved (${draft.items.length} of ${items.length} items, ` +
        `${draft.items.filter((i) => i.flags.length).length} flagged, ${draft.issue_links.length} issue link(s) suggested); ` +
        `model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, cache read ${usage.cache_read_tokens}; ` +
        `${checkLog.removed_sentences.length} sentence(s) removed by the number check`;
      await finishRequest(db, meeting, "done", `summary ${id}`);
    } catch (err) {
      status = err instanceof DraftRefused ? "skipped" : "error";
      const tokens = err.usage ? ` (tokens in ${err.usage.input_tokens}, out ${err.usage.output_tokens})` : "";
      message = `${meeting.id}: ${redact(`${err.name}: ${err.message}`)}${tokens}`;
      await finishRequest(db, meeting, "failed", message);
    }
    used += 1;
    await setState(db, key, String(used));
    await log(db, run, "agenda-watch", status, 1, message, t0);
  }
  const waiting = used < limit && stoppedEarly;
  if (todo.length || used >= limit) {
    await log(db, run, "agenda-watch-round", "ok", 0, `${drafted} agenda(s) summarized this round; ${used} of ${limit} today`, started);
  }
  return { drafted, used, limit, more_now: waiting };
}
