// Vote display. Votes are shown as facts: the bill, the exact question, the
// position, the result, the date, and a source link. No scores, grades, or
// "voted against X" summaries, and positions are styled the same whatever
// they are.
import { esc, fmtDate, sourceLink } from "./render.js";
import { TYPE_LABELS, CHAMBER_NAME } from "./data.js";
import { voteBar } from "./charts.js";

export function billHref(id) {
  return `/laws/bills/${encodeURIComponent(id)}/`;
}

function what(v) {
  if (v.bill_id && v.bill_number) {
    return `<a class="inline-link vote-bill" href="${billHref(v.bill_id)}">${esc(v.bill_number)}</a>
      ${v.bill_title ? `<p class="small">${esc(v.bill_title)}</p>` : ""}`;
  }
  return `<p class="vote-bill-text">${esc(v.subject || "Not tied to a bill")}</p>`;
}

function typeTag(v) {
  return v.vote_type === "final_passage" ? "" : `<span class="type-tag">${esc(TYPE_LABELS[v.vote_type] || "Other")}</span>`;
}

// One row in a rep's Votes tab.
export function voteRow(v) {
  return `
<li class="vote-row">
  <div class="vote-main">
    ${what(v)}
    <p class="vote-question">${esc(v.question)}</p>
    <p class="list-meta">${fmtDate(v.vote_date)} · Result: ${esc(v.result)} ${typeTag(v)}</p>
  </div>
  <div class="vote-side">
    <span class="position" title="Recorded as: ${esc(v.raw_position)}">${esc(v.position)}</span>
    ${sourceLink(v.source_url)}
  </div>
</li>`;
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
