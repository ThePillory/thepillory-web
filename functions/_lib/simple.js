// Quick mode (the Quick / Detailed switch under the header; assets/app.js):
// a short card at the top of a page in plain words, shown only in Quick mode,
// with the full page one tap away. Same rules as the rest of the site: facts
// only, neutral wording, the source one tap away, no party colors.
//
//   simpleCard     the card: a few labeled lines, where they come from, and
//                  "See the details" (switches to Detailed)
//   plainFor       the AI-simplified "what it does" for an item (plain_summaries,
//                  written by the sync's plain-summaries step), or null
//   plainLead      that line, or the item's own summary word for word, with its source
//   billStands     where a bill stands, in one or two short sentences
//   repVotesPlain  how the visitor's reps voted on a bill's final passage
//
// Pure except plainFor (one D1 read). See docs/quick-mode.md.
import { esc, fmtDate, safeUrl } from "./render.js";
import { firstSentences } from "./summary.js";

export const SIMPLE_METHOD = "/about/methodology/#quick";

/** Labeled plain lines, the source note, and the way back to the full page. `lines`: [[label, html]]. */
export function simpleCard({ lines, source = "", jump = "summary", label = "In plain words" }) {
  const shown = (lines || []).filter(([, html]) => html);
  if (!shown.length) return "";
  return `<section class="card stack simple-card simple-only" aria-label="${esc(label)}">
  ${shown.map(([l, html]) => `<div class="simple-line"><span class="label">${esc(l)}</span>${/^<(ul|p|div)\b/.test(html) ? html : `<p>${html}</p>`}</div>`).join("")}
  ${source ? `<p class="hint">${source}</p>` : ""}
  <button class="btn" type="button" data-mode-set="detailed" data-mode-jump="${esc(jump)}">See the details</button>
</section>`;
}

/** The sync's plain rewrite of an item's summary (kind: bill, order, measure), or null. */
export async function plainFor(db, kind, id) {
  if (!db) return null;
  try {
    return await db.prepare("SELECT what, supporters, critics, source_label, model, created_at FROM plain_summaries WHERE kind = ? AND item_id = ?").bind(kind, id).first();
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return null;
    throw err;
  }
}

/**
 * "What it does": the plain rewrite when there is one, labeled "Simplified by AI
 * from [source]"; otherwise the first sentence of the item's own summary, word
 * for word, with where it comes from. `summary`: {text, source} as the page shows it.
 * Returns {html, source, extra}: extra holds the supporters and critics lines.
 */
export function plainLead(plain, summary) {
  if (plain && plain.what) {
    const both = plain.supporters && plain.critics;
    return {
      html: esc(plain.what),
      source: `Simplified by AI from ${esc(plain.source_label || "the summary above")}, with no new facts added. <a class="inline-link" href="${SIMPLE_METHOD}">How</a>`,
      extra: both ? [["Supporters say", esc(plain.supporters)], ["Critics say", esc(plain.critics)]] : [],
    };
  }
  if (summary && summary.text) {
    const src = String(summary.source || "").trim();
    return { html: esc(firstSentences(summary.text, 1)), source: `${src ? `${src}${/[.>]$/.test(src) && !/<\/a>$/.test(src) ? "" : "."} ` : ""}A plain-words version comes later.`, extra: [] };
  }
  return { html: "", source: "", extra: [] };
}

// ---------------------------------------------------------------------------
// Bills

const PLAIN_CHAMBER = {
  "us-house": "the House",
  "us-senate": "the Senate",
  "ca-assembly": "the Assembly",
  "ca-senate": "the State Senate",
};
export function plainChamber(chamber) {
  if (PLAIN_CHAMBER[chamber]) return PLAIN_CHAMBER[chamber];
  if (/-upper$/.test(chamber)) return "the State Senate";
  if (/-lower$/.test(chamber)) return "the State House";
  if (/-legislature$/.test(chamber)) return "the Legislature";
  return "the legislature";
}
const passed = (result) => /pass|agreed|adopted|concurred/i.test(result || "") && !/fail|reject|not /i.test(result || "");
const failed = (result) => /fail|reject|not (passed|agreed)/i.test(result || "");

/**
 * Where a bill stands, in plain words. `chambers`: the legislature's two chambers
 * (lower first) or one; `outcome`: the recorded final action; `votes`: its votes, newest first.
 */
export function billStands({ federal, chambers, outcome, votes }) {
  const who = federal ? "the President" : "the Governor";
  const o = outcome && outcome.outcome;
  if (o) {
    const on = fmtDate(o.action_date);
    if (o.outcome === "presented") return `Passed. Waiting on ${who} to sign or veto it.`;
    if (o.outcome === "signed" || o.outcome === "became_law" || o.outcome === "without_signature") return `Became law on ${on}.`;
    if (o.outcome === "over_veto") return `Became law on ${on}, after lawmakers voted to override a veto.`;
    if (o.outcome === "vetoed" || o.outcome === "pocket_vetoed") return `Vetoed by ${who} on ${on}.`;
  }
  const finals = (votes || []).filter((v) => v.vote_type === "final_passage");
  const latest = {};
  for (const v of finals) if (!latest[v.chamber]) latest[v.chamber] = v;
  const lost = chambers.find((c) => latest[c] && failed(latest[c].result));
  if (lost) return `Failed in ${plainChamber(lost)} on ${fmtDate(latest[lost].vote_date)}.`;
  const done = chambers.filter((c) => latest[c] && passed(latest[c].result));
  const waiting = chambers.filter((c) => !done.includes(c));
  if (done.length && !waiting.length) return `Passed ${done.map(plainChamber).join(" and ")}. No signing or veto is recorded yet.`;
  if (done.length) return `Passed ${plainChamber(done[0])} on ${fmtDate(latest[done[0]].vote_date)}. Waiting on ${waiting.map(plainChamber).join(" and ")}.`;
  return "No final vote yet.";
}

