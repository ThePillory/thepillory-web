// Who an edition is for (docs/email.md): the three levels and their edition keys, and the
// districts each one covers. Pure; tested.
//
//   national  'national'
//   zip       'zip-95247': its districts from data/zip/ (built from Census files), read
//             when the edition is built, so a ZIP that spans several districts lists each
//   exact     'x-CA-5-4-8-06009' (state, congressional, state upper, state lower, county):
//             one district of each kind, from an address looked up once (never stored)
import { districtKey, districtLabel, chamberIds } from "../states.js";

export const LEVELS = ["national", "zip", "exact"];
const part = (v) => String(v == null ? "" : v).replace(/[^A-Za-z0-9]+/g, "_");

/** The edition a subscriber gets. */
export function editionKey(s) {
  if (!s || s.level === "national" || (s.level === "zip" && !s.zip) || (s.level === "exact" && !s.st)) return "national";
  if (s.level === "zip") return `zip-${s.zip}`;
  return `x-${[s.st, s.cd, s.su, s.sl, s.co].map(part).join("-")}`;
}

/** A ZIP's district sets from its data/zip/<first 3 digits>.json file: [{st, cd, su, sl, co, share}]. */
export function zipCombos(file, zip) {
  const rows = (file && file[zip]) || [];
  return rows.map(([st, cd, su, sl, co, share]) => ({ st, cd: cd == null ? null : String(cd), su: su == null ? null : String(su), sl: sl == null ? null : String(sl), co: co || null, share: share == null ? null : Number(share) }));
}

/** The data/zip/ file a ZIP is in. */
export const zipFile = (zip) => `/data/zip/${String(zip).slice(0, 3)}.json`;

/**
 * An edition's place: what it's based on and every district it covers.
 * {level, zip, st, cds: [...], upper: [[chamber, key, name]], lower: [...], counties: [fips], exact, combos}
 * null when a ZIP isn't in the data (the subscriber then gets the National edition).
 */
export function placeOf(s, combos = []) {
  if (!s || s.level === "national") return { level: "national" };
  const sets = s.level === "exact" ? [{ st: s.st, cd: s.cd, su: s.su, sl: s.sl, co: s.co }] : combos;
  if (!sets.length) return null;
  // A ZIP in more than one state (a handful do): the state most of it is in.
  const st = s.level === "exact" ? s.st : [...sets].sort((a, b) => (b.share || 0) - (a.share || 0))[0].st;
  const mine = sets.filter((c) => c.st === st);
  const ids = chamberIds(st);
  const uniq = (a) => [...new Set(a.filter((x) => x != null && x !== ""))];
  const seats = (field, type, chamber) => {
    const seen = new Map();
    for (const c of mine) {
      const key = districtKey(st, type, c[field]);
      if (key && !seen.has(key)) seen.set(key, [chamber, key, c[field]]);
    }
    return [...seen.values()];
  };
  return {
    level: s.level,
    zip: s.zip || null,
    st,
    cds: uniq(mine.map((c) => c.cd)).sort((a, b) => Number(a) - Number(b)),
    upper: seats("su", ids.lower ? "upper" : "legislature", ids.upper),
    lower: ids.lower ? seats("sl", "lower", ids.lower) : [],
    counties: uniq(mine.map((c) => c.co)),
    exact: s.level === "exact",
  };
}

/** A list in words: "4", "4 and 5", "4, 5 and 9". */
export function andList(a) {
  return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** "Congressional District 5", "Congressional Districts 4 and 5", "the at-large district". */
export function cdWords(cds) {
  const named = cds.filter((d) => d !== "0");
  if (!named.length) return "the at-large congressional district";
  return named.length === 1 ? `Congressional District ${named[0]}` : `Congressional Districts ${andList(named)}`;
}

/** The legislative districts in words, e.g. "Senate District 4 and Assembly District 8". */
export function legWords(place) {
  const labels = [
    ...place.upper.map(([, , name]) => districtLabel(place.st, chamberIds(place.st).lower ? "upper" : "legislature", name)),
    ...place.lower.map(([, , name]) => districtLabel(place.st, "lower", name)),
  ].filter(Boolean);
  return andList(labels);
}
