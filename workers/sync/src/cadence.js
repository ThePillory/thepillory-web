// How often each job runs (docs/data-sync.md, "How often each source updates"): nothing runs
// more often than its source changes. Pure (no bindings), so the sync Worker (src/index.js)
// and the GitHub workflows' gate (tools/schedule_gate.mjs) share one set of rules.
//
//   daily            every day
//   weekly           once a week (the Worker: 7 days after the last finished pass; a pass that
//                    stops at a daily limit or request budget keeps going the next day until
//                    it's done; the workflows: on WEEKLY_DAY)
//   until-complete  the Time Machine's history-* steps: once fully loaded, skipped ("complete")
//                    until the next calendar year, when last year joins the history
//
// The windows that make a weekly job daily are computed from the filing rules themselves, so
// there's no list to keep up: the LDA's quarterly lobbying reports (LD-2, the 20th of January,
// April, July and October) and its semiannual contribution reports (LD-203, January 30 and July 30);
// the FEC's quarterly reports (April 15, July 15, October 15, and the year-end report January 31),
// plus, in a federal election year, the pre-general (12 days before) and post-general (30 days
// after) reports. A deadline on a weekend moves to the Monday (the agencies' own rule).

export const WINDOW_DAYS = 7; // daily for the 7 days that start on a filing deadline
export const WEEKLY_DAY = 1; // the workflows' weekly day: Monday (UTC)

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
export const addDays = (day, n) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** A deadline that falls on a Saturday or Sunday moves to the Monday. */
export function nextBusinessDay(day) {
  const w = weekday(day);
  return w === 6 ? addDays(day, 2) : w === 0 ? addDays(day, 1) : day;
}

/** The federal general election: the Tuesday after the first Monday in November. */
export function generalElection(year) {
  const nov1 = utc(year, 11, 1).getUTCDay();
  const firstMonday = 1 + ((8 - nov1) % 7);
  return iso(utc(year, 11, firstMonday + 1));
}

/** The LDA's filing deadlines in `year`: LD-2 quarterly reports and LD-203 contribution reports. */
export function ldaDeadlines(year) {
  const ld2 = [1, 4, 7, 10].map((m) => iso(utc(year, m, 20)));
  const ld203 = [iso(utc(year, 1, 30)), iso(utc(year, 7, 30))];
  return [...ld2, ...ld203].map(nextBusinessDay).sort();
}

/** The FEC's filing deadlines for quarterly filers in `year` (and the election-year reports). */
export function fecDeadlines(year) {
  const out = [iso(utc(year, 1, 31)), iso(utc(year, 4, 15)), iso(utc(year, 7, 15)), iso(utc(year, 10, 15))];
  if (year % 2 === 0) {
    const g = generalElection(year);
    out.push(addDays(g, -12), addDays(g, 30));
  }
  return out.map(nextBusinessDay).sort();
}

/** The deadline whose window `day` is in (within WINDOW_DAYS from the deadline), or null. */
export function inWindow(day, deadlines, days = WINDOW_DAYS) {
  for (const d of deadlines) {
    const n = daysBetween(d, day);
    if (n >= 0 && n < days) return d;
  }
  return null;
}

const year = (day) => parseInt(day.slice(0, 4), 10);
const around = (day, fn) => [...fn(year(day) - 1), ...fn(year(day))];

/** A filing window that's open on `day` (LDA or FEC), as a short phrase, or null. */
export function filingWindow(day) {
  const lda = inWindow(day, around(day, ldaDeadlines));
  if (lda) return `the ${lda} LDA deadline`;
  const fec = inWindow(day, around(day, fecDeadlines));
  if (fec) return `the ${fec} FEC deadline`;
  return null;
}

// ---------------------------------------------------------------------------
// The sync Worker's steps. A step not listed here runs every day (in the daily run's first
// round; see src/index.js for the rounds after it).

const filings = (day) => {
  const w = filingWindow(day);
  return w ? { freq: "daily", why: `daily in the ${WINDOW_DAYS} days after ${w}` } : { freq: "weekly", why: "weekly outside filing deadlines" };
};
const weekly = () => ({ freq: "weekly", why: "weekly" });
const complete = () => ({ freq: "until-complete", why: "until fully loaded" });

export const STEP_CADENCE = {
  // Campaign money and lobbying: filed on deadlines, so weekly with a daily window after each.
  "executive-funding": filings,
  "dark-money": filings,
  "federal-funding": filings,
  // committee-bills only says which bills federal-lobbying searches, so it keeps its pace.
  "committee-bills": filings,
  "federal-lobbying": filings,
  "lobbying-contributions": filings,
  // Officials' and candidates' websites change rarely.
  "issues-pages": weekly,
  "candidate-platforms": weekly,
  // The Time Machine: past years don't change.
  "history-officials": complete,
  "history-orders": complete,
  "history-funding": complete,
  "history-nominations": complete,
  "history-votes": complete,
};

/** How often `step` runs on `day`: { freq: "daily" | "weekly" | "until-complete", why }. */
export function stepCadence(step, day) {
  const rule = STEP_CADENCE[step];
  return rule ? rule(day) : { freq: "daily", why: "daily" };
}

