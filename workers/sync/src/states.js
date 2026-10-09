// Every state's legislature and executive branch: chamber ids, names and office
// titles, district keys, and the short integer keys that store state vote
// positions compactly. Pure (no D1, no network): the sync Worker and the Pages
// Functions both import it. See docs/states.md.
//
// Chamber ids: California keeps the ids it has had since the start
// ('ca-senate', 'ca-assembly', 'ca-executive'); every other state uses
// '<st>-upper', '<st>-lower', '<st>-legislature' (one chamber: Nebraska, and
// the Council of the District of Columbia) and '<st>-executive'.

export const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
// Places with a legislature in Open States beyond the 50 states.
export const OTHER_JURISDICTIONS = ["DC", "PR"];
export const ALL_JURISDICTIONS = [...STATES, ...OTHER_JURISDICTIONS];

// State FIPS code -> USPS code, for the waitlist (stored by county FIPS).
export const FIPS_STATE = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY", "72": "PR",
};

// By 2020 Census population, largest first: only the tiebreak when visitors
// and waitlist signups don't decide the order (src/state-priority.js).
export const BY_POPULATION = [
  "CA", "TX", "FL", "NY", "PA", "IL", "OH", "GA", "NC", "MI", "NJ", "VA", "WA", "AZ", "MA", "TN", "IN", "MD", "MO", "WI",
  "CO", "MN", "SC", "AL", "LA", "KY", "OR", "OK", "CT", "UT", "IA", "NV", "AR", "MS", "KS", "NM", "NE", "ID", "WV", "HI",
  "NH", "ME", "RI", "MT", "DE", "SD", "ND", "AK", "VT", "WY", "PR", "DC",
];

const ONE_CHAMBER = new Set(["NE", "DC"]);
// Lower chambers not called the House of Representatives.
const LOWER_NAME = {
  CA: "Assembly", NV: "Assembly", NY: "Assembly", WI: "Assembly", NJ: "General Assembly",
  MD: "House of Delegates", VA: "House of Delegates", WV: "House of Delegates", PR: "House of Representatives",
};
const LOWER_TITLE = { CA: "Assemblymember", NV: "Assemblymember", NY: "Assemblymember", WI: "Assemblymember", NJ: "Assemblymember", MD: "Delegate", VA: "Delegate", WV: "Delegate" };

/** The chamber ids for a state's legislature and executive branch. */
export function chamberIds(st) {
  const s = String(st || "").toUpperCase();
  if (s === "CA") return { upper: "ca-senate", lower: "ca-assembly", executive: "ca-executive" };
  const p = s.toLowerCase();
  if (ONE_CHAMBER.has(s)) return { upper: `${p}-legislature`, lower: null, executive: `${p}-executive` };
  return { upper: `${p}-upper`, lower: `${p}-lower`, executive: `${p}-executive` };
}

const CHAMBER_RE = /^([a-z]{2})-(upper|lower|legislature|executive|senate|assembly)$/;

/** 'tx-upper' -> { st: 'TX', type: 'upper' }; 'ca-assembly' -> { st: 'CA', type: 'lower' }; null for Congress and counties. */
export function parseChamber(chamber) {
  const m = CHAMBER_RE.exec(String(chamber || ""));
  if (!m || m[1] === "us") return null;
  const type = m[2] === "senate" ? "upper" : m[2] === "assembly" ? "lower" : m[2];
  return { st: m[1].toUpperCase(), type };
}

export const isStateLegislature = (chamber) => {
  const p = parseChamber(chamber);
  return !!p && p.type !== "executive";
};
export const isStateExecutive = (chamber) => {
  const p = parseChamber(chamber);
  return !!p && p.type === "executive";
};

/** "Texas Senate", "Massachusetts House of Representatives", "Nebraska Legislature". */
export function chamberName(st, type, stateName = "") {
  const s = String(st || "").toUpperCase();
  const lead = stateName ? `${stateName} ` : "";
  if (s === "DC") return "Council of the District of Columbia";
  if (type === "legislature") return `${lead}Legislature`;
  if (type === "upper") return `${lead}Senate`;
  if (type === "lower") return `${lead}${LOWER_NAME[s] || "House of Representatives"}`;
  if (type === "executive") return `${lead}executive branch`;
  return lead.trim();
}

