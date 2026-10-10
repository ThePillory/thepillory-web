// When the ballot preview ("Preview [State]'s ballot") leads the home page: from WINDOW_DAYS before the next
// election in the visitor's state through Election Day, using that state's own
// dates (data/elections/dates.json: every federal primary, runoff, special and
// general election the FEC lists, built by tools/build_federal_races.py).
// Outside the window it's a regular link. Pure; tested in
// workers/sync/test/election-window.test.mjs.

export const WINDOW_DAYS = 45;

// Each state's main time zone, for "today" and the countdown (most of a state's people).
const TZ = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver", PR: "America/Puerto_Rico", GU: "Pacific/Guam", VI: "America/St_Thomas", AS: "Pacific/Pago_Pago", MP: "Pacific/Saipan",
};

/** Today's date (YYYY-MM-DD) in the state. */
export function todayIn(st, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ[st] || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 86400000);

/**
 * The state's next election on or after today: statewide, or a special election in the visitor's
 * own U.S. House district when it's known. On a date with both, the statewide one.
 */
export function nextElection(dates, st, today, cd = null) {
  const list = (dates && dates.states && dates.states[st]) || [];
  const mine = cd == null || cd === "" ? null : String(Number(cd));
  const hits = list.filter((e) => e.date >= today && (!e.district || e.district === mine));
  if (!hits.length) return null;
  const first = hits[0].date;
  const same = hits.filter((e) => e.date === first);
  return same.find((e) => !e.district) || same[0];
}

const NAMES = { G: "Election Day", P: "Primary election", R: "Primary runoff", GR: "General runoff", SG: "Special election", SR: "Special runoff", PR: "Presidential primary" };

/** "Election Day", "Primary election", "Special election, District 13", … */
export function electionLabel(e) {
  const name = NAMES[e.type] || e.name || "Election";
  return e.district ? `${name}, District ${e.district}` : name;
}

/** Runoffs happen only for races no one won outright, so the page says so. */
export const onlyIfNeeded = (e) => ["R", "GR", "SR"].includes(e.type);

export function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

const POSSESSIVE = { DC: "D.C.'s" };
/**
 * "Preview California's ballot", "Preview D.C.'s ballot": the link to /ballot/<st>/
 * before an address. `name` is the state's full name. Pure.
 */
export function previewLabel(st, name) {
  if (!st || !name) return "Preview your state's ballot";
  return `Preview ${statePossessive(st, name)} ballot`;
}
/** "California's", "D.C.'s". Pure. */
export const statePossessive = (st, name) => POSSESSIVE[st] || `${name}'s`;
/** After an address: the page's heading. */
export const RESULT_HEADING = "Your ballot preview";

/** "Election Day: Tue, Nov 3 · 25 days" (or "· tomorrow", "· today"). */
export function countdownLine(e, days) {
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `${days} days`;
  return `${electionLabel(e)}: ${shortDate(e.date)} · ${when}`;
}

/** { election, days, open, line } for the state, or null when no election is listed ahead. */
export function ballotWindow(dates, st, today, cd = null) {
  const election = nextElection(dates, st, today, cd);
  if (!election) return null;
  const days = daysBetween(today, election.date);
  return { election, days, open: days <= WINDOW_DAYS, line: countdownLine(election, days) };
}
