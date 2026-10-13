// States' own certified candidate lists for the November ballot's U.S. Senate
// and House races (data/elections/certified-2026/<st>.json, written by
// tools/build_certified_lists.py from each state's election office). Once a
// state's file is loaded, its races show the candidates the state certified,
// never the FEC filing list; a race the file doesn't cover keeps the address
// lookup and the state's official list link. California's certified list comes
// with its full election instead (functions/_lib/elections.js).
//
// A certified candidate is tied to an FEC filing only when exactly one filer in
// the same race has the same last name and a matching first name, and that
// filer matches no other certified name. Otherwise there's no link: never a
// guess.
import { asset } from "./geo.js";

export const CERTIFIED_YEAR = 2026;

/** The state's certified list, or null when it isn't loaded. */
export const loadCertified = (env, request, st) =>
  /^[A-Z]{2}$/.test(st) ? asset(env, request, `/data/elections/certified-${CERTIFIED_YEAR}/${st.toLowerCase()}.json`) : null;

const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "sen", "senator", "rep", "hon", "prof", "rev", "gen", "col", "maj", "capt", "lt", "sgt"]);
const words = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-–]/g, " ")
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && !SUFFIX.has(w) && !TITLES.has(w));

/** A certified name ("Mahesh (Max) Ganorkar") → { tokens, nicknames }. Pure. */
function certName(name) {
  const nick = [...String(name).matchAll(/\(([^)]+)\)/g)].map((m) => words(m[1])[0]).filter(Boolean);
  return { tokens: words(String(name).replace(/\([^)]*\)/g, " ")), nicknames: nick };
}

/** The FEC's "LAST, FIRST MIDDLE" → { last: [...], first }. Pure. */
function fecName(raw) {
  const [last, rest = ""] = String(raw || "").split(/,(.*)/s);
  return { last: words(last), first: words(rest)[0] || "" };
}

const firstMatches = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))));

/** Does certified name `c` name FEC filer `f`? Same last name, and a matching first name or nickname. Pure. */
export function sameCandidate(certified, fecRaw) {
  const c = certName(certified);
  const f = fecName(fecRaw);
  if (!f.last.length || c.tokens.length < f.last.length + 1) return false;
  const tail = c.tokens.slice(-f.last.length);
  if (tail.join(" ") !== f.last.join(" ")) return false;
  return [c.tokens[0], ...c.nicknames].some((x) => firstMatches(x, f.first));
}

/** Each certified candidate with `fec` set where exactly one filer in the race matches, and only them. Pure. */
export function matchFec(cands, fecList) {
  const hits = cands.map((c) => fecList.filter((f) => sameCandidate(c.name, f.name)));
  const claims = new Map();
  for (const h of hits) if (h.length === 1) claims.set(h[0].id, (claims.get(h[0].id) || 0) + 1);
  return cands.map((c, i) => {
    const h = hits[i];
    const fec = h.length === 1 && claims.get(h[0].id) === 1 ? h[0] : null;
    return { ...c, fec: fec ? { id: fec.id, url: fec.url || null } : null };
  });
}

/**
 * One race from a state's certified list: "senate" or "house-<n>" (at-large "house-0").
 * { candidates, source, read_on } or null when the list doesn't cover that race. Pure.
 */
export function certifiedRace(file, key, fecList = []) {
  if (!file || !file.contests) return null;
  let list = null;
  if (key === "senate") list = file.contests.senate;
  else {
    const m = /^house-(\d+)$/.exec(key);
    const house = file.contests.house || {};
    if (m) list = house[String(Number(m[1]))] || (m[1] === "0" || m[1] === "1" ? house.AL || house["0"] : null);
  }
  if (!Array.isArray(list) || !list.length) return null;
  return { candidates: matchFec(list, fecList), source: file.source || {}, read_on: file.read_on || null };
}

/** Candidates as the state's list gives them, the same line for each: "Party · Incumbent". Pure. */
export const certifiedMeta = (c) => [c.party || "No party listed", c.incumbent ? "Incumbent" : ""].filter(Boolean).join(" · ");
