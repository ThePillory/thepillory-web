// Public Records & Investigations (docs/records-tab-spec.md). Phase 1: the
// tier definitions page and the disclaimer page, behind the RECORDS_TAB flag
// (a Pages environment variable; anything but "on", or unset, hides both
// pages: they answer "not found" and nothing links to them). The wording is
// a draft for the legal review (spec §12, phase 6) and comes from the spec;
// it describes the standard, never a person.
import { esc } from "./render.js";

/** Is the tab on? Off unless the setting says exactly "on". */
export const recordsOn = (env) => String((env && env.RECORDS_TAB) || "").trim().toLowerCase() === "on";

export const TIERS_PATH = "/about/records/tiers/";
export const DISCLAIMER_PATH = "/about/records/disclaimer/";
export const BANNER = "Appearing in these records is not evidence of wrongdoing.";
export const CORRECTION_DAYS = 14;
// Dataset #1's dividing date: Epstein's guilty plea in Florida (spec §6.3).
export const PERIOD_SPLIT = { date: "2008-06-30", label: "June 30, 2008", event: "Jeffrey Epstein's guilty plea in Florida" };

// Spec §6.2: the strongest connection one document shows on its own.
export const TIERS = [
  { n: 1, name: "Mentioned", qualifies: "The person's name appears in a document someone else wrote, in a list, or in a contact book.", not: "" },
  { n: 2, name: "Direct correspondence", qualifies: "The person wrote, or is a named direct recipient of, a message with the investigation's central figures or their staff (in the Epstein investigation records: Jeffrey Epstein, Ghislaine Maxwell, or their staff).", not: "Mass emails and large distribution lists. Those stay at Tier 1." },
  { n: 3, name: "Documented contact", qualifies: "The record shows in-person contact: a flight log, a confirmed meeting or event, or a calendar entry that a second record corroborates.", not: "An invitation or an RSVP alone. That stays at Tier 1 or 2." },
  { n: 4, name: "Financial ties", qualifies: "The record shows a payment, donation, loan, investment or business dealing between the person (or their organization) and the investigation's central figure.", not: "Unverified claims in someone else's email." },
  { n: 5, name: "Named in legal proceedings", qualifies: "The person is named in a deposition, a court filing or a sworn statement.", not: "Being named is not a finding of fact." },
];

// Spec §6.1, in plain words.
export const SOURCE_TYPES = [
  ["court_filing", "Court filing"], ["deposition", "Deposition"], ["law_enforcement_report", "Law enforcement report"],
  ["flight_log", "Flight log"], ["contact_book", "Contact book"], ["calendar", "Calendar"],
  ["email_by_subject", "Email written by the person"], ["email_to_subject", "Email sent to the person"],
  ["email_about_subject", "Email about the person"], ["financial_record", "Financial record"],
  ["news_clipping", "News clipping"], ["photo_or_media", "Photo or other media"], ["other", "Other"],
];

const bannerHtml = () => `<p class="banner" role="note">${esc(BANNER)} <a class="inline-link" href="${DISCLAIMER_PATH}">Read the full disclaimer</a></p>`;

