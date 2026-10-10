// Quick mode's plain rewrites: the checks every rewrite must pass before it's
// shown (docs/quick-mode.md). Pure; tested in test/plain.test.mjs.
//
//   - short: "what" is one or two sentences, at most WHAT_MAX_WORDS words;
//   - readable: a reading grade (Flesch-Kincaid) of at most MAX_GRADE;
//   - no new facts: every number in the rewrite is in the source, and every
//     name (a capitalized word not starting a sentence) is in the source;
//   - neutral: no loaded or judging wording (the same list as promises' notes);
//   - balanced: supporters and critics come together or not at all, each short,
//     of similar length, and only when the source has both sides.
import { wordingProblems } from "../promises/check.js";

export const WHAT_MAX_WORDS = 40;
export const SIDE_MAX_WORDS = 30;
export const MAX_GRADE = 9.5;
// Words that may be capitalized without being in the source: offices and bodies
// any summary of a law or measure refers to.
const ALLOWED_NAMES = new Set(["i", "president", "governor", "congress", "senate", "house", "state", "states", "legislature", "constitution", "court", "supreme", "federal", "u.s", "u.s.", "us", "america", "american", "americans", "a", "an", "the", "it", "this", "if", "yes", "no"]);

// Loaded words common in plain-language politics writing, on top of the shared list.
const PLAIN_LOADED = /\b(common[- ]sense|giveaways?|handouts?|slash(es|ed)?|guts?|gutted|job[- ]killing|crack(s|ed)? down|crackdown|war on|attacks? on|schemes?|rip[- ]?offs?|power grab|bail ?outs?|loopholes?|rubber[- ]stamp(s|ed)?|cronies|elites?)\b/i;

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);
const sentences = (s) => String(s || "").split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter((x) => x.trim());

/** Syllables in a word, by vowel groups (an estimate, as readability formulas use). */
export function syllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade level. */
export function readingGrade(text) {
  const w = words(text).filter((x) => /[a-z]/i.test(x));
  const s = Math.max(1, sentences(text).length);
  if (!w.length) return 0;
  const syl = w.reduce((n, x) => n + syllables(x), 0);
  return Math.round((0.39 * (w.length / s) + 11.8 * (syl / w.length) - 15.59) * 10) / 10;
}

const normNumber = (n) => n.replace(/[,$%]/g, "").replace(/\.$/, "").replace(/^0+(?=\d)/, "");
/** Numbers in a text ("$11.25 billion" → "11.25"; "2,000" → "2000"). */
export function numbersIn(text) {
  return (String(text || "").match(/\$?\d[\d,]*(?:\.\d+)?%?/g) || []).map(normNumber).filter(Boolean);
}

/** Capitalized words that don't start a sentence: the names a rewrite could add. */
export function namesIn(text) {
  const out = [];
  for (const sent of sentences(text)) {
    const ws = words(sent);
    ws.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
      if (i === 0 || !/^[A-Z]/.test(clean)) return;
      out.push(clean.replace(/'s$/, ""));
    });
  }
  return out;
}

/** Problems with one rewrite against its source text; empty when it can be shown. */
export function plainProblems(r, source, { sides = false } = {}) {
  const problems = [];
  const what = String((r && r.what) || "").trim();
  const src = String(source || "");
  const srcLower = src.toLowerCase();
  const srcNumbers = new Set(numbersIn(src));
  if (!what) return ["no rewrite"];
  if (words(what).length > WHAT_MAX_WORDS) problems.push(`too long (${words(what).length} words)`);
  if (sentences(what).length > 2) problems.push("more than two sentences");
  const grade = readingGrade(what);
  if (grade > MAX_GRADE) problems.push(`reads above grade ${MAX_GRADE} (${grade})`);
  const all = [what, r.supporters || "", r.critics || ""].join(" ");
  for (const n of numbersIn(all)) if (!srcNumbers.has(n)) problems.push(`number not in the source: ${n}`);
  for (const name of namesIn(all)) {
    if (ALLOWED_NAMES.has(name.toLowerCase())) continue;
    if (!srcLower.includes(name.toLowerCase())) problems.push(`name not in the source: ${name}`);
  }
  for (const t of [what, r.supporters, r.critics].filter(Boolean)) {
    problems.push(...wordingProblems(t));
    const m = t.match(PLAIN_LOADED);
    if (m) problems.push(`loaded or judging wording: "${m[0]}"`);
  }
  const sup = String(r.supporters || "").trim();
  const cri = String(r.critics || "").trim();
  if (sup || cri) {
    if (!sides) problems.push("supporters and critics added, but the source has no sides");
    else if (!sup || !cri) problems.push("only one side");
    else {
      const a = words(sup).length;
      const b = words(cri).length;
      if (a > SIDE_MAX_WORDS || b > SIDE_MAX_WORDS) problems.push("a side is too long");
      if (Math.max(a, b) > 1.5 * Math.min(a, b)) problems.push(`sides of unequal length (${a} and ${b} words)`);
    }
  } else if (sides) problems.push("the source has both sides; the rewrite must keep both");
  return problems;
}
