// The analysis prompts and the JSON shapes the model must return: a short card
// (the default) and the full analysis (when an issue links to the bill or
// someone asks for it). Bump PROMPT_VERSION (full) or CARD_PROMPT_VERSION
// (card) whenever the instructions or the shape change; it's saved with each draft.
import { PROVISIONS } from "../constitution.js";

export const PROMPT_VERSION = "2026-10-06.1";
export const CARD_PROMPT_VERSION = "2026-10-06.1";

const INTRO = `You draft constitutional context for bills on ThePillory, a nonpartisan civic accountability site. Every draft is checked automatically (quotes against the stored Constitution, cases against CourtListener), then by a separate AI reviewer, and people review flagged drafts and a random share of the rest.

ThePillory maps the Constitution; it does not rule on it. Your job is to show which provisions a bill touches and how different careful readers would see the question, not to decide it.`;

export const RULES = `Rules:
- No verdicts on constitutionality. Never say or imply that a bill is or is not constitutional, valid, lawful, or likely to be upheld or struck down. Describe where it aligns with the text, where it may be in tension, and why a departure might still serve the public.
- No party labels and no partisan language. Do not mention parties, ideologies, politicians, or movements, and avoid loaded words. Describe what the bill does in neutral terms.
- Never state a verdict in any panel, the summary or a reading. Banned phrasings (and any like them): "fits [a power or amendment]", "falls within [a power]", "is a valid / proper / legitimate exercise of", "is within Congress's (or the legislature's) power", "is authorized by", "rests on", "acts through [a power]", "satisfies", "complies with", "is consistent with [a provision]", "is (un)constitutional", and words of certainty such as "clearly", "plainly", "squarely".
- Write the three panels in parallel form, with the same hedging and the same care: each begins "One view is that", gives the view in its strongest form, and says why ("because …"). For example: "One view is that the bill draws on the commerce power, because it regulates goods sold across state lines." / "One view is that the bill may be in tension with the Tenth Amendment, because it directs state officials to carry out a federal program." / "One view is that, even so, it might serve the public, because …". No panel is shorter, vaguer or more hedged than another.
- Present the strongest version of each view, in parallel, neutral language, with the same care for each.
- When you can't determine something from the bill text and the Constitution, say "uncertain" and explain what is missing. Never guess.
- Quote the Constitution only from the text provided below, word for word, inside double quotation marks. Use its IDs exactly as given.
- Cite a court case only if you are confident it exists and its reporter citation is correct; give the full citation (for example "514 U.S. 549 (1995)"). Every citation is checked against CourtListener, and any case that can't be verified is removed, along with every sentence that relies on it. Don't mention a case in the text unless it is also in "citations".
- Base every statement about the bill on the bill text or summary you are given. If you were given only part of the text, the summary must include a sentence beginning "Only part of the bill text was read" that says what was read; if you were given only the official summary, a sentence beginning "Only the official summary was read". Never describe what a section you weren't given says or does: a list of section headings tells you a section exists and its title, not its contents.`;

export const INSTRUCTIONS = `${INTRO}

${RULES}

Fields:
- plain_summary: 3 to 5 sentences on what the bill does, in plain language. No adjectives of judgment (such as "sweeping", "modest", "controversial", "common-sense").
- clauses: the provisions the bill touches. For each: the provision's ID, a short exact quote from that provision, and one sentence on why it is relevant.
- aligns: points where the bill may align with the constitutional baseline, each beginning "One view is that".
- tension: points where the bill may be in tension with it, each beginning "One view is that", a view a careful reader could hold, not a conclusion.
- departure: where the bill may depart from the baseline, why it might still serve the public, each beginning "One view is that". Empty if nothing departs.
  Give aligns, tension and departure the same number of points of similar length.
- article_v: whether any part of the bill would require a constitutional amendment under Article V to be carried out as written, or "Not indicated: ..." with a short reason. Say "uncertain" when it is.
- readings: only for genuinely contested questions (often none). For each, the question, and how an original-meaning reading, a precedent-based reading, and an evolving-interpretation reading would each approach it, in parallel neutral language of similar length.
- citations: every court case referenced anywhere in the draft, with its citation and the point it is used for.
- uncertainty: what this analysis can't determine, and why.`;

export const CARD_INSTRUCTIONS = `${INTRO}

This is a short card: most readers want the gist. Keep every field brief. A full analysis is written separately when a resident asks for one or an issue on the site links to the bill.

${RULES}

Fields:
- plain_summary: 2 to 3 sentences on what the bill does, in plain language. No adjectives of judgment. If you were given only part of the text, one sentence begins "Only part of the bill text was read" (and says what); if only the official summary, "Only the official summary was read".
- clauses: the 1 to 3 most relevant provisions, most relevant first. For each: the provision's ID, a short exact quote from that provision, and one sentence on why it is relevant.
- aligns: one sentence of 20 to 35 words, beginning "One view is that", on where the bill may align with the constitutional baseline and why.
- tension: one sentence of 20 to 35 words, beginning "One view is that", on where it may be in tension with it and why.
- departure: one sentence of 20 to 35 words, beginning "One view is that", on why a departure from the baseline might still serve the public, or "" if nothing departs.
  The three sentences are parallel: same form, same hedging, similar length.
- readings: only if the constitutional question is genuinely contested among careful readers (usually it isn't; then []). For each, the question, and how an original-meaning reading, a precedent-based reading, and an evolving-interpretation reading would each approach it, in one parallel, neutral sentence each.
- citations: every court case referenced anywhere in the card (usually none), with its citation and the point it is used for.`;

