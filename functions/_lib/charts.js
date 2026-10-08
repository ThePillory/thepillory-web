// Small charts for the Functions' pages, as plain HTML and CSS (styles in
// assets/pillory.css, "Components"). Every chart also says its numbers in
// words, so nothing depends on seeing the colors. Pure: no D1, no network.
import { esc } from "./render.js";

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const width = (part, whole) => (whole > 0 ? `${Math.max(0, (part / whole) * 100).toFixed(2)}%` : "0%");

/**
 * Yes/no vote bar: a vote's recorded totals as one bar, with the counts in
 * words above it. Yes and No get the bar; Present and Not voting are counted
 * in the note. Returns "" when the source gave no totals.
 */
export function voteBar(v, { note = true } = {}) {
  const yea = num(v.yea);
  const nay = num(v.nay);
  if (yea == null && nay == null) return "";
  const present = num(v.present) || 0;
  const nv = num(v.not_voting) || 0;
  const total = (yea || 0) + (nay || 0) + present + nv;
  const other = present + nv;
  const extra = [present ? `Present ${present}` : "", nv ? `Not voting ${nv}` : ""].filter(Boolean).join(" · ");
  return `<div class="vote-bar" role="img" aria-label="Yes ${yea ?? 0}, No ${nay ?? 0}${extra ? `, ${extra}` : ""}">
  <div class="vote-bar-labels" aria-hidden="true"><span class="vb-yes">Yes ${yea ?? "–"}</span><span class="vb-no">No ${nay ?? "–"}</span></div>
  <div class="vote-bar-track" aria-hidden="true"><span class="vb-seg-yes" style="width:${width(yea || 0, total)}"></span>${other ? `<span class="vb-seg-other" style="width:${width(other, total)}"></span>` : ""}<span class="vb-seg-no" style="width:${width(nay || 0, total)}"></span></div>
  ${note && extra ? `<p class="vote-bar-note">${extra}</p>` : ""}
</div>`;
}

/**
 * A breakdown bar with its legend: parts of a whole (for example, where a
 * campaign's money came from). `parts`: [{label, value}], in the order to
 * show; `format` writes an amount. Each row gives the amount and the share.
 */
export function breakdownBar(parts, { total = null, format = (n) => String(n), label = "" } = {}) {
  const rows = parts.filter((p) => num(p.value) != null);
  const whole = num(total) ?? rows.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (!rows.length || !(whole > 0)) return "";
  const share = (v) => `${Math.round((Math.max(0, v) / whole) * 100)}%`;
  const color = (i) => `c${Math.min(i + 1, 6)}`;
  return `<div class="breakdown">
  <div class="breakdown-track" role="img" aria-label="${esc(label || "Breakdown")}: ${esc(rows.map((p) => `${p.label} ${share(p.value)}`).join(", "))}">${rows
    .map((p, i) => (p.value > 0 ? `<span class="${color(i)}" style="width:${width(p.value, whole)}"></span>` : ""))
    .join("")}</div>
  <ul class="breakdown-legend">${rows
    .map((p, i) => `<li><span class="dot ${color(i)}" aria-hidden="true"></span><span class="bl-name">${esc(p.label)}</span><span class="bl-amt">${format(p.value)}</span><span class="bl-pct">${share(p.value)}</span></li>`)
    .join("")}</ul>
</div>`;
}

/**
 * A small bar chart: one bar per period (`points`: [{label, value, tick}]),
 * with a table of the values under a "Show the numbers" toggle. Negative
 * values are drawn gray, from the same baseline, with their size.
 */
export function miniBars(points, { format = (n) => String(n), caption = "", ariaLabel = "", head = ["Period", "Value"] } = {}) {
  const pts = points.filter((p) => num(p.value) != null);
  if (pts.length < 2) return "";
  const maxPos = Math.max(0, ...pts.map((p) => p.value));
  const maxNeg = Math.max(0, ...pts.map((p) => -p.value));
  const range = maxPos + maxNeg;
  if (!(range > 0)) return "";
  // Values above zero rise from the zero line; values below it hang under it.
  const up = (maxPos / range) * 100;
  const bars = pts
    .map((p) => {
      return `<span title="${esc(p.label)}: ${esc(format(p.value))}"><b style="height:${up.toFixed(2)}%">${p.value > 0 ? `<i style="height:${width(p.value, maxPos)}"></i>` : ""}</b><b class="is-below" style="height:${(100 - up).toFixed(2)}%">${p.value < 0 ? `<i class="is-neg" style="height:${width(-p.value, maxNeg)}"></i>` : ""}</b></span>`;
    })
    .join("");
  const axis = pts.map((p) => `<span>${esc(p.tick ?? "")}</span>`).join("");
  return `<figure class="mini-bars">
  <div class="mini-bars-plot${maxNeg && maxPos ? " has-zero" : ""}" role="img" aria-label="${esc(ariaLabel || caption)}">${bars}</div>
  <div class="mini-bars-axis" aria-hidden="true">${axis}</div>
  ${caption ? `<figcaption class="xsmall secondary">${caption}</figcaption>` : ""}
  <details class="mini-bars-table"><summary>Show the numbers</summary><table><thead><tr><th scope="col">${esc(head[0])}</th><th scope="col">${esc(head[1])}</th></tr></thead><tbody>${pts
    .map((p) => `<tr><th scope="row">${esc(p.label)}</th><td>${esc(format(p.value))}</td></tr>`)
    .join("")}</tbody></table></details>
</figure>`;
}
