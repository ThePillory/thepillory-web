// Public finances on an administration timeline (data/history/finances.json,
// built by tools/build_history.py from Treasury, OMB, the Census Bureau, the
// House and Senate historians, and California's Department of Finance).
//
// Every term gets the same measures, computed the same way:
//   start = the fiscal year that ended before the term began
//   end   = the last fiscal year that ended during the term (or the latest
//           available, for a term still in progress)
// and for each: the change in dollars and percent, the share of GDP, and the
// amount per person and per household. Nothing here says or implies that an
// officeholder caused a number; the page puts context beside the figures.
// Pure: no D1, no network (tested in workers/sync/test/finances.test.mjs).

/** The fiscal year a date falls in. Federal: Oct 1 - Sep 30 (FY named for its end). California: Jul 1 - Jun 30. */
export function fiscalYearOf(iso, { startMonth }) {
  const y = parseInt(iso.slice(0, 4), 10);
  const m = parseInt(iso.slice(5, 7), 10);
  return m >= startMonth ? y + 1 : y;
}

/** The fiscal years that bracket a term: the one that ended before it began, and the last that ended during it. */
export function termYears(start, end, { startMonth, latest, today }) {
  const first = fiscalYearOf(start, { startMonth }); // the fiscal year in progress on the first day
  const before = first - 1;
  const endIso = end && end <= today ? end : today;
  // The last fiscal year that ended on or before the term's last day.
  const last = Math.min(fiscalYearOf(endIso, { startMonth }) - 1, latest);
  return { before, first, last: Math.max(last, before), inProgress: !(end && end <= today) };
}

const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
const share = (v, gdp) => (v == null || !gdp ? null : (v / gdp) * 100);
const per = (v, n) => (v == null || !n ? null : v / n);

/** One measure across a term: start and end values, the change, share of GDP, per person and per household. */
export function measure(rows, key, from, to, { pick = (r) => r[key] } = {}) {
  const a = rows.get(from);
  const b = rows.get(to);
  const va = a ? pick(a) : null;
  const vb = b ? pick(b) : null;
  return {
    from, to,
    start: va, end: vb,
    change: va != null && vb != null ? vb - va : null,
    changePct: pct(vb, va),
    startShare: a ? share(va, a.gdp) : null, endShare: b ? share(vb, b.gdp) : null,
    startPerPerson: a ? per(va, a.population) : null, endPerPerson: b ? per(vb, b.population) : null,
    startPerHousehold: a ? per(va, a.households) : null, endPerHousehold: b ? per(vb, b.households) : null,
  };
}

/** The Congresses that overlap a term, with each chamber's majority as the historians list it. */
export function congressesIn(control, start, end) {
  const s = parseInt(start.slice(0, 4), 10);
  const e = end ? parseInt(end.slice(0, 4), 10) : 9999;
  const out = [];
  const all = new Set([...Object.keys((control && control.house) || {}), ...Object.keys((control && control.senate) || {})]);
  for (const c of [...all].map(Number).sort((a, b) => a - b)) {
    const h = control.house[c];
    const sn = control.senate[c];
    const years = (h || sn).years;
    // A Congress runs from January of its first year to January of its last.
    if (years[1] <= s || years[0] >= e) continue;
    out.push({ congress: c, years, house: h || null, senate: sn || null });
  }
  return out;
}

/** Events (recessions, wars, pandemics) that began during a term. */
export function eventsIn(events, start, end) {
  const s = start.slice(0, 7);
  const e = end ? end.slice(0, 7) : "9999-12";
  return (events || []).filter((x) => x.from >= s && x.from < e);
}