export function tiersMain() {
  return `
<header class="page-head">
  <p class="label">Public Records &amp; Investigations</p>
  <h1>Evidence tiers</h1>
  <p class="subtitle">How ThePillory describes what a public record documents about a person who holds federal power. One standard for everyone, whatever their party.</p>
</header>
${bannerHtml()}
<section class="stack" aria-labelledby="h-tiers">
  <div class="section-head"><h2 id="h-tiers">The five tiers</h2></div>
  ${TIERS.map((t) => `
  <article class="card stack-sm" id="tier-${t.n}">
    <p class="label">Tier ${t.n}</p>
    <h3>${esc(t.name)}</h3>
    <p class="small"><strong>Qualifies when:</strong> ${esc(t.qualifies)}</p>
    ${t.not ? `<p class="small secondary"><strong>Doesn't qualify:</strong> ${esc(t.not)}</p>` : ""}
  </article>`).join("")}
</section>
<section class="card stack-sm" aria-labelledby="h-rules">
  <h2 class="label" id="h-rules">How tiers are given</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>One tier per entry:</strong> each document gets the strongest tier it supports on its own.</li>
    <li><strong>The headline tier</strong> on a person's page is the highest tier among their reviewed entries.</li>
    <li><strong>Hearsay stays at Tier 1.</strong> "Someone told me this person was there" never raises a tier unless a separate record corroborates it.</li>
    <li><strong>A person checks every entry at Tier 2 or above</strong> against the original document page before it's published. AI may suggest a tier; it never sets one.</li>
    <li><strong>Same name, different person:</strong> when a name could belong to someone else, the entry goes to a person for review and never straight to a profile.</li>
  </ul>
</section>
<section class="card stack-sm" aria-labelledby="h-counts">
  <h2 class="label" id="h-counts">Counts and dates</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>Unique documents only.</strong> Copies of the same document are counted once, and the number of times a name appears is never shown.</li>
    <li><strong>Before and after ${esc(PERIOD_SPLIT.label)}</strong> (${esc(PERIOD_SPLIT.event)}): documents are counted on each side of that date. A document whose date isn't known is counted as "date unknown", never guessed.</li>
  </ul>
</section>
<section class="card stack-sm" aria-labelledby="h-types">
  <h2 class="label" id="h-types">Kinds of documents</h2>
  <ul class="chips plain-list">${SOURCE_TYPES.map(([, label]) => `<li class="chip chip--light">${esc(label)}</li>`).join("")}</ul>
</section>
<section class="card stack-sm" aria-labelledby="h-never">
  <h2 class="label" id="h-never">What tiers are not</h2>
  <p class="small">A tier describes the strongest connection a record documents. It is not a finding of guilt, a score or a ranking. ThePillory doesn't compare people, list a "top" anyone, or color anyone's record.</p>
  <p class="small"><a class="inline-link" href="${DISCLAIMER_PATH}">The full disclaimer</a></p>
</section>`;
}

export function disclaimerMain() {
  return `
<header class="page-head">
  <p class="label">Public Records &amp; Investigations</p>
  <h1>Disclaimer</h1>
  <p class="subtitle">${esc(BANNER)}</p>
</header>
<section class="card stack-sm" aria-labelledby="h-what">
  <h2 class="label" id="h-what">What this tab shows</h2>
  <p class="small">What publicly released government records document about people who hold federal power, with one standard for everyone, whatever their party. Every entry links to the original government document. A document with no government-hosted copy isn't published.</p>
  <p class="small">Each entry shows only facts from the record: the date, the kind of document, its <a class="inline-link" href="${TIERS_PATH}">evidence tier</a>, a short excerpt, and the link. A person's own public statements about the matter are shown beside the record, quoted word for word with their source.</p>
</section>
<section class="card stack-sm" aria-labelledby="h-not">
  <h2 class="label" id="h-not">What it doesn't say</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>Appearing in these records is not evidence of wrongdoing.</strong></li>
    <li><strong>Being named in legal proceedings is not a finding of fact.</strong> A deposition, filing or sworn statement records what someone said or claimed, not what a court decided.</li>
    <li><strong>No scores, rankings or comparisons</strong> between people, and no colors that suggest guilt.</li>
    <li><strong>No written descriptions of people.</strong> ThePillory doesn't write about anyone in this tab, by AI or by hand; it shows the record and the person's own words.</li>
    <li><strong>Counts are unique documents,</strong> never the number of times a name appears.</li>
  </ul>
</section>
<section class="card stack-sm" aria-labelledby="h-privacy">
  <h2 class="label" id="h-privacy">Victims and redactions</h2>
  <p class="small">ThePillory never publishes or stores the identity of a victim or survivor, and never tries to recover redacted text: redactions stay redacted. A document that appears to identify a victim is kept off the site entirely.</p>
</section>
<section class="card stack-sm" aria-labelledby="h-review">
  <h2 class="label" id="h-review">How entries are checked</h2>
  <p class="small">AI may help find and sort mentions, but it never decides what's published. A person checks every entry at Tier 2 or above against the original document page, and any mention where the name could belong to someone else. Each person's page shows when their records were last reviewed.</p>
</section>
<section class="card stack-sm" aria-labelledby="h-corrections">
  <h2 class="label" id="h-corrections">Corrections</h2>
  <p class="small">Anyone, including the people named, can report an error. ThePillory aims to respond within ${CORRECTION_DAYS} days. Every correction is logged publicly: what changed and when, never who asked. The correction form opens with the tab.</p>
</section>`;
}
