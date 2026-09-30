// The constitutional analysis block on a bill page (and its preview in /admin/review).
// Quotes are always shown from the stored Constitution text in D1: a clause's
// quote is shown only if it appears word for word in that provision; otherwise
// the provision's full stored text is shown instead.
//
// What the public sees:
//   - approved by a person: "Reviewed by [name], [date]"
//   - passed by the AI reviewer: "AI-drafted, auto-checked" (linked to the methodology)
//   - flagged by the AI reviewer, or not reviewed yet: nothing (it's in the review queue)
//   - rejected: nothing
// A published analysis with open reader flags stays up, marked "Under review".
import { esc, safeUrl, fmtDate } from "./render.js";

export const METHOD_URL = "/about/methodology/#analysis";

export async function currentAnalysis(db, billId) {
  return db
    .prepare("SELECT * FROM bill_analyses WHERE bill_id = ? AND current = 1 AND status != 'rejected'")
    .bind(billId)
    .first();
}

/** Shown on public pages: approved by a person, or passed by the AI reviewer. */
export function isPublic(a) {
  return Boolean(a) && (a.status === "reviewed" || (a.status === "ai_draft" && a.ai_review === "pass"));
}

export async function openFlagCount(db, analysisId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM analysis_flags WHERE analysis_id = ? AND status = 'open'").bind(analysisId).first();
  return r ? r.n : 0;
}

export async function provisionsFor(db, ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return new Map();
  const { results } = await db
    .prepare(`SELECT id, label, text FROM constitution_provisions WHERE id IN (${list.map(() => "?").join(",")})`)
    .bind(...list)
    .all();
  return new Map(results.map((r) => [r.id, r]));
}

export function parse(a) {
  const j = (s, d) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      return d;
    }
  };
  return {
    ...a,
    clauses: j(a.clauses, []),
    aligns: j(a.aligns, []),
    tension: j(a.tension, []),
    departure: j(a.departure, []),
    readings: j(a.readings, []),
    citations: j(a.citations, []),
    quote_check: j(a.quote_check, {}),
    citation_check: j(a.citation_check, {}),
    ai_review_detail: j(a.ai_review_detail, {}),
  };
}

