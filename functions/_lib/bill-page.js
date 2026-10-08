// The pieces of a bill page, summary first (functions/laws/[[path]].js):
// its status, its two-sentence summary and where that comes from, the "Your
// reps" card, the history timeline and the full-text links. Pure: the page
// loads the data. Every line is a recorded fact with its source.
import { esc, fmtDate, sourceLink, safeUrl } from "./render.js";
import { CHAMBER_NAME } from "./data.js";
import { voteBar } from "./charts.js";
import { OUTCOME_LABEL } from "./executive.js";
import { firstSentences, statusChip, outLink } from "./summary.js";
import { METHOD_URL } from "./analysis.js";

const LEGISLATURE = { federal: ["us-house", "us-senate"], state: ["ca-assembly", "ca-senate"] };

/** The bill's status in a few words: its final action when recorded, else its latest final-passage vote. */
export function billStatus(b, outcome, votes) {
  const o = outcome && outcome.outcome;
  if (o && o.outcome === "presented") return `Presented to ${b.level === "federal" ? "the President" : "the Governor"} · ${fmtDate(o.action_date)}`;
  if (o) return `${OUTCOME_LABEL[o.outcome] || o.outcome} · ${fmtDate(o.action_date)}`;
  const finals = (votes || []).filter((v) => v.vote_type === "final_passage");
  if (finals[0]) return `${finals[0].result} · ${CHAMBER_NAME[finals[0].chamber] || "Final"} vote · ${fmtDate(finals[0].vote_date)}`;
  if ((votes || [])[0]) return `Last recorded vote · ${fmtDate(votes[0].vote_date)}`;
  return "";
}

/** Where an official summary's "what it does" begins ("This bill …"), or -1. */
function whatItDoes(text) {
  return String(text || "").search(/\bThis (bill|measure|joint resolution|concurrent resolution|resolution) (would |)[a-z]/);
}

/**
 * The two-sentence summary at the top, word for word from its source, in this
 * order: a summary a person wrote; the official summary (Congress.gov's CRS
 * summary, from its "This bill …" sentence; or the Legislative Counsel's Digest,
 * from "This bill would …"); the checked analysis's own summary, labeled as
 * AI-drafted. Returns {text, source} (source is HTML) or null.
 */