/**
 * Whether `step` runs on `day`, given what it recorded (its sync_state "cadence_<step>": { done,
 * open, complete, completed_on }). Pure; tested. Returns { run, message } (message when it doesn't).
 */
export function stepDue(step, day, state = {}) {
  const c = stepCadence(step, day);
  const s = state || {};
  if (c.freq === "daily") return { run: true, cadence: c };
  if (c.freq === "until-complete") {
    if (s.complete && String(s.complete) === String(year(day)))
      return { run: false, cadence: c, message: `complete: fully loaded on ${s.completed_on}; checked again next January, when ${year(day)} joins the history` };
    return { run: true, cadence: c };
  }
  // weekly
  if (s.open) return { run: true, cadence: c };
  if (s.done && daysBetween(s.done, day) < 7) {
    return { run: false, cadence: c, message: `not due: runs ${c.why}; last finished ${s.done}, next ${addDays(s.done, 7)}` };
  }
  return { run: true, cadence: c };
}

/**
 * What `step` records after running on `day` with `result` ({ status, message, more }). A pass
 * that stopped short (partial, or more: true at a daily limit) stays open, so it continues the
 * next day; an error changes nothing (the step's own failure rule applies). Pure; tested.
 */
export function stepRecord(step, day, result, state = {}) {
  const s = { ...(state || {}) };
  if (!result || result.status === "error") return s;
  if (result.status === "partial" || result.more) {
    s.open = true;
    return s;
  }
  s.open = false;
  s.done = day;
  // "skipped" with a reason (a key not set, tables not created) isn't a finished history load.
  if (stepCadence(step, day).freq === "until-complete" && result.status === "ok") {
    s.complete = String(year(day));
    s.completed_on = day;
  }
  return s;
}

// ---------------------------------------------------------------------------
// The GitHub workflows (tools/schedule_gate.mjs). Each runs from a daily cron and asks
// workflowDue() whether today is a day it runs; a run by hand always runs.

/** Election dates from data/elections/dates.json ({ states: { CA: [{ date, type }] } }) that set the election data's pace. */
function electionDates(dates) {
  const out = new Set();
  for (const [st, list] of Object.entries((dates && dates.states) || {})) {
    for (const e of list || []) {
      // California's every election (its own data is the bulk of the build), and every state's general.
      if (st === "CA" || e.type === "G") out.add(e.date);
    }
  }
  return [...out].sort();
}

export const CERTIFY_DAYS = 38; // California's Secretary of State certifies by the 38th day (Elections Code 15501)
export const ELECTION_LEAD_DAYS = 60;

export const WORKFLOW_CADENCE = {
  // FEC filings: weekly, daily in the 7 days after a deadline.
  candidates: (day) => {
    const w = inWindow(day, around(day, fecDeadlines));
    return w ? { freq: "daily", why: `daily in the ${WINDOW_DAYS} days after the ${w} FEC deadline` } : { freq: "weekly", why: "weekly outside FEC filing deadlines" };
  },
  // Daily from 60 days before an election until it's certified, otherwise weekly.
  elections: (day, { dates } = {}) => {
    for (const e of electionDates(dates)) {
      const n = daysBetween(e, day);
      if (n >= -ELECTION_LEAD_DAYS && n <= CERTIFY_DAYS)
        return { freq: "daily", why: n < 0 ? `daily: the ${e} election is ${-n} days away` : n === 0 ? `daily: election day ${e}` : `daily until the ${e} election is certified (${addDays(e, CERTIFY_DAYS)})` };
    }
    return { freq: "weekly", why: "weekly: no election within 60 days, and the last one is certified" };
  },
  "measure-constitution": () => ({ freq: "weekly", why: "weekly" }),
  // Annual financial disclosure reports are due May 15, and most are posted May through August.
  networth: (day) => {
    const md = day.slice(5);
    return md >= "05-01" && md <= "08-31" ? { freq: "daily", why: "daily May 1 – August 31, when annual reports are filed" } : { freq: "weekly", why: "weekly September – April" };
  },
  // The Court sits October through June; it issues few orders and no opinions in the summer.
  scotus: (day) => {
    const m = parseInt(day.slice(5, 7), 10);
    return m >= 7 && m <= 9 ? { freq: "weekly", why: "weekly July – September (the Court's summer recess)" } : { freq: "daily", why: "daily October – June (the Court's term)" };
  },
};

/** Whether workflow `job` runs on `day` (UTC): { run, why }. Pure; tested. */
export function workflowDue(job, day, ctx = {}) {
  const rule = WORKFLOW_CADENCE[job];
  if (!rule) throw new Error(`no cadence for workflow "${job}"`);
  const c = rule(day, ctx);
  if (c.freq === "daily") return { run: true, why: c.why };
  const run = weekday(day) === WEEKLY_DAY;
  return { run, why: run ? `${c.why}: today is the weekly run` : `${c.why}: next run ${nextWeekly(day)}` };
}

function nextWeekly(day) {
  let d = addDays(day, 1);
  while (weekday(d) !== WEEKLY_DAY) d = addDays(d, 1);
  return d;
}
