// The plain-summaries step: Simple mode's "What it does" lines (docs/simple-mode.md).
// Rewrites, in plain words, a summary the site already shows, and keeps the
// rewrite only when the checks in check.js pass. Never a new claim.
//
// Sources, in the order the bill page itself uses them:
//   bills     a person's summary; the official summary's "This bill …" part
//             (Congressional Research Service, or the Legislative Counsel's
//             Digest); the checked constitutional analysis's summary, with its
//             supporters and critics lines
//   orders    the checked analysis's summary, with supporters and critics
//   measures  the official summary (California's Attorney General; Washington's
//             ballot title; a county measure's ballot question), from the
//             election files on the site (PLAIN_ELECTIONS)
// Order: bills with the latest final votes first, then orders, then measures.
// PLAIN_DAILY (40) rewrites a day. A refused rewrite is tried again only when
// its source changes.
import { getState, setState, today, redact, BudgetExhausted } from "../util.js";
import { structuredCall, DEFAULT_MODEL } from "../analysis/claude.js";
import { PLAIN_INSTRUCTIONS, plainSchema, plainMessage } from "./prompt.js";
import { plainProblems, readingGrade } from "./check.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where a bill's "what it does" begins in its official summary, or -1. Pure. */
const whatItDoes = (text) => String(text || "").search(/\bThis (bill|measure|joint resolution|concurrent resolution|resolution) (would |)[a-z]/);

/** The source a bill's plain line is written from, as the bill page shows it; null when there's none. Pure. */
export function billSource(b, analysis) {
  if (b.summary && b.summary.trim()) return { text: b.summary.trim(), source_label: "ThePillory's summary of the bill text" };
  const off = String(b.official_summary || "");
  const label = String(b.official_summary_label || "");
  const crs = /^CRS summary/i.test(label);
  const digest = /Legislative Counsel/i.test(label);
  if (off && (crs || digest)) {
    const at = whatItDoes(off);
    if (at >= 0 || crs) return { text: (at >= 0 ? off.slice(at) : off).slice(0, 2500), source_label: crs ? "the Congressional Research Service's summary" : "the Legislative Counsel's Digest" };
  }
  if (analysis && analysis.plain_summary) return analysisSource(analysis);
  return null;
}

/** An analysis as a source: its summary, and both sides when it has them. Pure. */
export function analysisSource(a) {
  const both = String(a.supporters || "").trim() && String(a.critics || "").trim();
  return {
    text: a.plain_summary,
    supporters: both ? a.supporters.trim() : "",
    critics: both ? a.critics.trim() : "",
    source_label: "the checked constitutional analysis (AI-drafted)",
  };
}

/** A ballot measure's official summary, as its page shows it. Pure. */
export function measureSource(election, m) {
  if (m.ballot_title && m.ballot_title.description) return { text: m.ballot_title.description, source_label: "the Attorney General's ballot title" };
  if (m.scope === "statewide" && m.summary) return { text: String(m.summary).replace(/^Put on the Ballot by (?:the Legislature|Petition Signatures)\s*/, ""), source_label: "the Attorney General's official summary" };
  if (m.question) return { text: m.question, source_label: "the question as it appears on the ballot" };
  return null;
}

const PUBLIC = "current = 1 AND (status = 'reviewed' OR (status = 'ai_draft' AND ai_review = 'pass'))";

async function publicAnalyses(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT bill_id, plain_summary, supporters, critics FROM bill_analyses WHERE ${PUBLIC} AND bill_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all();
    for (const r of results) out.set(r.bill_id, r);
  }
  return out;
}