/** How the visitor's reps voted on final passage, as list items; or how to find them. */
export function repVotesPlain({ districts, reps, chambers, votes }) {
  if (!districts) return `<a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.`;
  const finals = (votes || []).filter((v) => v.vote_type === "final_passage");
  const mine = (reps || []).filter((o) => chambers.includes(o.chamber));
  if (!mine.length) return "None of your reps sits in this legislature.";
  return `<ul class="simple-list">${mine
    .map((o) => {
      const v = finals.find((x) => x.positions.some((p) => p.slug === o.slug));
      const p = v && v.positions.find((x) => x.slug === o.slug);
      const said = !p ? "has no final vote recorded" : p.position === "Not voting" ? "did not vote" : p.position === "Present" ? "voted present" : `voted ${p.position}`;
      return `<li><a class="inline-link" href="/reps/${esc(o.slug)}/">${esc(o.name)}</a> ${said}.</li>`;
    })
    .join("")}</ul>`;
}

/** A source link for a plain card's note. */
export const sourceNote = (url, label) => (safeUrl(url) ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "");

// ---------------------------------------------------------------------------
// Officials

/** What the job is, in one sentence, by office. Facts about the office, the same for everyone in it. */
export function jobSentence(o, stateName = "") {
  const st = stateName || "the state";
  const office = String(o.office || "");
  if (o.chamber === "us-senate") return "One of 100 U.S. senators. Senators vote on national laws, approve treaties, and confirm judges and Cabinet members.";
  if (o.chamber === "us-house") return /delegate|resident commissioner/i.test(office)
    ? "Represents their area in the U.S. House. Delegates can vote in committees but not on the final passage of bills."
    : "One of 435 voting members of the U.S. House. House members vote on national laws, and bills to raise taxes must start in the House.";
  if (o.chamber === "us-executive") {
    if (o.rank === 1) return "Leads the federal government. Signs or vetoes the bills Congress passes, and directs federal agencies.";
    if (o.rank === 2) return "Second in line to be President. Leads the Senate and can break a tie vote there.";
    return "Leads a federal department. Chosen by the President and confirmed by the Senate.";
  }
  if (/-executive$/.test(o.chamber || "")) {
    if (/^governor$/i.test(office) || o.rank === 1) return `Leads ${st}'s government. Signs or vetoes the bills the Legislature passes, and directs state agencies.`;
    return `Holds a statewide office in ${st}.`;
  }
  if (o.chamber === "ca-senate" || /-upper$/.test(o.chamber || "")) return `A member of ${st}'s state Senate, which votes on the state's laws and budget.`;
  if (o.chamber === "ca-assembly" || /-lower$/.test(o.chamber || "")) return `A member of ${st}'s ${o.chamber === "ca-assembly" ? "Assembly" : "state House"}, which votes on the state's laws and budget.`;
  if (/-legislature$/.test(o.chamber || "")) return `A member of ${st}'s Legislature, which votes on its laws and budget.`;
  if (o.chamber === "county-board") return "A member of the county Board of Supervisors, which sets the county budget and local rules.";
  return "";
}

/** One recorded vote in plain words: "Voted Yes on H.R. 1 (title). It passed." */
export function voteLinePlain(v) {
  const said = v.position === "Not voting" ? "Did not vote" : v.position === "Present" ? "Voted present" : `Voted ${v.position}`;
  const what = v.bill_id && v.bill_number
    ? `<a class="inline-link" href="/laws/bills/${esc(encodeURIComponent(v.bill_id))}/">${esc(v.bill_number)}</a>${v.bill_title ? ` (${esc(v.bill_title)})` : ""}`
    : esc(v.subject || v.question || "a recorded vote");
  const result = passed(v.result) ? " It passed." : failed(v.result) ? " It failed." : "";
  return `${said} on ${what}.${result} <span class="secondary">${esc(fmtDate(v.vote_date))}</span>`;
}

const MONEY_PARTS = [
  ["individual_unitemized", "small donors ($200 or less)"],
  ["individual_itemized", "individual donors giving more than $200"],
  ["pac", "PACs and other political committees"],
  ["party", "political party committees"],
  ["self_funding", "the candidate's own money"],
  ["other", "transfers and other sources"],
];
const dollars = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

/** "Raised $X in 2025–2026, mostly from small donors." From FEC totals; null without them. */
export function moneyLinePlain(t, period) {
  if (!t || !(t.receipts > 0)) return null;
  const [key, name] = [...MONEY_PARTS].sort((a, b) => (t[b[0]] || 0) - (t[a[0]] || 0))[0];
  const share = (t[key] || 0) / t.receipts;
  return `Raised ${dollars(t.receipts)} in ${period}, ${share >= 0.5 ? "mostly" : "the largest share"} from ${name}.`;
}
