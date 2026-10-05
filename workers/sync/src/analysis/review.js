// The AI reviewer pass: a separate claude-sonnet-5-5 call that reads a draft
// (after the quote and citation checks) against the bill text and answers a
// fixed checklist, rating each failed check major or minor.
//   - major (a factual error, unfair to one side, opinion stated as fact): flag.
//     The draft stays off public pages and goes to the review queue.
//   - minor only (completeness, phrasing, style): pass. The draft is revised once
//     to fix them; any minor notes left are published under the analysis.
import { structuredCall, constitution, DraftRefused } from "./claude.js";
import { billContext } from "./prompt.js";
import { CHECKS, CHECK_LABELS, SEVERITIES } from "./review-checks.js";

export { CHECKS, CHECK_LABELS, SEVERITIES };

export const REVIEW_MODEL = "claude-sonnet-5-5";
export const REVIEW_PROMPT_VERSION = "2026-10-05.2";

export const REVIEW_INSTRUCTIONS = `You are the independent reviewer for ThePillory, a nonpartisan civic accountability site. Another model drafted a constitutional analysis of a bill. You check the draft against the bill text before it is published. You don't rewrite it: you pass it or flag it for a person.

The site's rules for every draft:
- It maps the Constitution; it doesn't rule on it. No statement or hint that the bill is or isn't constitutional, valid, lawful, or likely to be upheld or struck down.
- No party labels, no ideologies, no politicians, no loaded or partisan words. Neutral description of what the bill does.
- Each view in its strongest form, in parallel language, with the same care.
- "Uncertain" when the bill text and the Constitution don't settle something. No guessing.
- A short card has a 2 to 3 sentence summary, 1 to 3 provisions and one sentence per panel; judge it as a card, not as a full analysis. A full analysis is longer.

Already checked by code, so don't re-check them: every quote of the Constitution matches the stored text, and every court case was found in CourtListener under the same name.

Answer each check with ok true or false, a severity, and a note of one or two sentences. When a check fails, name the passage and say what is wrong, so it can be fixed quickly.
- summary: ${CHECKS[0][1]} Compare with the bill text.
- balance: ${CHECKS[1][1]} (ok means no: the views are treated with equal care.)
- language: ${CHECKS[2][1]} Any verdict on constitutionality fails this check. (ok means no.)
- provisions: ${CHECKS[3][1]} (ok means yes.)
- certainty: ${CHECKS[4][1]} (ok means no.)

severity: "none" when the check is ok. When it fails:
- "major": a reader would be misled, or one side treated unfairly:
  - a factual error: the draft says something the bill text contradicts or doesn't say (a wrong amount, date, deadline, actor, power or effect), or leaves out a provision so that what it does say becomes wrong;
  - unfair to one side: a view misstated, dismissed, or put in a weaker form than its best version (a strawman), or partisan or loaded language (a word that takes a side, such as "nullifying" where "overturning" or "disapproving" says the same);
  - opinion stated as fact: any verdict on constitutionality (including that the bill fits, rests on or "acts through" a power), or a contested reading or prediction presented as settled.
- "minor": the draft is accurate and fair but could be better: completeness (a detail or a relevant provision left out without making anything said wrong), phrasing, clarity, length, order, or style. A card leaving out detail is at most minor.
  - Panels of uneven length or detail are minor when each view is still stated fairly: one panel a sentence shorter, or less specific, than another is not unfair to one side.
  - A hedged statement is not opinion stated as fact. "Is one source of authority", "may", "could be read as", "a reader might ask" describe a possibility, not a verdict; at most suggest firmer sourcing as a minor note.
When you can't tell whether a failure is major or minor, it is major.

verdict: "flag" if any check fails with severity "major", otherwise "pass".`;

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
          required: ["id", "ok", "severity", "note"],
          properties: {
            id: { type: "string", enum: CHECKS.map(([id]) => id) },
            ok: { type: "boolean" },
            severity: { type: "string", enum: ["none", "minor", "major"] },
            note: { type: "string" },
          },
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
 * The verdict as saved. Every check is present; a missing check counts as a
 * major failure, and so does a failed check without a valid severity. "flag"
 * only for a major failure (or a flag with no failed check, which a person
 * should see); minor failures pass, with their notes kept. Pure; tested.
 * Returns {verdict, checks: [{id, ok, severity, note}], reasons: [major], notes: [minor], version}.
 */
export function settleReview(data) {
  const byId = new Map(((data && data.checks) || []).filter((c) => c && CHECK_LABELS[c.id]).map((c) => [c.id, c]));
  const checks = CHECKS.map(([id]) => {
    const c = byId.get(id);
    if (!c) return { id, ok: false, severity: "major", note: "The reviewer didn't answer this check." };
    const ok = c.ok === true;
    return { id, ok, severity: ok ? "none" : c.severity === "minor" ? "minor" : "major", note: String(c.note || "").trim() };
  });
  const major = checks.filter((c) => !c.ok && c.severity === "major");
  const minor = checks.filter((c) => !c.ok && c.severity === "minor");
  const unexplained = !data || (data.verdict === "flag" && !major.length && !minor.length);
  const verdict = major.length || unexplained ? "flag" : "pass";
  const reasons = major.map((c) => `${CHECK_LABELS[c.id]} ${c.note}`.trim());
  if (unexplained) reasons.push("The reviewer flagged the draft without naming a failed check.");
  const notes = minor.map((c) => c.note).filter(Boolean);
  return { verdict, checks, reasons, notes, version: REVIEW_PROMPT_VERSION };
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
        notes: [],
        version: REVIEW_PROMPT_VERSION,
        model: err.model || env.REVIEW_MODEL || REVIEW_MODEL,
        usage: err.usage || { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      };
    }
    throw err;
  }
}
