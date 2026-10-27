// Vote display. Votes are shown as facts: the bill, the exact question, the
// position, the result, the date, and a source link. No scores, grades, or
// "voted against X" summaries, and positions are styled the same whatever
// they are.
import { esc, fmtDate, safeUrl } from "./render.js";
import { TYPE_LABELS, CHAMBER_NAME } from "./data.js";
import { voteBar } from "./charts.js";

export function billHref(id) {
  return `/laws/bills/${encodeURIComponent(id)}/`;
}

function typeTag(v) {
  return v.vote_type === "final_passage" ? "" : `<span class="type-tag">${esc(TYPE_LABELS[v.vote_type] || "Other")}</span>`;
}

/**
 * One recorded position as one compact row, the same everywhere a list of
 * votes appears: line 1 the title with the position on the right, line 2 the
 * details. The whole row is one link (the bill's votes, or the official record
 * when the vote isn't tied to a bill), so it stays one tap target. title and
 * details are HTML, already escaped.
 */
export function positionRow({ href, title, details, position, raw }) {
  const out = !href.startsWith("/");
  return `
<li><a class="list-row link-row" href="${esc(href)}"${out ? ' target="_blank" rel="noopener"' : ""}>
  <div><span class="list-title">${title}</span><span class="list-meta">${details}${out ? " · Source ↗" : ""}</span></div>
  <span class="list-status row-position" title="Recorded as: ${esc(raw)}">${esc(position)}</span>
</a></li>`;
}

/** Where a vote's row links: the bill's votes, else the official record. */
export function voteHref(v, fallback = "") {
  return v.bill_id ? `${billHref(v.bill_id)}#votes` : safeUrl(v.source_url) || fallback;
}

// One row in a rep's Votes tab: the bill, then the exact question, result and date.
export function voteRow(v) {
  const title = v.bill_number ? `${esc(v.bill_number)}${v.bill_title ? `: ${esc(v.bill_title)}` : ""}` : esc(v.subject || "Not tied to a bill");
  return positionRow({
    href: voteHref(v, "#votes"),
    title,
    details: `${esc(v.question)} · Result: ${esc(v.result)} · ${fmtDate(v.vote_date)} ${typeTag(v)}`,
    position: v.position,
    raw: v.raw_position,
  });
}

// One vote on a bill page: the question, result, totals, and (when the
// visitor's districts are known) their reps' positions. The official record
// lists every member.
export function billVote(v, { personal = false } = {}) {
  const rows = v.positions
    .map(
      (p) => `
    <li class="position-row">
      <a class="inline-link" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a>
      <span class="list-meta">${esc(p.office)}${p.district ? ` · ${esc(p.district)}` : ""}</span>
      <span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span>
    </li>`
    )
    .join("");
  return `
<article class="card stack-sm bill-vote">
  <p class="label">${esc(CHAMBER_NAME[v.chamber] || v.chamber || "")} · ${fmtDate(v.vote_date)} ${typeTag(v)}</p>
  <p class="vote-question">${esc(v.question)}</p>
  <p class="small">Result: ${esc(v.result)}</p>
  ${voteBar(v)}
  ${rows ? `<ul class="plain-list positions">${rows}</ul>` : personal ? '<p class="small secondary">None of your reps cast a recorded vote on this.</p>' : ""}
  ${sourceLink(v.source_url, "Official record")}
</article>`;
}

/** "Yes 216 · No 214 · Present 0 · Not voting 3", in one neutral style, or "". */
export function tallyText(v) {
  if (v.yea == null && v.nay == null) return "";
  const parts = [["Yes", v.yea], ["No", v.nay], ["Present", v.present], ["Not voting", v.not_voting]].filter(([, n]) => n != null);
  return parts.map(([k, n]) => `${k} <strong>${n}</strong>`).join(" · ");
}

// Final passage only (default) or everything, as two plain links so it works without JS.
export function voteFilter(baseHref, all, counts) {
  const finalN = counts ? counts.final || 0 : null;
  const allN = counts ? counts.total || 0 : null;
  return `
<nav class="segmented vote-filter" aria-label="Which votes to show">
  <a class="toggle" href="${esc(baseHref)}"${all ? "" : ' aria-current="true"'}>Final passage${finalN != null ? ` (${finalN})` : ""}</a>
  <a class="toggle" href="${esc(baseHref)}${baseHref.includes("?") ? "&" : "?"}votes=all#votes"${all ? ' aria-current="true"' : ""}>All votes${allN != null ? ` (${allN})` : ""}</a>
</nav>
<p class="hint">${
    all
      ? "Showing every recorded vote. Procedural, amendment, committee, and nomination votes are labeled."
      : "Showing final-passage votes only. Choose “All votes” to include procedural and other votes, clearly labeled."
  }</p>`;
}
