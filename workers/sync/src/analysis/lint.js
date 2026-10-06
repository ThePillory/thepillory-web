// Checks on a draft's wording, run before the AI reviewer sees it. Pure; tested.
// Each problem found goes back to the drafter in the revision step, so the
// common reasons drafts were flagged are fixed at the source:
//
//   - a verdict in a panel ("fits the Tenth Amendment", "falls within this
//     power", "is a valid exercise of"): ThePillory maps the Constitution and
//     doesn't rule on it;
//   - panels not written in the same form ("One view is that …") or of very
//     different lengths, which reads as one side treated with more care;
//   - a draft of a partly read bill (or of the summary only) that doesn't say so.

/** Phrasings that state a conclusion about a bill's constitutional footing. */
export const VERDICTS = [
  [/\bfits?\b[^.]{0,40}\b(power|clause|amendment|authority|article|constitution|framework|baseline)/i, '"fits …"'],
  [/\bfall(s|ing)? (squarely |comfortably |clearly |well )?(within|under|inside)\b/i, '"falls within …"'],
  [/\b(is|are|would be|remains?) (a |an )?(valid|proper|permissible|legitimate|lawful|appropriate|sound) (exercise|use)\b/i, '"a valid exercise of …"'],
  [/\b(is|are|would be) (constitutionally )?(valid|permissible|lawful|authorized|sound|proper)\b/i, '"is valid / permissible / authorized"'],
  [/\bwithin (the )?(scope of )?(congress'?s?|the legislature'?s?|the state'?s?|the federal government'?s?|its|their)( enumerated| constitutional| legislative)? (power|powers|authority)\b/i, '"within Congress\'s power"'],
  [/\b(rests?|rely|relies|resting) (squarely |firmly )?on\b/i, '"rests on …"'],
  [/\bacts? (squarely |largely )?(through|under|within) (congress'?s?|its|the)\b/i, '"acts through … power"'],
  [/\b(satisf(y|ies)|compl(y|ies) with|is consistent with|conforms? to|is in keeping with|honou?rs|respects) (the )?(tenth|first|second|fourth|fifth|sixth|eighth|fourteenth|commerce|spending|supremacy|necessary|equal|due|establishment|free)/i, '"satisfies / complies with / is consistent with [a provision]"'],
  [/\b(clearly|plainly|squarely|unquestionably|undoubtedly|firmly|well within)\b/i, "a word of certainty (clearly, plainly, squarely…)"],
  [/\bunconstitutional\b|\b(is|are|be|being|remains?) (likely |probably |plainly |clearly )?constitutional\b/i, '"is constitutional" / "unconstitutional"'],
];

export const PANEL_LEAD = /^One view is that\b/;
const PANELS = [
  ["aligns", "Where it aligns"],
  ["tension", "Where it may be in tension"],
  ["departure", "Why this might still serve the public"],
];
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

/** The sentence a draft of a partly read bill must contain, by basis. */
export function limitedSentence(basis) {
  if (basis === "summary_only") return /only (the |an )?official summary (was|of the bill was) read/i;
  if (basis === "partial_text") return /only part of (the|this) bill'?s? text was read/i;
  return null;
}

/**
 * Problems in a draft (in the full analysis's shape: aligns/tension/departure
 * are lists). `depth` "card" also checks that the three panels are of similar
 * length. Returns a list of plain-language problems, empty when it's clean.
 */
export function lintDraft(draft, { basis = "full_text", depth = "card" } = {}) {
  const problems = [];
  const panels = PANELS.map(([key, label]) => [key, label, (draft[key] || []).map((s) => String(s || "").trim()).filter(Boolean)]);

  for (const [, label, items] of panels) {
    for (const text of items) {
      for (const [re, what] of VERDICTS) {
        const m = text.match(re);
        if (m) {
          problems.push(`"${label}" states a verdict (${what}): "…${m[0]}…". ThePillory maps the Constitution and doesn't rule on it. Describe a view a careful reader could hold ("One view is that … because …"), not a conclusion.`);
          break;
        }
      }
      if (!PANEL_LEAD.test(text)) problems.push(`"${label}" doesn't start "One view is that". Write every panel in the same form, with the same hedging: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
    }
  }
  // The summary and readings mustn't rule either.
  for (const [re, what] of VERDICTS.slice(0, 8)) {
    const m = String(draft.plain_summary || "").match(re);
    if (m) {
      problems.push(`The summary states a verdict (${what}): "…${m[0]}…". Describe what the bill does, not its constitutional footing.`);
      break;
    }
  }

  // Equal care: in a card, the panels that are present are of similar length.
  if (depth === "card") {
    const lens = panels.filter(([, , items]) => items.length).map(([, label, items]) => [label, words(items.join(" "))]);
    if (lens.length >= 2) {
      const max = lens.reduce((a, b) => (b[1] > a[1] ? b : a));
      const min = lens.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (min[1] > 0 && max[1] / min[1] > 1.6 && max[1] - min[1] > 8) {
        problems.push(`The panels aren't of similar length ("${max[0]}" ${max[1]} words, "${min[0]}" ${min[1]} words). Give each view the same care: one sentence of 20 to 35 words each.`);
      }
    }
  }

  // A partly read bill says so, in the summary.
  const must = limitedSentence(basis);
  if (must && !must.test(String(draft.plain_summary || ""))) {
    problems.push(
      basis === "summary_only"
        ? 'The bill text wasn\'t available; only the official summary was read. The summary must say so in a sentence starting "Only the official summary was read".'
        : 'Only part of the bill text was read. The summary must say so in a sentence starting "Only part of the bill text was read", and nothing may describe what sections outside the text read contain.'
    );
  }
  return [...new Set(problems)];
}