export function billSummary(b, a) {
  if (b.summary && b.summary.trim()) return { text: firstSentences(b.summary, 2), source: "Summary written by ThePillory from the bill text." };
  const off = String(b.official_summary || "");
  const label = String(b.official_summary_label || "");
  const crs = /^CRS summary/i.test(label);
  const digest = /Legislative Counsel/i.test(label);
  if (off && (crs || digest)) {
    const at = whatItDoes(off);
    // The digest opens with existing law; only its "This bill would …" part says what the bill does.
    if (at >= 0 || crs) {
      const text = firstSentences(at >= 0 ? off.slice(at) : off, 2);
      const where = crs ? "the Congressional Research Service's summary" : "the Legislative Counsel's Digest";
      const link = safeUrl(b.official_summary_url);
      return { text, source: `First two sentences of ${where}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">${crs ? "Congress.gov" : "leginfo"} ↗</a>` : ""}` };
    }
  }
  if (a && a.plain_summary) {
    return { text: firstSentences(a.plain_summary, 2), source: `From the constitutional analysis · <a href="${METHOD_URL}">AI-drafted, ${a.status === "reviewed" ? "reviewed by a person" : "auto-checked"}</a>` };
  }
  return null;
}

/**
 * "Your reps": the visitor's legislators' final-passage votes on the bill, and
 * one vote bar for the latest final vote. Without districts, how to find them.
 */
export function yourRepsCard(b, { districts, reps, votes, failed = false }) {
  const finals = (votes || []).filter((v) => v.vote_type === "final_passage");
  const latest = finals[0];
  const bar = latest
    ? `<p class="small">Latest final vote: <strong>${esc(latest.result)}</strong> · ${esc(CHAMBER_NAME[latest.chamber] || "")} · ${fmtDate(latest.vote_date)}</p>
  ${voteBar(latest)}
  ${sourceLink(latest.source_url, "Official record")}`
    : '<p class="small secondary">No final-passage vote is recorded on this bill.</p>';
  let rows;
  if (failed) rows = '<p class="small secondary">Couldn\'t load your reps right now.</p>';
  else if (!districts) rows = '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.</p>';
  else {
    const mine = (reps || []).filter((o) => LEGISLATURE[b.level].includes(o.chamber));
    rows = mine.length
      ? `<div class="stack-xs">${mine
          .map((o) => {
            const v = finals.find((x) => x.positions.some((p) => p.slug === o.slug));
            const p = v && v.positions.find((x) => x.slug === o.slug);
            return `<div class="rep-vote"><span><a href="/reps/${esc(o.slug)}/">${esc(o.name)}</a><br><span class="xsmall secondary">${esc(o.office)}${o.district ? ` · ${esc(o.district)}` : ""}</span></span>${
              p ? `<span class="position" title="Recorded as: ${esc(p.raw_position)}${v ? ` on ${esc(v.question)}, ${fmtDate(v.vote_date)}` : ""}">${esc(p.position)}</span>` : '<span class="xsmall secondary">No final vote recorded</span>'
            }</div>`;
          })
          .join("")}</div>`
      : `<p class="small secondary">None of your reps sits in ${b.level === "federal" ? "Congress" : "the California Legislature"}.</p>`;
  }
  return `<section class="card stack-sm reps-card" id="your-reps">
  <h2 class="label">Your reps</h2>
  ${rows}
  ${bar}
</section>`;
}

/** The history: every recorded vote and the final action, oldest first. */
export function billHistory(b, outcome, votes) {
  const items = (votes || []).map((v) => ({ date: v.vote_date, text: `${CHAMBER_NAME[v.chamber] || ""}: ${v.question} · ${v.result}`, url: v.source_url }));
  const o = outcome && outcome.outcome;
  if (o && o.presented_on && o.outcome !== "presented") items.push({ date: o.presented_on, text: `Presented to ${b.level === "federal" ? "the President" : "the Governor"}`, url: o.source_url });
  if (o) items.push({ date: o.action_date, text: o.outcome === "presented" ? `Presented to ${b.level === "federal" ? "the President" : "the Governor"}` : `${OUTCOME_LABEL[o.outcome] || o.outcome}${o.law_number ? ` · ${o.law_number}` : ""}`, url: o.source_url });
  items.sort((x, y) => String(x.date).localeCompare(String(y.date)));
  if (!items.length) return '<p class="small secondary">Nothing recorded yet.</p>';
  return `<ol class="timeline">${items
    .map((i) => `<li><span class="tl-date">${fmtDate(i.date)}</span><span>${esc(i.text)}${safeUrl(i.url) ? ` <a class="inline-link" href="${esc(i.url)}" target="_blank" rel="noopener" aria-label="Source">↗</a>` : ""}</span></li>`)
    .join("")}</ol>
  <p class="hint">Recorded votes on this bill and the final action, as their sources record them. Committee and other steps without a recorded vote aren't listed; the official page has every action.</p>`;
}

/** The bill's full text at its official source, and the official summary in full. */
export function billFullText(b, a) {
  const official = safeUrl(b.official_url);
  let textUrl = null;
  if (b.level === "federal" && official && /congress\.gov\/bill\//.test(official)) textUrl = `${official.replace(/\/+$/, "")}/text`;
  if (b.level === "state") {
    const id = `${b.session}0${String(b.bill_number || "").replace(/\s+/g, "")}`;
    textUrl = `https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=${encodeURIComponent(id)}`;
  }
  const off = b.official_summary && /^(CRS summary|Legislative Counsel)/i.test(String(b.official_summary_label || ""))
    ? `<div class="stack-sm"><p class="label">${esc(/^CRS/i.test(b.official_summary_label) ? "Official summary (Congressional Research Service)" : "Legislative Counsel's Digest")}</p><p class="small">${esc(b.official_summary)}</p>${sourceLink(b.official_summary_url, "Source")}</div>`
    : "";
  const read = a && safeUrl(a.text_source_url) ? `<p class="hint">The constitutional analysis read ${esc(a.text_version || "the bill text")} (<a class="inline-link" href="${esc(a.text_source_url)}" target="_blank" rel="noopener">source ↗</a>).</p>` : "";
  return `${textUrl ? outLink(textUrl, b.level === "federal" ? "Full text on Congress.gov" : "Full text on leginfo") : ""}
  ${official ? outLink(official, "Official bill page") : sourceLink(b.source_url)}
  ${off}
  ${read}`;
}

export { statusChip };
