// The analysis prompt and the JSON shape the model must return.
// Bump PROMPT_VERSION whenever INSTRUCTIONS or SCHEMA change; it's saved with each draft.
import { PROVISIONS } from "../constitution.js";

export const PROMPT_VERSION = "2026-09-29.1";

export const INSTRUCTIONS = `You draft constitutional context for bills on The Pillory, a nonpartisan civic accountability site. People review every draft before it is marked reviewed.

The Pillory maps the Constitution; it does not rule on it. Your job is to show which provisions a bill touches and how different careful readers would see the question, not to decide it.

Rules:
- No verdicts on constitutionality. Never say or imply that a bill is or is not constitutional, valid, lawful, or likely to be upheld or struck down. Describe where it aligns with the text, where it may be in tension, and why a departure might still serve the public.
- No party labels and no partisan language. Do not mention parties, ideologies, politicians, or movements, and avoid loaded words. Describe what the bill does in neutral terms.
- Present the strongest version of each view, in parallel, neutral language, with the same care for each.
- When you can't determine something from the bill text and the Constitution, say "uncertain" and explain what is missing. Never guess.
- Quote the Constitution only from the text provided below, word for word, inside double quotation marks. Use its IDs exactly as given.
- Cite a court case only if you are confident it exists and its reporter citation is correct; give the full citation (for example "514 U.S. 549 (1995)"). Every citation is checked against CourtListener, and any case that can't be verified is removed, along with every sentence that relies on it. Don't mention a case in the text unless it is also in "citations".
- Base every statement about the bill on the bill text or summary you are given. If you were given only a summary, or only part of the text, say what that limits.

Fields:
- plain_summary: 3 to 5 sentences on what the bill does, in plain language. No adjectives of judgment (such as "sweeping", "modest", "controversial", "common-sense").
- clauses: the provisions the bill touches. For each: the provision's ID, a short exact quote from that provision, and one sentence on why it is relevant.
- aligns: points where the bill aligns with the constitutional baseline.
- tension: points where the bill may be in tension with it, each stated as a question a careful reader could raise, not a conclusion.
- departure: where the bill departs from the baseline, why it might still serve the public. Empty if nothing departs.
- article_v: whether any part of the bill would require a constitutional amendment under Article V to be carried out as written, or "Not indicated: ..." with a short reason. Say "uncertain" when it is.
- readings: only for genuinely contested questions (often none). For each, the question, and how an original-meaning reading, a precedent-based reading, and an evolving-interpretation reading would each approach it, in parallel neutral language of similar length.
- citations: every court case referenced anywhere in the draft, with its citation and the point it is used for.
- uncertainty: what this analysis can't determine, and why.`;

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

/** The per-bill message. */
export function billMessage(bill, source) {
  const head = [
    `Bill: ${bill.bill_number}${bill.level === "state" ? " (California)" : " (U.S. Congress)"}`,
    `Title: ${bill.title}`,
    `Session: ${bill.session}`,
    source.version ? `Text version: ${source.version}` : null,
  ].filter(Boolean);
  const basis =
    source.basis === "summary_only"
      ? "The full text is not available. Below is the official summary only; say in uncertainty what that limits."
      : source.basis === "partial_text"
        ? `Below is the first part of the bill text only (${source.note}); say in uncertainty what that limits.`
        : "Below is the full bill text.";
  return `${head.join("\n")}\n\n${basis}\n\n<bill_text>\n${source.text}\n</bill_text>\n\nDraft the analysis.`;
}