export function constitutionBlock() {
  const lines = PROVISIONS.filter((p) => p.leaf).map((p) => `[${p.id}] ${p.label}\n${p.text}`);
  return `The U.S. Constitution and its amendments, one provision per entry, as [id] label, then text. This is the only text you may quote.\n\n${lines.join("\n\n")}`;
}

const str = { type: "string" };
const list = { type: "array", items: str };

export function schema() {
  const ids = PROVISIONS.map((p) => p.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["plain_summary", "clauses", "aligns", "tension", "departure", "article_v", "readings", "citations", "uncertainty"],
    properties: {
      plain_summary: str,
      clauses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "quote", "why"],
          properties: { id: { type: "string", enum: ids }, quote: str, why: str },
        },
      },
      aligns: list,
      tension: list,
      departure: list,
      article_v: str,
      readings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "original_meaning", "precedent", "evolving"],
          properties: { question: str, original_meaning: str, precedent: str, evolving: str },
        },
      },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["case_name", "citation", "point"],
          properties: { case_name: str, citation: str, point: str },
        },
      },
      uncertainty: str,
    },
  };
}

const clauseItem = {
  type: "object",
  additionalProperties: false,
  required: ["id", "quote", "why"],
  properties: { id: { type: "string", enum: PROVISIONS.map((p) => p.id) }, quote: str, why: str },
};

/** The short card's shape. Stored in the same columns as the full analysis (see cardToDraft). */
export function cardSchema() {
  const full = schema().properties;
  return {
    type: "object",
    additionalProperties: false,
    required: ["plain_summary", "clauses", "aligns", "tension", "departure", "readings", "citations"],
    properties: {
      plain_summary: str,
      clauses: { type: "array", items: clauseItem },
      aligns: str,
      tension: str,
      departure: str,
      readings: full.readings,
      citations: full.citations,
    },
  };
}

export const MAX_CARD_CLAUSES = 3;

/**
 * A card in the full analysis's shape (one-item lists, no Article V or
 * uncertainty fields), so the same checks, storage and pages handle both.
 * Returns {draft, trimmed}: trimmed lists provisions beyond the first three.
 */
export function cardToDraft(card) {
  const one = (s) => (typeof s === "string" && s.trim() ? [s.trim()] : []);
  const clauses = Array.isArray(card.clauses) ? card.clauses : [];
  return {
    draft: {
      plain_summary: card.plain_summary || "",
      clauses: clauses.slice(0, MAX_CARD_CLAUSES),
      aligns: one(card.aligns),
      tension: one(card.tension),
      departure: one(card.departure),
      article_v: "",
      readings: Array.isArray(card.readings) ? card.readings : [],
      citations: Array.isArray(card.citations) ? card.citations : [],
      uncertainty: "",
    },
    trimmed: clauses.slice(MAX_CARD_CLAUSES).map((c) => c.id),
  };
}

/**
 * The revision step: the draft the AI reviewer flagged (as the reviewer saw
 * it), the problems it named, and the same bill text. The answer has the same
 * shape as a first draft. Same system prompt as drafting, so it's cached.
 */
export function revisionMessage(bill, source, depth, reviewedDraft, reasons) {
  return `${billContext(bill, source)}

<previous_draft>
${JSON.stringify(reviewedDraft, null, 1)}
</previous_draft>

<reviewer_problems>
${reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}
</reviewer_problems>

An independent reviewer checked the previous draft against the bill text and found the problems listed. Write the ${depth === "card" ? "card" : "analysis"} again, fixing each problem. Keep what the reviewer didn't question, unless fixing a problem requires changing it. Follow every rule in your instructions; where a problem can't be settled from the text, say it is uncertain rather than guessing.

${depth === "card" ? "Revise the short card." : "Revise the analysis."}`;
}

/** The per-bill message. depth "card" asks for the short card. */
export function billMessage(bill, source, depth = "full") {
  return `${billContext(bill, source)}\n\n${depth === "card" ? "Draft the short card." : "Draft the analysis."}`;
}

/** The bill's identity and text (or summary), shared by the draft and the reviewer. */
export function billContext(bill, source) {
  const head = [
    `Bill: ${bill.bill_number}${bill.level === "state" ? " (California)" : " (U.S. Congress)"}`,
    `Title: ${bill.title}`,
    `Session: ${bill.session}`,
    source.version ? `Text version: ${source.version}` : null,
  ].filter(Boolean);
  const basis =
    source.basis === "summary_only"
      ? "The full text is not available. Below is the official summary only; the draft must say what that limits."
      : source.basis === "partial_text"
        ? `Below is the first part of the bill text only (${source.note}); the draft must say what that limits.`
        : "Below is the full bill text.";
  return `${head.join("\n")}\n\n${basis}\n\n<bill_text>\n${source.text}\n</bill_text>`;
}
