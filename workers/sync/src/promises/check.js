// Checks on a candidate promise, in code, before it is published (labeled
// "AI-identified, auto-checked"). Pure; tested in test/promises.test.mjs.
//
//   - The quote is word for word in the source text (only spacing, curly
//     quotes and dashes may differ). A quote that isn't is dropped, never fixed.
//   - The wording ThePillory adds (the check note) is neutral: no loaded
//     words, no judgment of the official, no prediction.
//   - It's a commitment, not a value or position: the quote says the official
//     (or their office) will do something specific.
//   - It's checkable: a concrete action (sign, vote, introduce, build, fund …)
//     with something to check it against (a deadline, a number, a named bill),
//     or an action that is checkable by itself (signing, vetoing, voting,
//     introducing or repealing something).

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
export const COMMIT = /\b(will|shall|going to|commit(s|ted)? to|pledge(s|d)? to|promise(s|d)? to|plan(s)? to|intend(s)? to|by (the end of )?(19|20)\d\d|within \d+ (days|weeks|months|years)|we('| a)re (going to|launching|creating|building|investing|cutting|ending|delivering))\b/i;
export const VALUES_ONLY = /^\s*(i|we) (believe|stand|value|support|oppose|care|are committed to the idea|love|honor)\b/i;

/** Why a quote isn't a specific, checkable commitment, or null if it is one. */
export function notACommitment(quote) {
  const q = normalizeText(quote);
  if (q.length > 600) return "too long to be one commitment";
  if (VALUES_ONLY.test(q)) return "a statement of values or position, not a commitment";
  if (!COMMIT.test(q)) return "no commitment to act (will, plan to, by a date…)";
  return null;
}

// Actions a reader can check happened by themselves: a signature, a veto, a
// vote, a bill introduced, an order issued, a hearing held.
const CHECKABLE = /\b(sign|veto|vote (for|against|to|no|yes)|introduce|sponsor|co-?sponsor|author|repeal|rescind|issue an? (executive )?order|hold (a |public )?(hearing|hearings|town hall|vote)|appoint|nominate|file (a |suit|legislation|a bill)|put .{1,60} on the ballot)\b/i;
// Concrete actions that become checkable with a deadline, a number or a named measure.
const ACTION = /\b(award|grant|spend|pay|train|enroll|recruit|build|construct|repave|pave|repair|open|close|fund|cut|reduce|raise|increase|lower|eliminate|end|ban|require|create|establish|launch|publish|release|hire|add|expand|invest|allocate|propose|submit|pass|enact|approve|deploy|complete|finish|install|cap|freeze|double|triple|restore|extend|implement|adopt|audit|withdraw|return|send|deliver|provide|plant|clear|hold|rename|replace|move|convert|lift|suspend|deport|secure|negotiate)\b/i;
// Something to check the action against.
const ANCHOR = new RegExp(
  [
    "\\d", // a number, amount, percentage, year, district or bill number
    "\\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|fifty|hundred|thousand|million|billion|trillion)\\b",
    "\\b(day one|first day|this (year|session|term|spring|summer|fall|winter|month)|next (year|session|month|budget)|end of (the|this) (year|session|term))\\b",
    "\\b(January|February|March|April|May|June|July|August|September|October|November|December)\\b",
    "\\b(H\\.?\\s?R\\.?|S\\.|SB|AB|ACA|SCA|Prop(osition)?|Measure|Ordinance|Resolution)\\s?\\d",
  ].join("|"),
  "i"
);
// Aims that aren't an action anyone could check.
const VAGUE_ONLY = /^(always |continue to |keep |never stop |)(fight|work|strive|stand|champion|advocate|be a voice|be a champion|support|defend|protect|prioritize|focus|help|make (sure|it|our|the|this|america|california)|ensure|bring|lead|serve|listen|care)\b/i;

/**
 * Why a commitment isn't specific enough to check, or null when it is: an
 * action, a vote or a deadline (point 2 of the publishing rules). Looks at the
 * words after the commitment ("will …", "plan to …").
 */
export function notSpecific(quote) {
  const q = normalizeText(quote);
  const m = COMMIT.exec(q);
  if (!m) return "no commitment to act";
  const after = q.slice(m.index + m[0].length).trim();
  // "by 2027" or "within 90 days" is itself the commitment word: look at the whole quote.
  const clause = /^\d|^by |^within /i.test(m[0]) ? q : after;
  if (CHECKABLE.test(clause)) return null;
  if (ACTION.test(clause) && ANCHOR.test(q)) return null;
  if (VAGUE_ONLY.test(clause)) return "a general aim, not a specific action";
  if (ACTION.test(clause)) return "an action with nothing to check it against (no deadline, number or named measure)";
  return "no specific action, vote or deadline";
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
  const why = notACommitment(quote) || notSpecific(quote);
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

const NEXT = { no_action: ["in_progress", "kept", "broken"], in_progress: ["kept", "broken"], kept: [], broken: [] };

/**
 * Check one status update the AI found in a document: the evidence is quoted
 * word for word from the document, the note is neutral, and the change moves
 * forward (No action yet → In progress → Kept, or → Broken). Returns
 * { ok: true, to_status, evidence_quote, evidence } or { ok: false, reason }.
 * Whether it publishes at once (In progress, Kept) or waits for a person
 * (Broken) is decided by the caller.
 */
export function checkStatusUpdate(u, promise, sourceText) {
  if (!u || !promise) return { ok: false, reason: "no promise" };
  if (!(NEXT[promise.status] || []).includes(u.to_status)) return { ok: false, reason: `can't go from ${promise.status} to ${u.to_status}` };
  const evidence_quote = findQuote(sourceText, u.evidence_quote || "");
  if (!evidence_quote) return { ok: false, reason: "evidence not found word for word in the source" };
  if (evidence_quote.length > 800) return { ok: false, reason: "evidence quote too long" };
  if (quoteKey(evidence_quote) === promise.quote_key) return { ok: false, reason: "the evidence is the promise itself" };
  const evidence = normalizeText(u.evidence_note || "");
  if (!evidence) return { ok: false, reason: "no note on what the evidence shows" };
  if (evidence.length > 300) return { ok: false, reason: "evidence note too long" };
  const words = wordingProblems(evidence);
  if (words.length) return { ok: false, reason: words.join("; ") };
  return { ok: true, to_status: u.to_status, evidence_quote, evidence };
}