/** Short chamber name for a district label: "Senate", "House", "Assembly", "House of Delegates". */
export function chamberShort(st, type) {
  const s = String(st || "").toUpperCase();
  if (s === "DC") return "Ward";
  if (type === "upper" || type === "legislature") return s === "NE" ? "Legislative" : "Senate";
  const n = LOWER_NAME[s];
  return n && n !== "House of Representatives" ? n : "House";
}

/** The title a member holds: "State Senator", "State Representative", "Assemblymember", "Delegate", "Councilmember". */
export function memberTitle(st, type) {
  const s = String(st || "").toUpperCase();
  if (s === "DC") return "Councilmember";
  if (type === "upper" || type === "legislature") return "State Senator";
  return LOWER_TITLE[s] || "State Representative";
}

/** "Senate District 12", "7th Hampden House District", "Ward 2": a district as the member's label. */
export function districtLabel(st, type, district) {
  const d = String(district || "").trim();
  if (!d) return null;
  const s = String(st || "").toUpperCase();
  if (s === "DC") return /^ward\b/i.test(d) ? d : /^\d+$/.test(d) ? `Ward ${d}` : d;
  if (/^at[- ]large$/i.test(d)) return `${chamberShort(st, type)}, at large`;
  // A numbered district ("12", "4B") after the chamber; a named one ("7th Hampden") before it.
  return /^\d+[A-Z]?$/i.test(d) ? `${chamberShort(st, type)} District ${d}` : `${d} ${chamberShort(st, type)} District`;
}

/**
 * The key a district is matched on, the same for the Census Bureau's name
 * ("Merrimack 06", "Norfolk-Worcester-Middlesex", "7") and Open States'
 * ("Merrimack 6", "Norfolk, Worcester and Middlesex", "7"): lowercase letters
 * and numbers without leading zeros, without the words "and", "district" and
 * "ward". Idaho's House elects two members per district, in seats A and B;
 * the Census maps the district, so the seat letter is dropped there.
 */
export function districtKey(st, type, name) {
  let s = String(name == null ? "" : name).trim();
  if (!s) return "";
  if (String(st).toUpperCase() === "ID" && type === "lower") s = s.replace(/^(\d+)\s*[AB]$/i, "$1");
  return s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/\b(and|district|ward)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t.replace(/^0+(?=\d)/, "")))
    .join("");
}

// Executive offices as Open States names them, in a fixed order (rank).
const EXECUTIVE = [
  [/^governor$/, "Governor"],
  [/^lt[_ ]?governor$|^lieutenant governor$/, "Lieutenant Governor"],
  [/^attorney[_ ]general$|^attorney$/, "Attorney General"],
  [/^secretary[_ ]of[_ ]state$|^secretary$/, "Secretary of State"],
  [/^treasurer$/, "Treasurer"],
  [/^(state[_ ])?auditor$/, "Auditor"],
  [/^(state[_ ])?controller$|^comptroller$/, "Controller"],
  [/^chief[_ ]election[_ ]officer$|^chief$/, "Chief Election Officer"],
];
/**
 * An executive role from Open States ('governor', 'lt_governor', 'attorney
 * general'…): its title and rank, or null. The District of Columbia's chief
 * executive is its Mayor, which Open States files as 'governor'.
 */
export function executiveOffice(type, st = "") {
  const t = String(type || "").toLowerCase().trim();
  if (String(st).toUpperCase() === "DC" && t === "governor") return { title: "Mayor", rank: 1 };
  const i = EXECUTIVE.findIndex(([re]) => re.test(t));
  if (i >= 0) return { title: EXECUTIVE[i][1], rank: i + 1 };
  if (!t || /mayor/.test(t)) return null;
  const small = new Set(["of", "and", "for", "the"]);
  const title = t.replace(/[_]+/g, " ").split(/\s+/).map((w, n) => (n && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  return { title, rank: 20 };
}

/**
 * A short integer key for an id (a vote's or an official's), so the state
 * vote positions table stores two small integers per row instead of two
 * long ids (about 25 bytes a position instead of 320; see docs/states.md).
 * The first 13 hex digits of SHA-256 (52 bits: exact in JavaScript and
 * SQLite alike). tools/load_state_votes.py computes the same key. The key
 * columns are UNIQUE, so a collision would stop a load, never mix records.
 */
export async function stableKey(id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return parseInt(hex.slice(0, 13), 16);
}

// Positions are stored as small integers in state_positions.
export const POSITION_CODE = { Yes: 0, No: 1, Present: 2, "Not voting": 3 };
export const POSITION_NAME = ["Yes", "No", "Present", "Not voting"];
