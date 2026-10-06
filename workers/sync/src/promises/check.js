// Checks on a candidate promise, in code, before it reaches the review queue.
// Pure; tested in test/promises.test.mjs.
//
//   - The quote is word for word in the source text (only spacing, curly
//     quotes and dashes may differ). A quote that isn't is dropped, never fixed.
//   - The wording ThePillory adds (the check note) is neutral: no loaded
//     words, no judgment of the official, no prediction.
//   - It's a commitment, not a value or position: the quote says the official
//     (or their office) will do something specific.

/** Text for comparison: straight quotes and dashes, one space, no markup spacing. */
export function normalizeText(s) {
  return String(s || "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The duplicate key: lowercase letters and digits only. */
export function quoteKey(quote) {
  return String(quote || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The quote exactly as it appears in the source (with the source's own
 * punctuation), or null if it isn't there word for word.
 */
export function findQuote(sourceText, quote) {
  const src = normalizeText(sourceText);
  // Outer quotation marks and a trailing comma or semicolon aren't part of the commitment.
  const q = normalizeText(quote).replace(/^["']+|["']+$/g, "").replace(/[,;:]+$/, "").trim();
  if (q.length < 20) return null;
  const at = src.indexOf(q);
  return at === -1 ? null : src.slice(at, at + q.length);
}

// Words that judge or dramatize. ThePillory states the commitment and what
// would show it done; it doesn't characterize the official.
const JUDGING = [
  /\b(vow(s|ed)?|slam(s|med)?|blast(s|ed)?|lash(es|ed)? out|bash(es|ed)?|tout(s|ed)?|brag(s|ged)?|boast(s|ed)?)\b/i,
  /\b(betray(s|ed|al)?|flip-flop(s|ped)?|reneg(e|es|ed)|lie(s|d)?|lying|falsely|misleading|dishonest)\b/i,
  /\b(historic|landmark|sweeping|radical|extreme|disastrous|reckless|dangerous|bold|ambitious|controversial|unprecedented|devastating|shameful|outrageous)\b/i,
];
// Also kept out of the AI's notes: hedges that slant ("finally", "so-called"),
// predictions, and "failed to", which judges before a person has.
const STRICT = [
  /\b(finally|merely|so-called|supposedly|allegedly)\b/i,
  /\b(will (likely|probably|never)|is (unlikely|likely) to|doomed)\b/i,
  /\bfail(s|ed)? to\b/i,
  /!/,
];

/**
 * Problems with wording ThePillory adds. Empty when it's neutral. `strict`
 * (the AI's notes) also refuses hedges, predictions and "failed to"; a
 * person's evidence ("the bill failed to pass the Senate") may use those.
 */
export function wordingProblems(text, { strict = true } = {}) {
  const out = [];
  for (const re of strict ? [...JUDGING, ...STRICT] : JUDGING) {
    const m = String(text || "").match(re);
    if (m) out.push(`loaded or judging wording: "${m[0]}"`);
  }
  return out;
}

// A commitment says someone will do something. Values and positions ("I
// believe in…", "We stand with…") aren't promises.
const COMMIT = /\b(will|shall|going to|commit(s|ted)? to|pledge(s|d)? to|promise(s|d)? to|plan(s)? to|intend(s)? to|by (the end of )?(19|20)\d\d|within \d+ (days|weeks|months|years)|we('| a)re (going to|launching|creating|building|investing|cutting|ending|delivering))\b/i;
const VALUES_ONLY = /^\s*(i|we) (believe|stand|value|support|oppose|care|are committed to the idea|love|honor)\b/i;

/** Why a quote isn't a specific, checkable commitment, or null if it is one. */
export function notACommitment(quote) {
  const q = normalizeText(quote);
  if (q.length > 600) return "too long to be one commitment";
  if (VALUES_ONLY.test(q)) return "a statement of values or position, not a commitment";
  if (!COMMIT.test(q)) return "no commitment to act (will, plan to, by a date…)";
  return null;
}

/**
 * Check one candidate from the AI against the source text. Returns
 * { ok: true, quote, check_note, due } with the quote as the source has it,
 * or { ok: false, reason }.
 */
export function checkCandidate(c, sourceText) {
  if (!c || typeof c.quote !== "string") return { ok: false, reason: "no quote" };
  const quote = findQuote(sourceText, c.quote);
  if (!quote) return { ok: false, reason: "quote not found word for word in the source" };
  const why = notACommitment(quote);
  if (why) return { ok: false, reason: why };
  const note = normalizeText(c.check_note || "");
  if (!note) return { ok: false, reason: "no note on what would show it done" };
  if (note.length > 300) return { ok: false, reason: "check note too long" };
  const words = wordingProblems(note);
  if (words.length) return { ok: false, reason: words.join("; ") };
  // A deadline only when the quote itself states one.
  const due = c.due && normalizeText(quote).toLowerCase().includes(normalizeText(c.due).toLowerCase()) ? normalizeText(c.due) : null;
  return { ok: true, quote, check_note: note, due };
}