/** Federal terms with every measure. */
export function federalTerms(fin, today) {
  const f = fin.federal;
  const rows = new Map(f.years.map((r) => [r.fy, r]));
  const latestBudget = Math.max(...f.years.filter((r) => r.outlays != null).map((r) => r.fy));
  const latestDebt = Math.max(...f.years.filter((r) => r.debt != null).map((r) => r.fy));
  const interest = (r) => (r.functions && r.functions["Net interest"] != null ? r.functions["Net interest"] : null);
  return f.terms.map((t) => {
    const y = termYears(t.start, t.end, { startMonth: 10, latest: latestBudget, today });
    const yd = termYears(t.start, t.end, { startMonth: 10, latest: latestDebt, today });
    const categories = Object.keys((rows.get(y.last) || {}).functions || {})
      .filter((k) => CATEGORIES.includes(k))
      .map((k) => ({ name: k, ...measure(rows, null, y.before, y.last, { pick: (r) => (r.functions || {})[k] ?? null }) }));
    return {
      ...t,
      years: y,
      debt: measure(rows, "debt", yd.before, yd.last),
      receipts: measure(rows, "receipts", y.before, y.last),
      outlays: measure(rows, "outlays", y.before, y.last),
      surplus: measure(rows, "surplus", y.before, y.last),
      interest: measure(rows, null, y.before, y.last, { pick: interest }),
      categories: categories.sort((a, b) => CATEGORIES.indexOf(a.name) - CATEGORIES.indexOf(b.name)),
      congresses: congressesIn(f.control, t.start, t.end),
      events: eventsIn(fin.events, t.start, t.end),
    };
  });
}

// OMB Table 3.1 functions shown as spending categories, in its own order (superfunction subtotals and on/off-budget lines left out).
export const CATEGORIES = [
  "National Defense", "Social Security", "Medicare", "Health", "Income Security", "Net interest", "Veterans Benefits and Services",
  "Education, Training, Employment, and Social Services", "Transportation", "Natural Resources and Environment", "International Affairs",
  "Administration of Justice", "Agriculture", "Energy", "General Science, Space, and Technology", "Community and Regional Development",
  "Commerce and Housing Credit", "General Government",
];

/** California governor terms with General Fund measures (fiscal year July 1 - June 30). */
export function californiaTerms(fin, today, legislatureMakeup = []) {
  const ca = fin.california;
  const gf = (ca.general_fund && ca.general_fund.rows) || {};
  const todayFy = fiscalYearOf(today, { startMonth: 7 }) - 1; // the last fiscal year that has ended
  const rows = new Map();
  for (const [fy, r] of Object.entries(gf)) {
    const y = parseInt(fy, 10);
    if (y > todayFy) continue; // budget-year estimates are left out
    rows.set(y, { ...r, population: (ca.population || {})[y] ?? (ca.population || {})[String(y)] ?? null, households: (ca.households || {})[y] ?? (ca.households || {})[String(y)] ?? null, gdp: null });
  }
  const latest = Math.max(...rows.keys());
  const govs = (ca.governors || []).filter((g) => g.to == null || g.to >= 1993);
  return govs.map((g) => {
    // The State Library lists years; a governor takes office in early January.
    const start = `${g.from}-01-06`;
    const end = g.to ? `${g.to}-01-06` : null;
    const y = termYears(start, end, { startMonth: 7, latest, today });
    return {
      name: g.name, start, end, from: g.from, to: g.to,
      years: y,
      revenues: measure(rows, "revenues", y.before, y.last),
      expenditures: measure(rows, "expenditures", y.before, y.last),
      balance: measure(rows, "ending_balance", y.before, y.last),
      legislature: (legislatureMakeup || []).filter((m) => m.after_election >= g.from - 1 && (g.to == null || m.after_election < g.to)),
      events: eventsIn(fin.events, start, end),
    };
  });
}

// ---------------------------------------------------------------------------
// Formatting

/** "$1.23 trillion", "$456.7 billion", "$12,345": plain and the same everywhere. */
export function usd(n, { signed = false } = {}) {
  if (n == null || !Number.isFinite(n)) return "Not available";
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const a = Math.abs(n);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)} trillion`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)} billion`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)} million`;
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}

export function pctText(n, { signed = true } = {}) {
  if (n == null || !Number.isFinite(n)) return "Not available";
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}
