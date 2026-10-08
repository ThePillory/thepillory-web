// Checks run on every AI draft before it's saved. Pure functions, no network,
// except verifyCitations, which is handed a lookup function.
//
//   verifyQuotes     every passage quoted from the Constitution must match the
//                    stored text exactly; mismatches are replaced with the
//                    stored text and logged.
//   verifyCitations  every court case must be found by CourtListener's citation
//                    lookup under the same name; the rest are removed, with every
//                    sentence that relies on them, and logged.

// ---------------------------------------------------------------------------
// Text helpers

/** Differences that don't count: whitespace, curly vs. straight quotes, dash spacing. */
export function norm(s) {
  return String(s || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*—\s*/g, "—")
    .trim();
}

function words(s) {
  // [{w: comparable word, start, end}] with offsets into s.
  const out = [];
  const re = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
  let m;
  while ((m = re.exec(s))) out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  return out;
}

// ---------------------------------------------------------------------------
// Quotes

/** Pieces of a quote split at ellipses; each must appear, in order. */
function pieces(quote) {
  return norm(quote)
    .replace(/^["'\s.…]+|["'\s…]+$/g, "")
    .split(/\s*(?:\.\s?\.\s?\.|…)\s*/)
    .map((p) => p.replace(/^[\s,;:]+|[\s,;:]+$/g, ""))
    .filter((p) => p.length > 0);
}

/** True if the quote appears exactly (ellipses allowed) in the text. */
export function quoteMatches(quote, text) {
  const t = norm(text);
  let from = 0;
  const ps = pieces(quote);
  if (!ps.length) return false;
  for (const p of ps) {
    const i = t.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

/**
 * The stored passage most like the quote. The quote's words are lined up with
 * each provision's words in order (longest common subsequence, with common
 * words counting for less). The matched stretches are copied from the stored
 * text: short gaps are filled in, longer ones shown as an ellipsis, and a
 * stretch that ends a few words short of a phrase break is finished.
 * Returns {id, label, text, score}; every word of text is from the stored text.
 */
export function bestPassage(quote, provisions) {
  const q = words(pieces(quote).join(" "));
  if (!q.length) return null;
  const qWeight = q.reduce((t, x) => t + weight(x.w), 0);
  let best = null;
  for (const p of provisions) {
    const ws = words(p.text);
    if (!ws.length) continue;
    const m = align(q, ws);
    if (!m.matched.length) continue;
    const score = m.score / qWeight;
    const spread = m.matched[m.matched.length - 1] - m.matched[0];
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && spread < best.spread)) {
      best = { p, ws, matched: m.matched, score, spread };
    }
  }
  if (!best) return null;
  return { id: best.p.id, label: best.p.label, text: render(best.p.text, best.ws, best.matched), score: best.score };
}

function align(q, ws) {
  // Weighted LCS over words.
  const n = q.length;
  const m = ws.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = q[i].w === ws[j].w ? weight(q[i].w) + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (q[i].w === ws[j].w && dp[i][j] === weight(q[i].w) + dp[i + 1][j + 1]) {
      matched.push(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { score: dp[0][0], matched };
}

const GAP_FILL = 3; // fill gaps of up to this many words from the stored text
const FINISH = 3; // finish a stretch if a phrase break is this close

function render(text, ws, matched) {
  const breakAfter = (k) => k === ws.length - 1 || /[,;:.\u2014]/.test(text.slice(ws[k].end, ws[k + 1].start));
  const breakBefore = (k) => k === 0 || breakAfter(k - 1);
  const runs = [];
  for (const k of matched) {
    const last = runs[runs.length - 1];
    if (last && k - last[1] - 1 <= GAP_FILL) last[1] = k;
    else runs.push([k, k]);
  }
  for (const r of runs) {
    for (let d = 0; d < FINISH && !breakAfter(r[1]) && r[1] + 1 < ws.length; d++) r[1] += 1;
    if (!breakAfter(r[1])) r[1] = matched.filter((k) => k <= r[1]).pop();
    for (let d = 0; d < FINISH && !breakBefore(r[0]); d++) r[0] -= 1;
    if (!breakBefore(r[0])) r[0] = matched.find((k) => k >= r[0]);
    if (r[1] > r[0] && !matched.includes(r[0]) && /^(or|and|but|nor)$/.test(ws[r[0]].w)) r[0] += 1;
  }
  return runs.map(([a, b]) => text.slice(ws[a].start, ws[b].end)).join(" \u2026 ");
}

// Common words count for less, so a phrase is matched by what it's about.
const COMMON_WORDS = new Set(
  "a an and any as at be but by for from have he in is it its no nor not of on or shall such that the their them there they this to which who with".split(" ")
);
function weight(w) {
  return COMMON_WORDS.has(w) ? 0.3 : 1;
}

const QUOTE_RE = /["“]([^"“”]{12,}?)["”]/g;
// A quoted passage this much like some provision is treated as a quote of it.
const CONSTITUTIONAL_LIKENESS = 0.5;

/** Every free-text field of a draft, as [path, get, set]. */
export function textFields(draft) {
  const f = [];
  const str = (obj, key, path) => f.push([path, () => obj[key], (v) => (obj[key] = v)]);
  const arr = (list, path) => list.forEach((_, i) => f.push([`${path}[${i}]`, () => list[i], (v) => (list[i] = v)]));
  str(draft, "plain_summary", "plain_summary");
  (draft.clauses || []).forEach((c, i) => str(c, "why", `clauses[${i}].why`));
  arr(draft.aligns || [], "aligns");
  arr(draft.tension || [], "tension");
  arr(draft.departure || [], "departure");
  str(draft, "article_v", "article_v");
  (draft.readings || []).forEach((r, i) => {
    for (const k of ["question", "original_meaning", "precedent", "evolving"]) str(r, k, `readings[${i}].${k}`);
  });
  (draft.citations || []).forEach((c, i) => str(c, "point", `citations[${i}].point`));
  str(draft, "uncertainty", "uncertainty");
  if (draft.supporters != null) str(draft, "supporters", "supporters");
  if (draft.critics != null) str(draft, "critics", "critics");
  return f;
}

/**
 * Check every quote. Mutates the draft; returns the log.
 * - clauses[].quote must come from the provision it names.
 * - quoted passages in any text field that resemble the Constitution must match it.
 */
export function verifyQuotes(draft, provisions) {
  const byId = new Map(provisions.map((p) => [p.id, p]));
  const leaves = provisions.filter((p) => p.leaf);
  const log = { checked: 0, replaced: [], dropped: [] };

  draft.clauses = (draft.clauses || []).filter((c) => {
    const p = byId.get(c.id);
    if (!p) {
      log.dropped.push({ field: "clauses", id: c.id, reason: "no provision with this ID" });
      return false;
    }
    if (!c.quote) return true;
    log.checked += 1;
    if (quoteMatches(c.quote, p.text)) return true;
    // Prefer the named provision's own words; look elsewhere only if it's clearly another one.
    const own = bestPassage(c.quote, [p, ...provisions.filter((x) => x.parent === p.id || p.parent === x.id)]);
    const any = bestPassage(c.quote, leaves);
    const pick = own && (!any || own.score >= any.score - 0.15) ? own : any;
    log.replaced.push({ field: `clauses(${c.id}).quote`, given: c.quote, stored: pick.text, from: pick.id });
    if (pick.id !== c.id && !(own && pick === own)) {
      log.replaced[log.replaced.length - 1].note = `quote is from ${pick.id}, not ${c.id}`;
    }
    c.quote = pick.text;
    return true;
  });

  for (const [path, get, set] of textFields(draft)) {
    const text = get();
    if (!text) continue;
    const out = text.replace(QUOTE_RE, (whole, inner) => {
      if (leaves.some((p) => quoteMatches(inner, p.text))) {
        log.checked += 1;
        return whole;
      }
      const best = bestPassage(inner, leaves);
      if (!best || best.score < CONSTITUTIONAL_LIKENESS) return whole; // not a constitutional quote
      log.checked += 1;
      log.replaced.push({ field: path, given: inner, stored: best.text, from: best.id });
      return `“${best.text}”`;
    });
    if (out !== text) set(out);
  }
  return log;
}

// ---------------------------------------------------------------------------
// Sentences and case names

const ABBREV = new Set(
  "v vs u.s inc co corp ltd no nos mr mrs ms dr st jr sr cir f supp ct s l ed e.g i.e etc art sec cl stat const amend j jj c.j p pp id cf al app dist fed rev reg cong res h.r".split(" ")
);

/** Split into sentences without breaking at "v." or "U.S." and the like. */
export function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]["”')\]]*\s+(?=["“(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(start, m.index + 1);
    const last = (before.match(/([A-Za-z.]+)\.$/) || [])[1] || "";
    const lw = last.toLowerCase();
    if (ABBREV.has(lw) || /^[A-Z]$/.test(last) || /^([A-Z]\.)+[A-Z]$/.test(last)) continue;
    out.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

const PARTY = String.raw`(?:[A-Z][\w.'&’-]*|of|the|and|for|de|ex|rel\.)`;
const CASE_RE = new RegExp(String.raw`\b(?:In re\s+${PARTY}(?:\s+${PARTY})*|${PARTY}(?:\s+${PARTY}){0,6}\s+v\.\s+${PARTY}(?:\s+${PARTY}){0,6})`, "g");
const REPORTER_RE = /\b\d{1,4}\s+(?:U\.\s?S\.|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.(?:\s?(?:2d|3d|4th))?|F\.\s?Supp\.(?:\s?(?:2d|3d))?|Cal\.(?:\s?(?:2d|3d|4th|5th))?|Cal\.\s?App\.(?:\s?(?:2d|3d|4th|5th))?|Cal\.\s?Rptr\.(?:\s?(?:2d|3d))?|P\.(?:\s?(?:2d|3d))?)\s+\d{1,5}\b/g;

/** Case names ("A v. B", "In re A") mentioned in a text. */
export function caseMentions(text) {
  const out = [];
  for (const m of String(text || "").matchAll(CASE_RE)) {
    // Trim leading sentence words that aren't part of the name ("In", "The", "Under").
    let name = m[0].replace(/^(?:(?:In|Under|See|The|And|But|As|Since|After|Before|Per|Following|Citing|Like|Unlike|Both|Also)\s+)+(?!re\b)/, "");
    name = name.trim().replace(/[.,;:]+$/, "");
    if (/\sv\.\s/.test(name) || /^In re\s/.test(name)) out.push(name);
  }
  return out;
}

export function reporterCites(text) {
  return [...String(text || "").matchAll(REPORTER_RE)].map((m) => m[0]);
}

const COMMON = new Set(
  "united states state of the and for v in re inc co corp llc ltd city county people commonwealth ex rel board department dept et al assn association company national american federal government secretary commissioner district california".split(
    " "
  )
);

/** Distinctive words of a case name, for matching "Lopez" in "United States v. Lopez". */
function distinctive(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !COMMON.has(w))
  );
}

export function sameCase(a, b) {
  const x = distinctive(a);
  const y = distinctive(b);
  // Names made only of common words ("United States v. California") must match whole.
  if (!x.size || !y.size) return plainName(a) === plainName(b);
  for (const w of y) if (x.has(w)) return true;
  return false;
}

function plainName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Citations

/**
 * lookup(citations: string[], caseNames: string[]) -> Promise<results[]>, one per input, each
 *   {status: "found", case_name, url, citation} | {status: "not_found" | "invalid" | "error", message}
 * Only citations CourtListener finds under a matching case name are kept.
 * Anything else is removed, along with every sentence that names that case
 * or cites it, and every sentence naming a case that isn't a verified citation.
 */
export async function verifyCitations(draft, lookup) {
  const log = { checked: [], removed_citations: [], removed_sentences: [] };
  const cites = draft.citations || [];
  let results;
  try {
    results = cites.length ? await lookup(cites.map((c) => c.citation), cites.map((c) => c.case_name)) : [];
  } catch (err) {
    results = cites.map(() => ({ status: "error", message: `lookup failed: ${err.message}` }));
  }
  const kept = [];
  const bad = [];
  cites.forEach((c, i) => {
    const r = results[i] || { status: "error", message: "no result" };
    const entry = { case_name: c.case_name, citation: c.citation, status: r.status };
    if (r.status === "found" && !sameCase(c.case_name, r.case_name)) {
      entry.status = "name_mismatch";
      entry.message = `that citation is ${r.case_name}`;
    } else if (r.message) entry.message = r.message;
    if (r.url) entry.url = r.url;
    log.checked.push(entry);
    if (entry.status === "found") {
      kept.push({ case_name: r.case_name || c.case_name, citation: r.citation || c.citation, url: r.url, point: c.point || "" });
    } else {
      bad.push(c);
      log.removed_citations.push(entry);
    }
  });
  draft.citations = kept;

  // Sentences that rely on a removed or never-listed case go too.
  const verifiedNames = kept.map((k) => k.case_name);
  const badCites = bad.map((b) => norm(b.citation)).filter(Boolean);
  const reliesOnUnverified = (sentence) => {
    for (const b of bad) if (b.case_name && (sentence.includes(b.case_name) || mentionsCase(sentence, b.case_name))) return b.case_name;
    for (const c of badCites) if (norm(sentence).includes(c)) return c;
    for (const m of caseMentions(sentence)) if (!verifiedNames.some((v) => sameCase(v, m))) return m;
    for (const r of reporterCites(sentence)) if (!kept.some((k) => norm(k.citation).includes(norm(r)))) return r;
    return null;
  };
  for (const [path, get, set] of textFields(draft)) {
    const text = get();
    if (!text || path.startsWith("citations[")) continue;
    const sentences = splitSentences(text);
    const keep = [];
    for (const s of sentences) {
      const why = reliesOnUnverified(s);
      if (why) log.removed_sentences.push({ field: path, sentence: s, because: why });
      else keep.push(s);
    }
    if (keep.length !== sentences.length) set(keep.join(" "));
  }
  // Drop list items that ended up empty.
  for (const k of ["aligns", "tension", "departure"]) draft[k] = (draft[k] || []).filter((t) => t && t.trim());
  draft.readings = (draft.readings || []).filter((r) => r.original_meaning || r.precedent || r.evolving);
  return log;
}

function mentionsCase(sentence, caseName) {
  return caseMentions(sentence).some((m) => sameCase(m, caseName) && distinctive(caseName).size > 0);
}
