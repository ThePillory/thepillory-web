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

// ---------------------------------------------------------------------------
// The global search (the box at the top of every page): bills and meetings
// too, as typed. Every query is bounded: a bill by number through the
// bill_list_number_key index (migration 0032), a bill by title among the most
// recently voted bills only, a meeting among the last 60 days and the coming
// ones. Never a whole table.

export const GLOBAL_LIMIT = 8;
/** Bills searched by title: the most recently voted, newest first. */
export const RECENT_BILLS = 4000;

/** "H.R. 1234", "hr1234", "AB 5" → "hr1234", "ab5"; null when the query isn't a bill number. Pure. */
export function numberKey(q) {
  const s = String(q || "").trim();
  if (!/^[A-Za-z][A-Za-z.\s]{0,11}\s*\d{1,5}$/.test(s)) return null;
  // A bill's letters are a short prefix ("HR", "SB", "HJRes"), never a word like "water".
  if (s.replace(/[^A-Za-z]/g, "").length > 7 || /[a-z]{5,}/.test(s.replace(/res/gi, ""))) return null;
  return s.toLowerCase().replace(/[.\s]/g, "");
}

const like = (w) => `%${w.replace(/[%_]/g, "")}%`;

async function bills(db, q) {
  if (!db) return [];
  const key = numberKey(q);
  const ws = words(q);
  const byNumber = key
    ? db
        .prepare(`SELECT bill_id, bill_number, title, level, st FROM bill_list
                  WHERE lower(replace(replace(bill_number, '.', ''), ' ', '')) = ? ORDER BY last_vote DESC LIMIT ?`)
        .bind(key, GLOBAL_LIMIT)
        .all()
    : Promise.resolve({ results: [] });
  const byTitle = ws.length
    ? db
        .prepare(`SELECT bill_id, bill_number, title, level, st FROM (
                    SELECT bill_id, bill_number, title, level, st, last_vote FROM bill_list ORDER BY last_vote DESC LIMIT ${RECENT_BILLS})
                  WHERE ${ws.map(() => "lower(bill_number || ' ' || title) LIKE ?").join(" AND ")} ORDER BY last_vote DESC LIMIT ?`)
        .bind(...ws.map(like), GLOBAL_LIMIT)
        .all()
    : Promise.resolve({ results: [] });
  const [a, b] = await Promise.all([byNumber, byTitle]);
  const seen = new Set();
  return [...a.results, ...b.results]
    .filter((r) => !seen.has(r.bill_id) && seen.add(r.bill_id))
    .slice(0, GLOBAL_LIMIT)
    .map((r) => ({
      type: "Bill",
      name: `${r.bill_number}: ${r.title}`,
      sub: r.level === "federal" ? "Federal" : r.st ? `State · ${r.st}` : "State",
      href: `/laws/bills/${encodeURIComponent(r.bill_id)}/`,
    }));
}

async function meetings(db, q) {
  const ws = words(q);
  if (!db || !ws.length) return [];
  const { results } = await db
    .prepare(`SELECT id, body, meeting_type, starts_at, level FROM meetings
              WHERE status != 'cancelled' AND starts_at >= date('now', '-60 days')
                AND ${ws.map(() => "lower(body || ' ' || IFNULL(meeting_type, '') || ' meeting agenda hearing') LIKE ?").join(" AND ")}
              ORDER BY starts_at LIMIT ?`)
    .bind(...ws.map(like), GLOBAL_LIMIT)
    .all()
    .catch(() => ({ results: [] }));
  return results.map((m) => ({
    type: "Meeting",
    name: `${m.body}: ${m.meeting_type || "Meeting"}`,
    sub: `${m.level === "state" ? "State" : "County"} · ${String(m.starts_at).slice(0, 10)}`,
    href: `/meetings/${encodeURIComponent(m.id)}/`,
  }));
}

/** People (as searchPeople), bills and meetings for the global search; null when the query is too short. */
export async function searchAll(env, request, raw) {
  const q = cleanQuery(raw);
  if (!q) return null;
  const [people, b, m] = await Promise.all([
    searchPeople(env, request, q),
    bills(env.DB, q).catch(() => []),
    meetings(env.DB, q),
  ]);
  return { ...people, bills: b, meetings: m };
}
