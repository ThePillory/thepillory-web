// The resolution step: what happens to a draft the AI reviewer flagged with a
// major problem (a factual error, unfair to one side, opinion stated as fact),
// and to a published analysis a reader reports ("Something wrong?"). No person
// is needed (docs/analysis.md, "When the reviewer flags a draft"):
//
//   1. fix: a different model (RESOLVE_MODEL, claude-opus-5-5) revises the
//      draft with the reviewer's findings; every code check runs again (quotes
//      word for word, cases on CourtListener, the hard wording rules), and the
//      AI reviewer reads it again. No major problem: published, "fixed".
//   2. trim: the passages the reviewer marked are cut (never rewritten), with
//      both sides of anything balanced cut together (all three panels, both
//      argument lines, every reading); the reviewer reads what's left. No
//      major problem and still a whole analysis: published, "trimmed".
//   3. summary only: the summary and the provisions it touches, with "Full
//      analysis not available yet". Reviewed again; published if it passes.
//   4. otherwise nothing is published ("withheld").
//
// The one line held throughout: text any review marked as a major problem is
// never published, even if a later review passes it. Pure: the model calls
// come in as functions, so it's tested without the API.
import { WHERE_FIELDS } from "./review.js";

export const RESOLVE_MODEL = "claude-opus-5-5";

const PANELS = ["aligns", "tension", "departure"];
const LISTS = ["clauses", "aligns", "tension", "departure", "readings", "citations"];
const TEXTS = ["plain_summary", "supporters", "critics", "uncertainty", "article_v"];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const copy = (d) => JSON.parse(JSON.stringify(d || {}));

/** An item's text: what a reader would read of it. */
function textOf(field, item) {
  if (item == null) return "";
  if (field === "clauses") return item.why || "";
  if (field === "readings") return [item.question, item.original_meaning, item.precedent, item.evolving].filter(Boolean).join(" ");
  if (field === "citations") return [item.case_name, item.point].filter(Boolean).join(" ");
  return String(item);
}

/** Every item of a draft as {field, index, text}. Pure. */
export function itemsOf(draft) {
  const out = [];
  for (const f of TEXTS) if (String(draft[f] || "").trim()) out.push({ field: f, index: 0, text: String(draft[f]) });
  for (const f of LISTS) (draft[f] || []).forEach((item, index) => out.push({ field: f, index, text: textOf(f, item) }));
  return out;
}

function textAt(draft, { field, index }) {
  if (TEXTS.includes(field)) return index === 0 ? String(draft[field] || "") : "";
  const list = draft[field] || [];
  return index < list.length ? textOf(field, list[index]) : "";
}

/** Adds the text at each spot to `marked` (normalized). Returns how many spots pointed at nothing. Pure. */
export function addMarked(marked, draft, spots = []) {
  let missed = 0;
  for (const s of spots) {
    const t = norm(textAt(draft, s));
    if (t) marked.add(t);
    else missed += 1;
  }
  return missed;
}

/** The spots in `draft` whose text was marked in an earlier review. Pure. */
export function markedSpots(draft, marked) {
  return itemsOf(draft).filter((i) => marked.has(norm(i.text))).map(({ field, index }) => ({ field, index, check: "marked" }));
}

/** Whether any published text was marked by a review. Pure. */
export const containsMarked = (draft, marked) => markedSpots(draft, marked).length > 0;

/**
 * Cuts the passages at `spots` (never rewrites them). Both sides of anything
 * balanced go together: a panel left empty takes all three panels with it,
 * either argument line takes both, any reading takes every reading, and a cut
 * case takes the panel points that name it. A spot in the summary can't be cut
 * (summaryHit). Returns {draft, removed: [{field, index, text}], summaryHit,
 * panelsGone, unlocated}. Pure.
 */