/** Every item that could have a plain line now, newest-voted bills first. */
async function candidates(env, db, budget) {
  const items = [];
  const { results: bills } = await db
    .prepare(
      `SELECT b.id, b.title, b.level, b.summary, b.official_summary, b.official_summary_label FROM bill_list l JOIN bills b ON b.id = l.bill_id
       WHERE l.last_final IS NOT NULL ORDER BY l.last_final DESC, b.id LIMIT 400`
    )
    .all();
  const analyses = await publicAnalyses(db, bills.map((b) => b.id));
  for (const b of bills) {
    const src = billSource(b, analyses.get(b.id));
    if (src) items.push({ kind: "bill", id: b.id, describe: `a ${b.level === "federal" ? "bill in Congress" : "state bill"}, "${b.title}"`, ...src });
  }
  const { results: orders } = await db
    .prepare(
      `SELECT a.bill_id AS id, x.title, a.plain_summary, a.supporters, a.critics FROM bill_analyses a JOIN executive_actions x ON x.id = a.bill_id
       WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status = 'ai_draft' AND a.ai_review = 'pass')) ORDER BY x.signed_on DESC LIMIT 200`
    )
    .all()
    .catch((err) => {
      if (missing(err)) return { results: [] };
      throw err;
    });
  for (const o of orders) items.push({ kind: "order", id: o.id, describe: `an executive order, "${o.title}"`, ...analysisSource(o) });
  const base = (env.SITE_URL || "").replace(/\/$/, "");
  for (const eid of String(env.PLAIN_ELECTIONS || "2026-11-03,2026-11-03-wa").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!base) break;
    let election;
    try {
      election = await budget.json(`${base}/data/elections/${eid}.json`, {}, `election ${eid}`);
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      continue;
    }
    for (const m of election.measures || []) {
      const src = measureSource(election, m);
      if (src) items.push({ kind: "measure", id: `${election.election.id}:${m.id}`, describe: `a ballot measure, ${m.label || m.title || m.id}`, ...src });
    }
  }
  return items;
}

/** One rewrite: the model's answer, checked. Returns {row} or {problems}. */
export async function rewrite(env, item, { call = structuredCall } = {}) {
  const sides = Boolean(item.supporters && item.critics);
  const { data, model } = await call(env, {
    model: env.PLAIN_MODEL || DEFAULT_MODEL,
    system: [PLAIN_INSTRUCTIONS],
    message: plainMessage(item),
    jsonSchema: plainSchema,
    maxTokens: 1500,
  });
  const r = { what: String(data.what || "").trim(), supporters: String(data.supporters || "").trim(), critics: String(data.critics || "").trim() };
  const source = [item.text, item.supporters, item.critics].filter(Boolean).join("\n");
  const problems = plainProblems(r, source, { sides });
  if (problems.length) return { problems, model };
  return { row: { ...r, grade: readingGrade(r.what), model } };
}

export async function syncPlainSummaries(env, db, budget, { call } = {}) {
  if (!env.ANTHROPIC_API_KEY && !call) return { status: "skipped", message: "no ANTHROPIC_API_KEY" };
  const limit = parseInt(env.PLAIN_DAILY || "40", 10);
  const dayKey = `plain_summaries_${today()}`;
  let done = parseInt((await getState(db, dayKey)) || "0", 10);
  if (done >= limit) return { status: "skipped", message: `${done} plain rewrites today (PLAIN_DAILY ${limit})` };
  let have;
  let tried;
  try {
    have = new Map((await db.prepare("SELECT kind || ':' || item_id AS k, source_hash FROM plain_summaries").all()).results.map((r) => [r.k, r.source_hash]));
    tried = new Map((await db.prepare("SELECT kind || ':' || item_id AS k, source_hash FROM plain_attempts").all()).results.map((r) => [r.k, r.source_hash]));
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  const items = await candidates(env, db, budget);
  const tally = { written: 0, refused: 0, error: 0 };
  for (const item of items) {
    if (done >= limit) break;
    const hash = await sha256([item.text, item.supporters || "", item.critics || ""].join("\n"));
    const k = `${item.kind}:${item.id}`;
    if (have.get(k) === hash || tried.get(k) === hash) continue;
    try {
      const out = await rewrite(env, item, { call });
      if (out.row) {
        await db
          .prepare(
            `INSERT OR REPLACE INTO plain_summaries (kind, item_id, what, supporters, critics, source_label, source_hash, grade, model, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(item.kind, item.id, out.row.what, out.row.supporters || null, out.row.critics || null, item.source_label, hash, out.row.grade, out.row.model)
          .run();
        await db.prepare("DELETE FROM plain_attempts WHERE kind = ? AND item_id = ?").bind(item.kind, item.id).run();
        tally.written += 1;
      } else {
        await db
          .prepare("INSERT OR REPLACE INTO plain_attempts (kind, item_id, source_hash, problems, tried_at) VALUES (?, ?, ?, ?, datetime('now'))")
          .bind(item.kind, item.id, hash, out.problems.join("; ").slice(0, 500))
          .run();
        tally.refused += 1;
      }
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      tally.error += 1;
      console.warn(`plain ${k}: ${redact(String(err.message || err))}`);
    }
    done += 1;
    await setState(db, dayKey, String(done));
  }
  return { status: "ok", message: `${tally.written} plain rewrite(s) written, ${tally.refused} refused by the checks${tally.error ? `, ${tally.error} failed` : ""}` };
}
