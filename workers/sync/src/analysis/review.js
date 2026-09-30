// The AI reviewer pass: a separate claude-sonnet-5-5 call that reads a draft
// (after the quote and citation checks) against the bill text and answers a
// fixed checklist. Pass: the draft is published as "AI-drafted, auto-checked".
// Flag: it stays off public pages and goes to the review queue with the reasons.
import { structuredCall, constitution, DraftRefused } from "./claude.js";
import { billContext } from "./prompt.js";
import { CHECKS, CHECK_LABELS } from "./review-checks.js";

export { CHECKS, CHECK_LABELS };

export const REVIEW_MODEL = "claude-sonnet-5-5";
export const REVIEW_PROMPT_VERSION = "2026-09-30.1";

export const REVIEW_INSTRUCTIONS = `You are the independent reviewer for The Pillory, a nonpartisan civic accountability site. Another model drafted a constitutional analysis of a bill. You check the draft against the bill text before it is published. You don't rewrite it: you pass it or flag it for a person.

The site's rules for every draft:
- It maps the Constitution; it doesn't rule on it. No statement or hint that the bill is or isn't constitutional, valid, lawful, or likely to be upheld or struck down.
- No party labels, no ideologies, no politicians, no loaded or partisan words. Neutral description of what the bill does.
- Each view in its strongest form, in parallel language, with the same care.
- "Uncertain" when the bill text and the Constitution don't settle something. No guessing.
- A short card has a 2 to 3 sentence summary, 1 to 3 provisions and one sentence per panel; judge it as a card, not as a full analysis. A full analysis is longer.

Already checked by code, so don't re-check them: every quote of the Constitution matches the stored text, and every court case was found in CourtListener under the same name.

Answer each check with ok true or false and a note of one or two sentences. When a check fails, name the passage and say what is wrong, so a person can fix it quickly.
- summary: ${CHECKS[0][1]} Compare with the bill text: a wrong statement, or a missing central provision, fails. A card may leave out detail.
- balance: ${CHECKS[1][1]} (ok means no: the views are treated with equal care.)
- language: ${CHECKS[2][1]} Any verdict on constitutionality fails this check. (ok means no.)
- provisions: ${CHECKS[3][1]} (ok means yes.)
- certainty: ${CHECKS[4][1]} (ok means no.)

verdict: "flag" if any check is not ok, otherwise "pass". When unsure, flag: a person will look.`;

export function reviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["checks", "verdict"],
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "ok", "note"],
          properties: { id: { type: "string", enum: CHECKS.map(([id]) => id) }, ok: { type: "boolean" }, note: { type: "string" } },
        },
      },
      verdict: { type: "string", enum: ["pass", "flag"] },
    },
  };
}

/** The draft as the reviewer sees it: what readers would see, nothing else. */
export function draftForReview(draft, depth) {
  const keep = { depth, plain_summary: draft.plain_summary, provisions: (draft.clauses || []).map((c) => ({ id: c.id, quote: c.quote, why: c.why })) };
  for (const k of ["aligns", "tension", "departure", "readings", "citations"]) if ((draft[k] || []).length) keep[k] = draft[k];
  if (draft.article_v) keep.article_v = draft.article_v;
  if (draft.uncertainty) keep.uncertainty = draft.uncertainty;
  return keep;
}

export function reviewMessage(bill, source, draft, depth) {
  return `${billContext(bill, source)}

<draft>
${JSON.stringify(draftForReview(draft, depth), null, 1)}
</draft>

Review the draft.`;
}

/**
 * The verdict as saved: every check present, and "pass" only if every check is
 * ok and the model said pass. A missing check counts as a failure. Pure; tested.
 * Returns {verdict, checks: [{id, ok, note}], reasons: [text]}.
 */
export function settleReview(data) {
  const byId = new Map(((data && data.checks) || []).filter((c) => c && CHECK_LABELS[c.id]).map((c) => [c.id, c]));
  const checks = CHECKS.map(([id]) => {
    const c = byId.get(id);
    return c ? { id, ok: c.ok === true, note: String(c.note || "").trim() } : { id, ok: false, note: "The reviewer didn't answer this check." };
  });
  const failed = checks.filter((c) => !c.ok);
  const verdict = failed.length || !data || data.verdict !== "pass" ? "flag" : "pass";
  const reasons = failed.map((c) => `${CHECK_LABELS[c.id]} ${c.note}`.trim());
  if (verdict === "flag" && !reasons.length) reasons.push("The reviewer flagged the draft without naming a failed check.");
  return { verdict, checks, reasons };
}

/**
 * Review one draft. Returns {verdict, checks, reasons, model, usage}. A refusal
 * or unusable answer is a "flag" (a person looks); other errors are thrown, and
 * the draft is reviewed again on the next run.
 */
export async function reviewDraft(env, bill, source, draft, depth) {
  try {
    const { data, model, usage } = await structuredCall(env, {
      model: env.REVIEW_MODEL || REVIEW_MODEL,
      system: [REVIEW_INSTRUCTIONS, constitution()],
      message: reviewMessage(bill, source, draft, depth),
      jsonSchema: reviewSchema(),
      maxTokens: 16000,
      thinking: true,
      effort: env.REVIEW_EFFORT || "medium",
      fallback: true,
    });
    return { ...settleReview(data), model, usage };
  } catch (err) {
    if (err instanceof DraftRefused || /not valid JSON|cut off/.test(err.message)) {
      return {
        verdict: "flag",
        checks: [],
        reasons: [`The AI reviewer couldn't finish its check (${err.message}), so a person needs to look.`],
        model: err.model || env.REVIEW_MODEL || REVIEW_MODEL,
        usage: err.usage || { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      };
    }
    throw err;
  }
}
