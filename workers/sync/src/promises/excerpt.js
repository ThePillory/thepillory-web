// "In their own words" on the Platform tab: a short excerpt, word for word,
// from an official's Issues or Priorities page (promise_pages). Pure: the
// prompt, the output shape and the checks; the call is in index.js. Tested in
// test/promises.test.mjs.
//
// The same instructions for every official, whatever their office or party:
// the passage that sums up the page in the official's own words, not the one
// most likely to please or embarrass them. Code then checks it's on the page
// word for word and short; anything else is dropped, never fixed.
import { findQuote } from "./check.js";

export const EXCERPT_MAX = 450; // characters, about two or three sentences
export const EXCERPT_REFRESH_DAYS = 30;

export const EXCERPT_INSTRUCTIONS = `You pick a short excerpt from an official's own Issues or Priorities web page for ThePillory, a nonpartisan civic record. Readers see it under "In their own words", with a link to the page.

Rules:
- Copy one to three consecutive sentences word for word from the page, with no changes, additions, ellipses or brackets, and no more than ${EXCERPT_MAX} characters.
- Choose the passage that best sums up, in the official's own words, what the page says they will work on. Prefer the page's own opening summary or introduction when it has one.
- Choose the same way for every official, whatever their office or party: never the passage most likely to make them look good or bad.
- Leave out navigation, donation or volunteer requests, slogans on their own, and text quoted from other people.
- If the page has no such passage, return an empty string.`;

export const excerptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["excerpt"],
  properties: { excerpt: { type: "string" } },
};

export function excerptMessage(page, official) {
  return `Pick an excerpt. The page is ${official.name}'s ${page.kind === "office_site" ? "office" : "campaign"} website page "${page.title}" (${page.url}).

<page>
${page.text}
</page>`;
}

/** The excerpt as the page has it, or null with the reason. */
export function checkExcerpt(pageText, excerpt) {
  const x = String(excerpt || "").trim();
  if (!x) return { excerpt: null, reason: "no passage summing up the page" };
  if (x.length > EXCERPT_MAX + 20) return { excerpt: null, reason: "too long" };
  const found = findQuote(pageText, x);
  if (!found) return { excerpt: null, reason: "not on the page word for word" };
  return { excerpt: found, reason: null };
}

/**
 * Whether a page needs a new excerpt now: none yet, or it's no longer on the
 * page, or the AI picked it more than EXCERPT_REFRESH_DAYS ago. One a person
 * chose stays while it's still on the page; a hidden one stays hidden.
 */
export function needsExcerpt(row, pageText, now = Date.now(), days = EXCERPT_REFRESH_DAYS) {
  const at = Date.parse(`${String(row.excerpt_at || "").replace(" ", "T")}Z`);
  const stale = !(at > 0) || now - at > days * 86400000;
  if (row.excerpt_by === "hidden") return false;
  if (!row.excerpt) return row.excerpt_by === "none" ? stale : true; // none found: ask again monthly
  if (!findQuote(pageText, row.excerpt)) return true;
  if (String(row.excerpt_by || "").startsWith("person:")) return false;
  return stale;
}
