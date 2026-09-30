// The AI reviewer's checklist. Pure (no SDK import), because the review page
// (functions/admin) shows these questions too, and the Pages Functions build
// can't bundle the Anthropic SDK: only the sync Worker installs it.
export const CHECKS = [
  ["summary", "Is the summary accurate and complete for what the bill does?"],
  ["balance", "Is any side's argument noticeably weaker or less charitable than the other's?"],
  ["language", "Is opinion stated as fact, or is there loaded or partisan language?"],
  ["provisions", "Are the chosen provisions relevant, with nothing obviously missing?"],
  ["certainty", "Does anything claim more certainty than the sources support?"],
];
export const CHECK_LABELS = Object.fromEntries(CHECKS.map(([id, q]) => [id, q]));
