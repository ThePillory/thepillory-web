// Search people by name: current officials (D1), Supreme Court justices
// (data/scotus/justices.json) and candidates (data/candidates/<year>/names.json,
// written by tools/build_candidates.mjs). Used by the Reps tab's search box and
// /api/search-officials?q=. Every word typed must appear in the name; results
// are capped, so a search never reads every official.
import { asset } from "./geo.js";
import { loadJustices } from "./scotus.js";
import { fecDisplayName, candidateHref, YEAR } from "./candidates.js";

export const SEARCH_LIMIT = 20;
const words = (q) => String(q || "").toLowerCase().replace(/[^a-z0-9.'\- ]+/g, " ").split(/\s+/).filter((w) => w.length > 0).slice(0, 5);

/** The query as it's searched: trimmed, at most 60 characters; null when too short. Pure. */
export function cleanQuery(q) {
  const s = String(q || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return s.replace(/[^A-Za-z0-9]/g, "").length >= 2 ? s : null;
}

/** True when every word of the query is in the name. Pure. */
export function nameMatches(name, q) {
  const n = String(name || "").toLowerCase();
  return words(q).every((w) => n.includes(w));
}

const CANDIDATE_OFFICE = { S: "U.S. Senate", H: "U.S. House", P: "President" };

/** Candidate rows from the name index: [id, FEC name, state, office, district]. Pure. */
export function matchCandidates(rows, q, limit = SEARCH_LIMIT) {
  const out = [];
  for (const [id, raw, st, office, district] of rows || []) {
    const name = fecDisplayName(raw);
    if (!nameMatches(name, q)) continue;
    const where = office === "H" ? `${st}${district && district !== "00" && district !== "0" ? `-${Number(district)}` : ""}` : st;
    out.push({ type: "Candidate", name, sub: `${CANDIDATE_OFFICE[office] || "Office"} · ${where}`, href: candidateHref(id) });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Justices matching the query. Pure. */
export function matchJustices(justices, q) {
  return (justices || [])
    .filter((j) => nameMatches(j.name, q))
    .map((j) => ({ type: "Justice", name: j.name, sub: j.title || "Supreme Court", href: `/justices/${j.slug}/` }));
}

async function officials(db, q) {
  const ws = words(q);
  if (!db || !ws.length) return [];
  const { results } = await db
    .prepare(
      `SELECT slug, name, office, district FROM officials WHERE active = 1 AND ${ws.map(() => "lower(name) LIKE ?").join(" AND ")}
       ORDER BY CASE WHEN chamber LIKE 'us-%' THEN 0 ELSE 1 END, last_name COLLATE NOCASE, name LIMIT ?`
    )
    .bind(...ws.map((w) => `%${w.replace(/[%_]/g, "")}%`), SEARCH_LIMIT)
    .all();
  return results.map((o) => ({ type: "Official", name: o.name, sub: [o.office, o.district].filter(Boolean).join(" · "), href: `/reps/${o.slug}/` }));
}

/** {query, officials, justices, candidates} for a query; null when the query is too short. */
export async function searchPeople(env, request, raw) {
  const q = cleanQuery(raw);
  if (!q) return null;
  const [o, j, c] = await Promise.all([
    officials(env.DB, q),
    loadJustices(env, request).then((d) => matchJustices(d && d.justices, q)).catch(() => []),
    asset(env, request, `/data/candidates/${YEAR}/names.json`).then((d) => matchCandidates(d && d.candidates, q)).catch(() => []),
  ]);
  return { query: q, officials: o, justices: j, candidates: c };
}