export function trimDraft(draft, spots = []) {
  const d = copy(draft);
  const removed = [];
  let summaryHit = false;
  let unlocated = 0;
  const cut = new Map(); // field -> set of indices
  for (const s of spots) {
    if (!WHERE_FIELDS.includes(s.field)) {
      unlocated += 1;
      continue;
    }
    if (s.field === "plain_summary") {
      summaryHit = true;
      continue;
    }
    if (!textAt(d, s)) {
      unlocated += 1;
      continue;
    }
    if (!cut.has(s.field)) cut.set(s.field, new Set());
    cut.get(s.field).add(s.index);
  }
  // A cut case takes the panel points and readings that name it.
  for (const i of cut.get("citations") || []) {
    const name = norm((d.citations[i] || {}).case_name);
    if (!name) continue;
    for (const f of [...PANELS, "readings"]) {
      (d[f] || []).forEach((item, j) => {
        if (norm(textOf(f, item)).includes(name)) {
          if (!cut.has(f)) cut.set(f, new Set());
          cut.get(f).add(j);
        }
      });
    }
  }
  if (cut.has("supporters") || cut.has("critics")) {
    cut.set("supporters", new Set([0]));
    cut.set("critics", new Set([0]));
  }
  if (cut.has("readings")) cut.set("readings", new Set((d.readings || []).map((_, i) => i)));
  const before = Object.fromEntries(PANELS.map((f) => [f, (d[f] || []).length]));
  for (const [field, idx] of cut) {
    if (TEXTS.includes(field)) {
      if (String(d[field] || "").trim()) removed.push({ field, index: 0, text: String(d[field]) });
      d[field] = "";
    } else {
      const keep = [];
      (d[field] || []).forEach((item, i) => (idx.has(i) ? removed.push({ field, index: i, text: textOf(field, item) }) : keep.push(item)));
      d[field] = keep;
    }
  }
  const panelsGone = PANELS.some((f) => before[f] > 0 && !(d[f] || []).length);
  if (panelsGone) {
    for (const f of PANELS) {
      (d[f] || []).forEach((item, i) => removed.push({ field: f, index: i, text: item }));
      d[f] = [];
    }
    if (d.article_v) removed.push({ field: "article_v", index: 0, text: d.article_v });
    d.article_v = "";
  }
  return { draft: d, removed, summaryHit, panelsGone, unlocated };
}

/**
 * Still an analysis worth showing: a summary, a provision and the panels. A
 * panel can be empty by itself ("None identified"); trimDraft never leaves one
 * side cut and the others standing. Pure.
 */
export const useful = (d) => Boolean(String(d.plain_summary || "").trim()) && (d.clauses || []).length > 0 && PANELS.some((f) => (d[f] || []).length > 0);

/** The summary and the provisions it touches, nothing else. Pure. */
export function summaryOnly(d) {
  return { plain_summary: d.plain_summary || "", clauses: copy(d.clauses || []), aligns: [], tension: [], departure: [], readings: [], citations: [], supporters: "", critics: "", uncertainty: "", article_v: "" };
}

/** The major checks a review failed without saying where. */
const unlocatedChecks = (review) => (review.checks || []).filter((c) => !c.ok && c.severity === "major" && !(c.where || []).length).map((c) => c.id);

/**
 * Resolve one draft. `input`: {draft, depth, review (the flagging review, or
 * null for a reader report), readerReports}. `deps`: {revise(draft, reasons),
 * check(draft, trimmed), review(draft, depth, {readerReports}), hard(draft),
 * lint(draft), cost(model, usage)}, the last returning cents. Returns
 * {outcome: fixed | trimmed | summary_only | withheld | no_change, draft,
 * review, removed, reasons, cents, model, checks, steps}.
 */