const norm = (s) =>
  String(s || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** The quote if it's word for word from the stored text (ellipses allowed), else null. */
export function storedQuote(quote, text) {
  const t = norm(text);
  const pieces = norm(quote)
    .replace(/^["'\s.…]+|["'\s…]+$/g, "")
    .split(/\s*(?:\.\s?\.\s?\.|…)\s*/)
    .filter(Boolean);
  if (!pieces.length) return null;
  let from = 0;
  for (const p of pieces) {
    const i = t.indexOf(p, from);
    if (i < 0) return null;
    from = i + p.length;
  }
  return norm(quote).replace(/^["']+|["']+$/g, "");
}

export function badge(a, link = true) {
  if (a.status === "reviewed") {
    return `<span class="review-badge review-badge--reviewed">Reviewed by ${esc(a.reviewer)}, ${fmtDate(a.reviewed_at)}</span>`;
  }
  if (a.status === "rejected") return '<span class="review-badge">Rejected</span>';
  if (a.ai_review === "pass") {
    return link ? `<a class="review-badge review-badge--auto" href="${METHOD_URL}">AI-drafted, auto-checked</a>` : '<span class="review-badge review-badge--auto">AI-drafted, auto-checked</span>';
  }
  if (a.ai_review === "flag") return '<span class="review-badge review-badge--flag">Flagged by the AI reviewer</span>';
  return '<span class="review-badge review-badge--draft">AI-drafted, waiting for the AI reviewer</span>';
}

const UNDER_REVIEW = '<span class="review-badge review-badge--flag">Under review</span>';

const items = (list) => (list.length ? `<ul class="panel-list">${list.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "");
// A card has one sentence per panel: a paragraph, not a one-item list.
const panel = (list, card) => (card && list.length === 1 ? `<p class="small">${esc(list[0])}</p>` : items(list));

/**
 * The parchment "Constitutional baseline" section. `a` is a parsed analysis
 * row or null. Options:
 *   underReview  reader flags are open: mark it "Under review"
 *   empty        what to say when there's no public analysis (HTML)
 *   after        extra HTML at the end (the reader forms)
 */
export function baselineSection(a, provisions, { underReview = false, empty = "", after = "" } = {}) {
  if (!a) {
    return `
<section class="parchment stack-sm" id="baseline">
  <h2 class="label">Constitutional baseline</h2>
  ${empty || "<p>Not yet mapped. The parts of the Constitution this bill touches will appear here once an analysis is written and checked.</p>"}
  <p class="baseline-foot"><a class="inline-link" href="${METHOD_URL}">How this is made</a></p>
  ${after}
</section>`;
  }
  const card = a.depth === "card";
  const clauses = a.clauses
    .map((c) => {
      const p = provisions.get(c.id);
      if (!p) return "";
      const q = c.quote && storedQuote(c.quote, p.text);
      return `
<div class="provision-cite">
  <a class="label" href="/laws/constitution/#${esc(p.id)}">${esc(p.label)}</a>
  <blockquote class="quote">“${esc(q || p.text)}”</blockquote>
  ${c.why ? `<p class="small">${esc(c.why)}</p>` : ""}
</div>`;
    })
    .join("");
  const readings = a.readings.length
    ? `
<div class="stack-sm">
  <h3>How different approaches read it</h3>
  <p class="small">For contested questions only. Each reading is described in its own terms; none is presented as correct.</p>
  ${a.readings
    .map(
      (r) => `
  <div class="reading stack-sm">
    <h4>${esc(r.question)}</h4>
    <div class="readings">
      <div class="reading-col"><p class="label">Original meaning</p><p class="small">${esc(r.original_meaning) || "—"}</p></div>
      <div class="reading-col"><p class="label">Precedent</p><p class="small">${esc(r.precedent) || "—"}</p></div>
      <div class="reading-col"><p class="label">Evolving interpretation</p><p class="small">${esc(r.evolving) || "—"}</p></div>
    </div>
  </div>`
    )
    .join("")}
</div>`
    : "";
  const cases = a.citations.length
    ? `
<div class="stack-sm">
  <h3>Cases cited</h3>
  <ul class="panel-list">${a.citations
    .map((c) => {
      const u = safeUrl(c.url);
      const name = `<cite>${esc(c.case_name)}</cite>, ${esc(c.citation)}`;
      return `<li>${u ? `<a class="tap" href="${esc(u)}" target="_blank" rel="noopener">${name} ↗</a>` : name}${c.point ? `<br><span class="small">${esc(c.point)}</span>` : ""}</li>`;
    })
    .join("")}</ul>
  <p class="small">Each case was found in CourtListener under the same name. Cases that couldn't be verified were removed.</p>
</div>`
    : "";
  const src = safeUrl(a.text_source_url);
  return `
<section class="parchment stack baseline-wide" id="baseline">
  <div class="baseline-head">
    <h2 class="label">Constitutional baseline${card ? " · Short card" : ""}</h2>
    <div class="chips">${badge(a)}${underReview ? UNDER_REVIEW : ""}</div>
  </div>
  ${underReview ? '<p class="small">A reader reported a possible problem with this analysis. It stays up while a person checks it.</p>' : ""}
  ${a.basis_note ? `<p class="limited-note">${esc(a.basis_note.replace(/^limited:/i, "Limited:"))}</p>` : ""}
  <div class="stack-sm">
    <h3>What the bill does</h3>
    <p>${esc(a.plain_summary)}</p>
  </div>
  ${clauses ? `<div class="stack-sm"><h3>Provisions it touches</h3>${clauses}</div>` : ""}
  <div class="baseline-panels">
    <div class="panel"><p class="label">Where it aligns</p>${panel(a.aligns, card) || '<p class="small">None identified.</p>'}</div>
    <div class="panel panel--tension"><p class="label">Where it may be in tension</p>${panel(a.tension, card) || '<p class="small">None identified.</p>'}</div>
    <div class="panel"><p class="label">Why this might still serve the public</p>${panel(a.departure, card) || '<p class="small">No departure identified.</p>'}
      ${a.article_v ? `<p class="small"><strong>Article V:</strong> ${esc(a.article_v)}</p>` : ""}</div>
  </div>
  ${readings}
  ${cases}
  ${a.uncertainty ? `<div class="stack-sm"><h3>What this analysis can't tell you</h3><p class="small">${esc(a.uncertainty)}</p></div>` : ""}
  <p class="small baseline-foot">
    Mapped, not ruled: this is not a finding on whether the bill is constitutional.
    ${card ? "This is a short card: the most relevant provisions, one sentence each. " : ""}${src ? `Based on <a class="tap" href="${esc(src)}" target="_blank" rel="noopener">${esc(a.text_version || "the bill text")} ↗</a>.` : ""}
    Drafted ${fmtDate(a.created_at)} with ${esc(a.model)}${a.status !== "reviewed" && a.ai_review === "pass" ? `, checked by a separate AI reviewer${a.ai_review_model ? ` (${esc(a.ai_review_model)})` : ""}` : ""}.
    <br><a class="inline-link" href="${METHOD_URL}">How this is made</a>
  </p>
  ${after}
</section>`;
}
