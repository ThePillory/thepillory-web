// "Summary first, depth on tap": the shared pieces of every detail page.
//   summaryHead   the top of a page, which fits one phone screen: a status line,
//                 the title, a two-sentence summary (with where it comes from),
//                 and "Touches the Constitution" chips
//   contentsBar   a small bar at the top of a long page to jump between sections
//   fold          a section collapsed until tapped (<details>; a link to its id
//                 opens it, see openTarget() in assets/app.js)
//   compactRow    one line in a list: type, title, status, and the clause it touches
// Styles: assets/pillory.css, "Summary first". Pure: no D1, no network.
import { esc, safeUrl } from "./render.js";

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20, XXI: 21, XXII: 22, XXIII: 23, XXIV: 24, XXV: 25, XXVI: 26, XXVII: 27 };
const ord = (n) => {
  const v = n % 100;
  return n + (v >= 11 && v <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
};

/**
 * A provision's label, short enough for a chip: "Article I, Section 8, Clause 3"
 * → "Art. I, §8, cl. 3"; "Amendment XIV, Section 1" → "14th Amendment, §1".
 */
export function shortLabel(label) {
  const s = String(label || "");
  const am = /^Amendment ([IVXL]+)(?:, Section (\d+))?(?:, Clause (\d+))?$/.exec(s);
  if (am) return `${ROMAN[am[1]] ? ord(ROMAN[am[1]]) : am[1]} Amendment${am[2] ? `, §${am[2]}` : ""}${am[3] ? `, cl. ${am[3]}` : ""}`;
  return s.replace(/^Article /, "Art. ").replace(/, Section (\d+)/, ", §$1").replace(/, Clause (\d+)/, ", cl. $1");
}

export const clauseHref = (id) => `/laws/constitution/#${encodeURIComponent(id)}`;

/**
 * "Touches the Constitution": a parchment chip per provision, each linking to
 * that clause on the Constitution page. `items`: [{id, label}].
 */
export function clauseChips(items, { label = true } = {}) {
  const list = (items || []).filter((p) => p && p.id && p.label);
  if (!list.length) return "";
  return `<div class="clause-chips">${label ? '<p class="label">Touches the Constitution</p>' : ""}<div class="chips">${list
    .map((p) => `<a class="chip chip--parch chip--tap" href="${clauseHref(p.id)}">${esc(shortLabel(p.label))}</a>`)
    .join("")}</div></div>`;
}

/**
 * The first `n` sentences of a text, word for word (a sentence ends at ". ",
 * "? " or "! " before a capital letter or a quote; "U.S." and "Sec." don't end one).
 */
export function firstSentences(text, n = 2) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const out = [];
  let start = 0;
  const re = /[.!?]["”’)]?\s+(?=["“(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(t)) && out.length < n) {
    const end = m.index + m[0].trimEnd().length;
    const piece = t.slice(start, end);
    // Abbreviations that don't end a sentence.
    if (/\b(?:U\.S|Sec|No|Nos|Mr|Mrs|Ms|Dr|St|Jr|Sr|Inc|Co|Corp|Gov|Rep|Sen|Stat|Pub|L|U\.S\.C|e\.g|i\.e|etc|vs|v|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec|[A-Z])\.$/.test(piece)) continue;
    out.push(piece.trim());
    start = m.index + m[0].length;
  }
  if (out.length < n && start < t.length) out.push(t.slice(start).trim());
  return out.join(" ");
}

/**
 * The top of a detail page. `status`: short HTML (a chip or a line); `kicker`:
 * the small label above the title; `summary`: {text, source} where source is
 * HTML saying where the summary comes from (or null for no summary yet, with
 * `none` said instead); `chips`: clauseChips() HTML; `extra`: HTML after it.
 */
export function summaryHead({ kicker = "", status = "", title, summary = null, none = "", chips = "", extra = "" }) {
  return `<header class="summary-head" id="summary">
  ${kicker ? `<p class="label">${kicker}</p>` : ""}
  ${status ? `<div class="summary-status">${status}</div>` : ""}
  <h1>${esc(title)}</h1>
  ${
    summary && summary.text
      ? `<p class="summary-text">${esc(summary.text)}</p>${summary.source ? `<p class="summary-source">${summary.source}</p>` : ""}`
      : none
        ? `<p class="summary-source">${none}</p>`
        : ""
  }
  ${chips}
  ${extra}
</header>`;
}

/** A status chip: one neutral style whatever the status says. */
export const statusChip = (text) => (text ? `<span class="status-chip">${esc(text)}</span>` : "");

/**
 * The contents bar: links to the page's sections. `items`: [[id, label]] (empty
 * labels skipped). Shown only on long pages (three or more sections).
 */
export function contentsBar(items) {
  const list = items.filter(([id, label]) => id && label);
  if (list.length < 3) return "";
  return `<nav class="contents-bar" aria-label="On this page">${list.map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`).join("")}</nav>`;
}

/**
 * A section collapsed until tapped. `meta`: a short note beside the title (a
 * count, a date); `open`: start open (for example when the page was asked
 * for a later page of the list inside it).
 */
export function fold(id, title, inner, { meta = "", open = false, cls = "" } = {}) {
  return `<details class="fold${cls ? ` ${cls}` : ""}" id="${esc(id)}"${open ? " open" : ""}>
  <summary><span class="fold-title">${esc(title)}</span>${meta ? `<span class="fold-meta">${esc(meta)}</span>` : ""}</summary>
  <div class="fold-body stack">${inner}</div>
</details>`;
}

/**
 * One line in a list page: type (H.R. 40, EO 14160), title, status, and the
 * first constitutional clause it touches (from a checked analysis). Links to
 * the item's page.
 */
export function compactRow({ href, type, title, status = "", clause = null, meta = "" }) {
  return `<a class="compact-row" href="${esc(href)}">
  <span class="cr-type">${esc(type)}</span>
  <span class="cr-main"><span class="cr-title">${esc(title)}</span><span class="cr-meta">${[status ? esc(status) : "", meta ? esc(meta) : ""].filter(Boolean).join(" · ")}</span>${
    clause ? `<span class="cr-clause">${esc(shortLabel(clause.label))}</span>` : ""
  }</span>
  <span class="chev" aria-hidden="true">›</span>
</a>`;
}

/** An outside link as a small button-like row ("Full text on Congress.gov ↗"). */
export function outLink(url, label) {
  const u = safeUrl(url);
  return u ? `<a class="out-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "";
}