export async function resolveDraft(input, deps) {
  const { depth, readerReports = [] } = input;
  const marked = new Set();
  const steps = [];
  let cents = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const spend = (model, u = {}) => {
    cents += deps.cost(model, u);
    for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
  };
  const removed = [];
  const review = async (d, dep, opts) => {
    const r = await deps.review(d, dep, opts);
    spend(r.model, r.usage);
    addMarked(marked, d, r.spots);
    steps.push(`review (${dep}): ${r.verdict}${r.reasons.length ? `, ${r.reasons.length} major` : ""}`);
    return r;
  };
  let flag = input.review;
  const done = (outcome, extra = {}) => ({ outcome, removed, cents, usage, steps, marked: marked.size, flagReview: flag, ...extra });

  // A reader's report: the published analysis is reviewed again, with the report as data.
  if (readerReports.length) {
    flag = await review(input.draft, depth, { readerReports });
    if (flag.verdict === "pass") return done("no_change", { review: flag, reasons: [] });
  }
  addMarked(marked, input.draft, flag.spots || []);
  const reasons = [...(flag.reasons || []), ...(flag.notes || []), ...deps.lint(input.draft)];

  // 1. Fix: another model revises; every check runs again.
  const rev = await deps.revise(input.draft, reasons);
  spend(rev.model, rev.usage);
  steps.push(`revised by ${rev.model}`);
  let d = rev.draft;
  let checks = await deps.check(d, rev.trimmed || []);
  // A hard wording rule the revision still breaks is cut, not published.
  const hard = deps.hard(d);
  let summaryBad = hard.some((s) => s.field === "plain_summary");
  if (hard.length) {
    const t = trimDraft(d, hard);
    d = t.draft;
    removed.push(...t.removed);
    steps.push(`wording rules: ${hard.length} passage(s) cut`);
  }
  let r = await review(d, depth);
  if (!summaryBad && r.verdict === "pass" && !containsMarked(d, marked) && useful(d)) {
    return done(removed.length ? "trimmed" : "fixed", { draft: d, review: r, reasons, checks, model: rev.model });
  }

  // 2. Trim what the reviews marked.
  if (r.verdict !== "pass" || containsMarked(d, marked)) {
    const t = trimDraft(d, [...(r.spots || []), ...markedSpots(d, marked)]);
    summaryBad = summaryBad || t.summaryHit;
    if (!summaryBad && !t.panelsGone && !t.unlocated && !unlocatedChecks(r).length && useful(t.draft)) {
      const r2 = await review(t.draft, depth);
      if (r2.verdict === "pass" && !containsMarked(t.draft, marked)) {
        removed.push(...t.removed);
        return done("trimmed", { draft: t.draft, review: r2, reasons, checks, model: rev.model });
      }
    }
  }

  // 3. The summary and provisions only.
  if (!summaryBad) {
    let s = summaryOnly(d);
    const clauseSpots = markedSpots(s, marked).filter((x) => x.field === "clauses");
    if (clauseSpots.length) s = trimDraft(s, clauseSpots).draft;
    if (!containsMarked(s, marked) && String(s.plain_summary).trim()) {
      const r3 = await review(s, "summary");
      if (r3.verdict === "pass" && !containsMarked(s, marked)) {
        removed.push(...itemsOf(d).filter((i) => !["plain_summary", "clauses"].includes(i.field)));
        return done("summary_only", { draft: s, review: r3, reasons, checks, model: rev.model });
      }
    }
  }
  return done("withheld", { review: r, reasons, checks, model: rev.model });
}

// ---------------------------------------------------------------------------
// The public wording of what changed (code-written, the same for everyone).

const CHECK_WORDS = {
  summary: "a possible error in the summary",
  balance: "one side treated less fairly than the other",
  language: "opinion stated as fact, or loaded wording",
  provisions: "a provision that didn't fit",
  certainty: "more certainty than the sources support",
};
const FIELD_WORDS = {
  clauses: "a provision",
  aligns: "the three panels",
  tension: "the three panels",
  departure: "the three panels",
  readings: "the readings",
  citations: "a case",
  supporters: 'the "Supporters argue" and "Critics argue" lines',
  critics: 'the "Supporters argue" and "Critics argue" lines',
  uncertainty: "the note on what this analysis can't tell you",
  article_v: "the Article V note",
};

/** One plain sentence on what changed and why. Pure. */
export function changeNote(result, { reader = false, flagReview = null } = {}) {
  const lead = reader ? "After a reader's report, an AI re-check " : "An AI re-check ";
  const found = [...new Set(((flagReview || result.flagReview || result.review || {}).checks || []).filter((c) => !c.ok && c.severity === "major").map((c) => CHECK_WORDS[c.id]).filter(Boolean))];
  const why = found.length ? `found ${found.join("; ")}` : "found a problem";
  if (result.outcome === "fixed") return `${lead}${why}; the analysis was rewritten to fix it and checked again.`;
  if (result.outcome === "trimmed") {
    const parts = [...new Set(result.removed.map((x) => FIELD_WORDS[x.field] || "a passage"))];
    return `${lead}${why}; the flagged passages were removed (${parts.join(", ")}) and the rest checked again.`;
  }
  if (result.outcome === "summary_only") return `${lead}${why}; only the summary and the provisions it touches are shown. Full analysis not available yet.`;
  if (result.outcome === "withheld") return `${lead}${why} that couldn't be fixed, so the analysis was taken down.`;
  return "";
}

// Cost, in cents, from the tokens a call used: the shared price table (src/ai-usage.js).
export { PRICES, centsFor } from "../ai-usage.js";
