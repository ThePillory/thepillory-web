// "Net worth, as reported" (docs/funding.md, "Net worth"): the range each
// annual financial disclosure report's assets and liabilities add up to, read
// by tools/load_networth.py into networth_reports (migration 0036). Members of
// Congress, the President, Vice President, Cabinet and the justices; the same
// method and the same words for everyone.
//
//   networthFor      one person's reports (D1; [] before the table exists)
//   networthPoints   the reports shown: the one filed before taking office, then one per year
//   networthLine     the summary line under the office line (and in Quick mode)
//   networthSection  the More tab: the chart, the numbers, the limits, reports not read
//
// Facts only: no rankings, no comparisons, no change in percent, nothing
// colored up or down. These records may not be used for commercial purposes
// (Ethics in Government Act): never sold, exported or put behind a paid plan.
import { esc, fmtDate, linkRow } from "./render.js";
import { rangeBands } from "./charts.js";

export const NETWORTH_METHOD = "/about/methodology/#net-worth";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

export async function networthFor(db, officialId) {
  const cols = `r.id, r.source, r.kind, r.amended, r.year, r.filed_on, r.before_office, r.status, r.reason, r.method, r.assets, r.liabilities,
                r.low, r.high, r.low_open, r.high_open, r.residence_mortgages, r.report_url`;
  const run = (sql) => db.prepare(sql).bind(officialId).all().then((x) => x.results);
  try {
    // A report read by AI from a scan carries its review (migration 0037).
    return await run(`SELECT ${cols}, s.status AS scan_status, s.reviewed_by FROM networth_reports r
      LEFT JOIN networth_scans s ON s.report_id = r.id WHERE r.official_id = ? ORDER BY r.year, r.filed_on`);
  } catch (err) {
    if (!missing(err)) throw err;
  }
  try {
    return await run(`SELECT ${cols} FROM networth_reports r WHERE r.official_id = ? ORDER BY r.year, r.filed_on`);
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** "Transcribed by AI from a scanned report, auto-checked" or "…, checked by [name]" for a report read by AI; "" otherwise. Pure. */
export function aiLabel(r) {
  if (r.method !== "ai") return "";
  return r.scan_status === "approved" && r.reviewed_by
    ? `Transcribed by AI from a scanned report, checked by ${r.reviewed_by}`
    : "Transcribed by AI from a scanned report, auto-checked";
}

const later = (a, b) => ((a.filed_on || "") > (b.filed_on || "") || ((a.filed_on || "") === (b.filed_on || "") && a.amended > b.amended) ? a : b);

/**
 * The reports that make up the line and the chart. Pure.
 *   annual: one per year, the last filed (an amendment replaces the original);
 *           a year whose last filed report isn't read isn't shown
 *   before: the earliest report filed before taking office that was read
 *   first, latest: the line's two ends, with first's label
 *   unread: reports not read (linked, with why)
 */
export function networthPoints(allRows) {
  // A report transcribed by AI counts only once a person has checked it against
  // the scan; until then it's listed as a link, like any report not read.
  const rows = allRows.map((r) =>
    r.method === "ai" && r.status === "read" && !(r.scan_status === "approved" && r.reviewed_by) ? { ...r, status: "scan", reason: "Read by AI: waiting for a person's check" } : r
  );
  const byYear = new Map();
  for (const r of rows.filter((r) => r.kind === "annual")) byYear.set(r.year, byYear.has(r.year) ? later(byYear.get(r.year), r) : r);
  const annual = [...byYear.values()].sort((a, b) => a.year - b.year);
  const annualRead = annual.filter((r) => r.status === "read");
  const beforeAll = rows.filter((r) => r.before_office && (r.kind === "candidate" || r.kind === "nominee")).sort((a, b) => (a.filed_on || "").localeCompare(b.filed_on || ""));
  const before = beforeAll.find((r) => r.status === "read") || null;
  let first = null;
  let label = "";
  if (before) {
    first = before;
    label = "before taking office";
  } else if (annualRead.length) {
    first = annualRead[0];
    // "Earliest report online" only when no earlier report of any kind (read or not) is listed.
    const earlier = rows.some((r) => r !== first && (r.year < first.year || (r.filed_on && first.filed_on && r.filed_on < first.filed_on)));
    label = earlier ? "earliest report read" : "earliest report online";
  }
  const latest = annualRead.length ? annualRead[annualRead.length - 1] : null;
  const shown = [...(before ? [before] : []), ...annualRead];
  const shownIds = new Set(shown.map((r) => r.id));
  const unread = rows.filter((r) => r.status !== "read" && !shownIds.has(r.id) && (r.kind === "annual" ? byYear.get(r.year) === r : r.before_office))
    .sort((a, b) => b.year - a.year);
  return { before, annual: annualRead, shown, first, label, latest: latest && latest !== first ? latest : null, unread };
}

/** "$3.2M", "$316K", "−$316K", "$950": one decimal under $10M or $10B. Pure. */
export function compactMoney(n) {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  const one = (v, unit) => {
    const d = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    return `${d}${unit}`;
  };
  if (a >= 1e9 || Math.round(a / 1e5) >= 1e4) return `${sign}$${one(a / 1e9, "B")}`;
  if (a >= 1e6 || Math.round(a / 1e3) >= 1000) return `${sign}$${one(a / 1e6, "M")}`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
}

const fullMoney = (n) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

/** "$1.4M–$3.7M" with "or less" / "or more" where a value was open-ended. Pure. */
export function rangeText(r, fmt = compactMoney) {
  return `${fmt(r.low)}${r.low_open ? " or less" : ""}–${fmt(r.high)}${r.high_open ? " or more" : ""}`;
}

const yearLabel = (r) => (r.before_office && r.kind !== "annual" ? `${r.year}, before taking office` : String(r.year));

/**
 * The summary line: "Net worth, as reported: $[low]–$[high] ([first year],
 * [label]) → $[low]–$[high] ([latest year])", linking to the chart. "" when no
 * report has been read. Pure.
 */
export function networthLine(points) {
  const { first, label, latest } = points;
  if (!first) return "";
  const text = `Net worth, as reported: ${rangeText(first)} (${first.year}, ${label})${latest ? ` → ${rangeText(latest)} (${latest.year})` : ""}`;
  return `<p class="small networth-line"><a class="inline-link" href="#more-networth" data-mode-set="detailed">${esc(text)}</a></p>`;
}

const UNREAD = {
  scan: "Scanned report: not read yet",
  ai_held: "Scanned report: read by AI, waiting for a person's check",
  paper: "Filed on paper: see the report",
  request: "Available from OGE on request",
  unreadable: "Not read automatically: see the report",
};

export const LIMITS = `Reports give values in ranges, not exact amounts. A personal home that doesn't earn income isn't reported, and neither are some government retirement accounts, so mortgages on a personal home are left out here too. An asset held only by a spouse and worth over $1,000,000 is reported only as "Over $1,000,000", and is counted here at that amount. So this is an estimate from the reports, not an exact figure.`;

/** The More tab's section. Pure. */
export function networthSection(name, points) {
  const { shown, latest, first, unread } = points;
  const end = latest || first;
  const legal = `From annual financial disclosure reports, read line by line. These records may not be used for commercial purposes. <a class="inline-link" href="${NETWORTH_METHOD}">How net worth is estimated</a>`;
  const unreadList = unread.length
    ? `<p class="label">Reports not read</p><div class="card">${unread
        .map((r) => linkRow(r.report_url, `${yearLabel(r)}: ${r.status === "scan" && /^Read by AI:/.test(r.reason || "") ? UNREAD.ai_held : UNREAD[r.status] || UNREAD.unreadable}`, r.filed_on ? `Filed ${fmtDate(r.filed_on)}` : ""))
        .join("")}</div>`
    : "";
  if (!end) {
    return `<p class="small secondary">No financial disclosure report for ${esc(name)} has been read yet.</p>${unreadList}<p class="hint">${LIMITS}</p><p class="hint">${legal}</p>`;
  }
  const chart = rangeBands(
    shown.map((r) => ({
      label: yearLabel(r),
      tick: r.before_office && r.kind !== "annual" ? "Before" : shown.length > 8 ? `’${String(r.year).slice(2)}` : String(r.year),
      low: r.low,
      high: r.high,
      lowOpen: !!r.low_open,
      highOpen: !!r.high_open,
      href: r.report_url,
      before: !!(r.before_office && r.kind !== "annual"),
    })),
    {
      format: fullMoney,
      scale: compactMoney,
      ariaLabel: `Net worth as reported, low to high, ${shown.map((r) => `${yearLabel(r)}: ${rangeText(r, fullMoney)}`).join("; ")}`,
      caption: `Each band runs from the low end to the high end of one report's ranges; tap a year for its report.${points.before ? " The lighter band is the report filed before taking office." : ""}${shown.some((r) => r.high_open) ? " A dashed top means the high end is “or more”." : ""}`,
    }
  );
  const ai = shown.filter((r) => r.method === "ai");
  const aiNote = ai.length
    ? `<p class="small">${ai.map((r) => `${esc(yearLabel(r))}: ${esc(aiLabel(r))}.`).join(" ")} <a class="inline-link" href="${NETWORTH_METHOD}">How scanned reports are read</a></p>`
    : "";
  return `
  <p class="small">Estimated net worth: ${esc(rangeText(end, fullMoney))} (${esc(String(end.year))}), as reported in ranges.</p>
  ${chart}
  ${aiNote}
  <p class="hint">${LIMITS}</p>
  ${unreadList}
  <p class="hint">${legal}</p>`;
}
