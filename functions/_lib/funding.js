// Campaign funding (FEC) and lobbying (lda.gov) for the rep and bill pages.
// Facts side by side, never cause and effect: every number says what it is,
// what period it covers and where it comes from, and nothing here says or implies
// that money caused a vote. No individual donor is ever named.
import { breakdownBar } from "./charts.js";
import { esc, safeUrl, fmtDate } from "./render.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";
import { donorsDisclosed, isPersonName } from "../../workers/sync/src/funding/disclosure.js";

export const METHOD = "/about/methodology/#funding";
export const NOT_A_CAUSE =
  "This shows a relationship in the data, not a cause. A contribution from an industry doesn't mean the giver lobbied on this bill, or that it affected the vote.";
const MIN_EMPLOYER_DONORS = 3; // an employer is listed only when at least this many people gave

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
export const money = (n) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);
const pct = (part, whole) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—");
export const period = (cycle) => `${cycle - 1}–${cycle}`;
const industryName = (k) => INDUSTRIES[k] || INDUSTRIES.other;

// ---------------------------------------------------------------------------
// Data

export async function fundingFor(db, official, cycle) {
  try {
    const fecRow = await db.prepare("SELECT * FROM fec_candidates WHERE official_id = ?").bind(official.id).first();
    const cycles = (await db.prepare("SELECT DISTINCT cycle FROM funding_progress WHERE official_id = ? AND done_at IS NOT NULL ORDER BY cycle DESC").bind(official.id).all()).results.map((r) => r.cycle);
    const c = cycles.includes(cycle) ? cycle : cycles[0] || cycle;
    const q = (sql) => db.prepare(sql).bind(official.id, c);
    const [totals, progress, pacs, outside, employers, industries, avg] = await Promise.all([
      q("SELECT * FROM funding_totals WHERE official_id = ? AND cycle = ?").first(),
      q("SELECT * FROM funding_progress WHERE official_id = ? AND cycle = ?").first(),
      q("SELECT * FROM funding_pacs WHERE official_id = ? AND cycle = ? ORDER BY total DESC LIMIT 10").all(),
      outsideRows(db, official.id, c),
      db
        .prepare(`SELECT * FROM funding_employers WHERE official_id = ? AND cycle = ? AND count >= ${MIN_EMPLOYER_DONORS} ORDER BY total DESC LIMIT 10`)
        .bind(official.id, c)
        .all(),
      db
        .prepare(
          `SELECT industry, SUM(pac) AS pac, SUM(emp) AS emp FROM (
             SELECT industry, total AS pac, 0 AS emp FROM funding_pacs WHERE official_id = ?1 AND cycle = ?2
             UNION ALL SELECT industry, 0, total FROM funding_employers WHERE official_id = ?1 AND cycle = ?2)
           GROUP BY industry ORDER BY SUM(pac) + SUM(emp) DESC`
        )
        .bind(official.id, c)
        .all(),
      db
        .prepare(
          `SELECT COUNT(*) AS n, AVG(t.receipts) AS receipts, AVG(t.pac * 1.0 / t.receipts) AS pac_share,
             AVG(t.individual_unitemized * 1.0 / t.receipts) AS small_share, AVG(t.cash_on_hand) AS cash
           FROM funding_totals t JOIN officials o ON o.id = t.official_id
           WHERE o.chamber = ? AND o.active = 1 AND t.cycle = ? AND t.receipts > 0`
        )
        .bind(official.chamber, c)
        .first(),
    ]);
    let loadedCount = null;
    if (!progress) {
      loadedCount = await db
        .prepare(
          `SELECT COUNT(*) AS total, COUNT(p.official_id) AS done FROM officials o
           LEFT JOIN fec_candidates f ON f.official_id = o.id
           LEFT JOIN funding_progress p ON p.official_id = o.id AND p.cycle = ? AND p.done_at IS NOT NULL
           WHERE o.level = 'federal' AND o.active = 1 AND NOT (f.official_id IS NOT NULL AND f.candidate_id IS NULL)`
        )
        .bind(cycle)
        .first();
    }
    const lobby = await lobbyContributionsFor(db, official.id, c);
    return { fec: fecRow, cycles, cycle: c, totals, progress, loadedCount, pacs: pacs.results, outside: outside.results, employers: employers.results, industries: industries.results, avg, lobby };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** Outside spending rows, with each spender's FEC committee type when it's been looked up (executive-funding). */
async function outsideRows(db, officialId, cycle) {
  try {
    return await db
      .prepare(
        `SELECT x.*, c.committee_type FROM funding_outside x LEFT JOIN fec_committees c ON c.committee_id = x.committee_id
         WHERE x.official_id = ? AND x.cycle = ? ORDER BY x.total DESC`
      )
      .bind(officialId, cycle)
      .all();
  } catch (err) {
    if (!missing(err)) throw err;
    return db.prepare("SELECT * FROM funding_outside WHERE official_id = ? AND cycle = ? ORDER BY total DESC").bind(officialId, cycle).all();
  }
}

/**
 * How an outside spender is named on a page. A person spending their own money
 * isn't named (ThePillory never names individuals in money data); a group that
 * doesn't have to disclose its donors says so.
 */
export function spenderLabel(x) {
  if (isPersonName(x.name)) return "An individual, spending their own money (name not shown)";
  return undisclosed(x) ? `${esc(x.name)} <span class="chip chip--gray chip--sm">Donors not disclosed</span>` : esc(x.name);
}
/** A group (not a person spending their own money) that doesn't have to disclose its donors. */
export const undisclosed = (x) => donorsDisclosed(x.committee_type) === false && !isPersonName(x.name);

/** Lobbying reports that mention a bill, grouped by organization. Amendments replace the report they amend. */
export async function lobbyingFor(db, billId) {
  try {
    const progress = await db.prepare("SELECT * FROM bill_lobbying_progress WHERE bill_id = ?").bind(billId).first();
    const rows = (
      await db
        .prepare(
          `SELECT f.*, l.excerpt, l.issue_code FROM bill_lobbying l JOIN lobbying_filings f ON f.filing_uuid = l.filing_uuid
           WHERE l.bill_id = ? ORDER BY f.posted_at DESC`
        )
        .bind(billId)
        .all()
    ).results;
    const latest = new Map();
    for (const r of rows) {
      const k = `${r.registrant_id}|${r.client_id}|${r.filing_year}|${r.filing_period}`;
      if (!latest.has(k)) latest.set(k, r); // newest posted first
    }
    const orgs = new Map();
    for (const r of latest.values()) {
      const k = r.client_id || r.client_name;
      const o = orgs.get(k) || { name: r.client_name, description: r.client_description, industry: r.industry, reports: 0, amount: 0, unreported: 0, latest: r };
      o.reports += 1;
      if (r.amount == null) o.unreported += 1;
      else o.amount += r.amount;
      orgs.set(k, o);
    }
    const list = [...orgs.values()].sort((a, b) => b.amount - a.amount || b.reports - a.reports);
    // The registrants (lobbying firms, or the organization itself) that filed them.
    const registrants = new Map();
    for (const r of latest.values()) {
      if (r.registrant_id == null) continue;
      const g = registrants.get(r.registrant_id) || { name: r.registrant_name, reports: 0, clients: new Set(), latest: r };
      g.reports += 1;
      if (r.client_name && r.client_name !== r.registrant_name) g.clients.add(r.client_name);
      registrants.set(r.registrant_id, g);
    }
    return {
      progress,
      registrants,
      orgs: list,
      reports: latest.size,
      amount: list.reduce((s, o) => s + o.amount, 0),
      industries: [...new Set(list.map((o) => o.industry).filter((i) => i !== "other"))],
    };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

// LD-203: an amended report replaces the one it amends (the newest posted wins).
function latestContribReports(rows) {
  const keep = new Map();
  for (const r of rows) {
    const k = `${r.registrant_id}|${r.lobbyist_id || 0}|${r.filing_year}|${r.filing_period}`;
    const have = keep.get(k);
    if (!have || String(r.posted_at || "") > String(have)) keep.set(k, r.posted_at || "");
  }
  return rows.filter((r) => keep.get(`${r.registrant_id}|${r.lobbyist_id || 0}|${r.filing_year}|${r.filing_period}`) === (r.posted_at || ""));
}

const dateSpan = (dates) => {
  const d = dates.filter(Boolean).sort();
  if (!d.length) return "";
  return d[0] === d[d.length - 1] ? fmtDate(d[0]) : `${fmtDate(d[0])} – ${fmtDate(d[d.length - 1])}`;
};

/**
 * LD-203 contributions honoring one member in a two-year period: organizations
 * by name, lobbyists' own reports only as counts and totals. Null before the
 * tables exist.
 */
export async function lobbyContributionsFor(db, officialId, cycle) {
  try {
    const years = [cycle - 1, cycle];
    const [{ results }, progress] = await Promise.all([
      db
        .prepare(
          `SELECT c.*, f.filer_type, f.registrant_id, f.registrant_name, f.lobbyist_id, f.filing_year, f.filing_period, f.posted_at, f.source_url
           FROM lobby_contributions c JOIN lobby_contrib_filings f ON f.filing_uuid = c.filing_uuid
           WHERE c.official_id = ? AND f.filing_year IN (?, ?)`
        )
        .bind(officialId, ...years)
        .all(),
      db.prepare("SELECT COUNT(*) AS n, SUM(done_at IS NOT NULL) AS done, MAX(done_at) AS read_at FROM lobby_contrib_progress WHERE official_id = ? AND year IN (?, ?)").bind(officialId, ...years).first(),
    ]);
    const rows = latestContribReports(results).filter((r) => !r.date || (r.date >= `${years[0]}-01-01` && r.date <= `${years[1]}-12-31`));
    const orgs = new Map();
    const lobbyists = { people: new Set(), count: 0, total: 0, dates: [] };
    for (const r of rows) {
      if (r.filer_type === "lobbyist") {
        lobbyists.people.add(r.lobbyist_id || r.filing_uuid);
        lobbyists.count += 1;
        lobbyists.total += r.amount || 0;
        lobbyists.dates.push(r.date);
        continue;
      }
      const k = r.registrant_id || r.registrant_name;
      const o = orgs.get(k) || { name: r.registrant_name, contributors: new Set(), count: 0, total: 0, dates: [], types: new Set(), latest: r };
      if (r.contributor_name && !/^self$/i.test(r.contributor_name)) o.contributors.add(r.contributor_name);
      o.count += 1;
      o.total += r.amount || 0;
      o.dates.push(r.date);
      o.types.add(r.contribution_type);
      if (String(r.posted_at || "") > String(o.latest.posted_at || "")) o.latest = r;
      orgs.set(k, o);
    }
    return {
      years,
      progress: progress && progress.n ? progress : null,
      orgs: [...orgs.values()].sort((a, b) => b.total - a.total || b.count - a.count),
      lobbyists: { people: lobbyists.people.size, count: lobbyists.count, total: lobbyists.total, span: dateSpan(lobbyists.dates) },
    };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/**
 * Organizations that filed lobbying reports mentioning a bill and also reported
 * contributions (LD-203) to members of Congress in the same Congress, matched by
 * their lobbying registration ID. Per organization: [{member, slug, total, count, dates}].
 */
export async function lobbyGiversFor(db, l, congress) {
  if (!l || !l.registrants || !l.registrants.size) return null;
  try {
    const first = 2 * parseInt(congress, 10) + 1787;
    const ids = [...l.registrants.keys()].filter((x) => x != null);
    const rows = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results } = await db
        .prepare(
          `SELECT c.official_id, c.amount, c.date, c.contribution_type, f.registrant_id, f.registrant_name, f.lobbyist_id, f.filing_year, f.filing_period, f.posted_at, f.source_url, o.name AS member, o.slug
           FROM lobby_contrib_filings f JOIN lobby_contributions c ON c.filing_uuid = f.filing_uuid JOIN officials o ON o.id = c.official_id
           WHERE f.filer_type = 'organization' AND f.filing_year IN (?, ?) AND f.registrant_id IN (${part.map(() => "?").join(",")})`
        )
        .bind(first, first + 1, ...part)
        .all();
      rows.push(...results);
    }
    const out = new Map();
    for (const r of latestContribReports(rows)) {
      const g = out.get(r.registrant_id) || { registrant_id: r.registrant_id, name: r.registrant_name, total: 0, members: new Map(), latest: r };
      const m = g.members.get(r.official_id) || { member: r.member, slug: r.slug, total: 0, count: 0, dates: [] };
      m.total += r.amount || 0;
      m.count += 1;
      if (r.date) m.dates.push(r.date);
      g.members.set(r.official_id, m);
      g.total += r.amount || 0;
      if (String(r.posted_at || "") > String(g.latest.posted_at || "")) g.latest = r;
      out.set(r.registrant_id, g);
    }
    return [...out.values()]
      .map((g) => ({ ...g, lobbied: l.registrants.get(g.registrant_id), members: [...g.members.values()].sort((a, b) => b.total - a.total) }))
      .sort((a, b) => b.total - a.total);
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** For each rep: contributions in one period from the given industries (PACs plus donors' employers). */
export async function industryMoney(db, officialIds, industries, cycle) {
  if (!officialIds.length || !industries.length) return {};
  try {
    const ph = (a) => a.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT official_id, industry, SUM(pac) AS pac, SUM(emp) AS emp FROM (
           SELECT official_id, industry, total AS pac, 0 AS emp FROM funding_pacs WHERE cycle = ? AND official_id IN (${ph(officialIds)}) AND industry IN (${ph(industries)})
           UNION ALL
           SELECT official_id, industry, 0, total FROM funding_employers WHERE cycle = ? AND official_id IN (${ph(officialIds)}) AND industry IN (${ph(industries)}))
         GROUP BY official_id, industry ORDER BY SUM(pac) + SUM(emp) DESC`
      )
      .bind(cycle, ...officialIds, ...industries, cycle, ...officialIds, ...industries)
      .all();
    const read = new Set(
      (await db.prepare(`SELECT official_id FROM funding_progress WHERE cycle = ? AND done_at IS NOT NULL AND official_id IN (${ph(officialIds)})`).bind(cycle, ...officialIds).all()).results.map(
        (r) => r.official_id
      )
    );
    const out = {};
    for (const id of officialIds) out[id] = { read: read.has(id), rows: results.filter((r) => r.official_id === id) };
    return out;
  } catch (err) {
    if (missing(err)) return {};
    throw err;
  }
}

/** The two-year period a date falls in (2025-06-01 → 2026). */
export function cycleOf(date) {
  const y = parseInt(String(date || "").slice(0, 4), 10);
  return y ? (y % 2 ? y + 1 : y) : currentCycle();
}

// ---------------------------------------------------------------------------
// Rendering

const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;

function cycleNav(base, f) {
  if (f.cycles.length < 2) return "";
  return `<nav class="pill-filter" aria-label="Two-year period">${f.cycles
    .map((c) => `<a class="toggle" href="${base}?cycle=${c}#funding"${c === f.cycle ? ' aria-current="true"' : ""}>${period(c)}</a>`)
    .join("")}</nav>`;
}

/** The Funding tab on a member of Congress's page. */
function loading(f) {
  const n = f && f.loadedCount;
  const progress = n && n.total ? ` So far, ${n.done.toLocaleString("en-US")} of ${n.total.toLocaleString("en-US")} members of Congress are loaded.` : "";
  return `<div class="card empty-state stack-sm">
  <p>Funding data is loading.</p>
  <p class="small secondary">Campaign finance reports from the Federal Election Commission are being loaded one member at a time, starting with the members who represent live communities. This member's appear here once they're loaded.${progress}</p>
  <a class="inline-link" href="${METHOD}">How funding is shown</a>
</div>`;
}

export function fundingTab(official, f, base) {
  if (official.level !== "federal") {
    return `<p class="secondary small">Campaign funding is shown for members of Congress, from the Federal Election Commission. California's state disclosure system is being replaced (the new system is expected after the November 2026 election); state and county funding comes after that. <a class="inline-link" href="${METHOD}">How funding is shown</a></p>`;
  }
  // Not read yet: say so, rather than show an empty tab.
  if (!f || !f.fec || (f.fec.candidate_id && !f.progress)) return loading(f);
  if (!f.fec.candidate_id) {
    return `<p class="secondary small">${esc(f.fec.note || "No FEC record found for this member.")}</p>
      ${safeUrl(f.fec.source_url) ? `<a class="small inline-link" href="${esc(f.fec.source_url)}" target="_blank" rel="noopener">Source ↗</a>` : ""}`;
  }
  const t = f.totals;
  const span = period(f.cycle);
  const fecLink = safeUrl((t && t.source_url) || f.fec.source_url);
  const asOf = t && t.coverage_end ? `through ${fmtDate(t.coverage_end)}${t.last_report ? ` (latest report: ${esc(t.last_report.toLowerCase())})` : ""}` : "";
  const intro = `<p class="small">Money raised by ${esc(official.name)}'s campaign committees in ${span}${asOf ? `, ${asOf}` : ""}, as reported to the Federal Election Commission. ${
    official.chamber === "us-executive" ? "These are facts about money; they don't explain any action in office." : "These are facts about money, shown beside the voting record; they don't explain any vote."
  }</p>`;
  if (!t) return `${cycleNav(base, f)}${intro}<p class="secondary small">${esc((f.progress && f.progress.note) || `No FEC totals for ${span}.`)}</p>${lobbyContribSection(official, f.lobby)}`;

  // 1. PAC and special-interest money
  const pacs = f.pacs.length
    ? `<ul class="plain-list money-list">${f.pacs.map((p) => row(esc(p.name), money(p.total), `${p.count} contribution${p.count === 1 ? "" : "s"} · ${esc(industryName(p.industry))}`)).join("")}</ul>
       <p class="hint">The ${f.pacs.length} largest of ${money(t.pac)} from PACs and other political committees (${pct(t.pac, t.receipts)} of all money raised). ${
         f.progress.note ? esc(f.progress.note) + ". " : ""
       }<a class="tap" href="${esc(f.pacs[0].source_url)}" target="_blank" rel="noopener">Every PAC contribution at the FEC ↗</a></p>`
    : `<p class="secondary small">No contributions from PACs reported in ${span}.</p>`;

  const side = (so) => f.outside.filter((x) => x.support_oppose === so);
  const outsideList = (so, label) => {
    const rows = side(so);
    const sum = rows.reduce((s, x) => s + x.total, 0);
    const hidden = rows.filter(undisclosed).reduce((s, x) => s + x.total, 0);
    return `<div class="stack-xs"><div class="stat"><div class="stat-label">${label}</div><div class="stat-num">${money(sum)}</div></div>${
      rows.length
        ? `<ul class="plain-list money-list">${rows.slice(0, 5).map((x) => row(spenderLabel(x), money(x.total))).join("")}</ul>${rows.length > 5 ? `<p class="hint">And ${rows.length - 5} more.</p>` : ""}${
            hidden ? `<p class="hint">${money(hidden)} of this came from groups whose donors are not disclosed.</p>` : ""
          }`
        : '<p class="secondary small">None reported.</p>'
    }</div>`;
  };
  const anyHidden = f.outside.some(undisclosed);
  const outside = `
    ${outsideList("S", "Spent to support")}
    ${outsideList("O", "Spent to oppose")}
    <p class="hint">Independent expenditures: spending on ads and outreach about ${official.chamber === "us-executive" ? "this candidate" : "this member"}, without coordinating with the campaign. This money isn't given to the campaign.${
      anyHidden ? ` "Donors not disclosed": the group files with the FEC as a spender, not as a political committee, so it doesn't have to report who funds it (<a class="tap" href="${METHOD.replace("#funding", "#donors-not-disclosed")}">what this means</a>).` : ""
    } ${fecLink ? `<a class="tap" href="${esc(fecLink)}" target="_blank" rel="noopener">FEC record ↗</a>` : ""}</p>`;

  const known = f.industries.filter((i) => i.industry !== "other");
  const classified = known.reduce((s, i) => s + i.pac + i.emp, 0);
  const all = f.industries.reduce((s, i) => s + i.pac + i.emp, 0);
  const industries = known.length
    ? `<ul class="plain-list money-list">${known
        .slice(0, 8)
        .map((i) => row(esc(industryName(i.industry)), money(i.pac + i.emp), [i.pac ? `PACs ${money(i.pac)}` : "", i.emp ? `donors' employers ${money(i.emp)}` : ""].filter(Boolean).join(" · ")))
        .join("")}</ul>
       <p class="hint">Approximate. Industries are assigned by keywords in PAC and employer names (<a class="tap" href="${METHOD}">how</a>); ${pct(classified, all)} of these dollars matched an industry, and the rest are left unclassified rather than guessed. Employer amounts count only donors who gave more than $200, from the campaign's principal committee.</p>`
    : '<p class="secondary small">No contributions matched an industry category.</p>';

  // 2. Totals and where the money came from
  const parts = [
    ["Small individual donors ($200 or less)", t.individual_unitemized],
    ["Larger individual donors (more than $200)", t.individual_itemized],
    ["PACs and other political committees", t.pac],
    ["Political party committees", t.party],
    ["The candidate (own money and loans)", t.self_funding],
    ["Other (transfers, refunds, interest)", t.other],
  ];
  const breakdown = breakdownBar(parts.map(([label, value]) => ({ label, value })), { total: t.receipts, format: money, label: "Where the money came from" });
  const avg = f.avg && f.avg.n > 1
    ? `<p class="hint">For comparison, the average of the ${f.avg.n} ${official.chamber === "us-senate" ? "senators" : "House members"} with ${span} filings loaded: raised ${money(f.avg.receipts)}; PACs ${Math.round(100 * (f.avg.pac_share || 0))}% of money raised; small donors ${Math.round(100 * (f.avg.small_share || 0))}%; cash on hand ${money(f.avg.cash)}.${official.chamber === "us-senate" ? " A senator's fundraising varies with where they are in a six-year term." : ""}</p>`
    : "";
  const employers = f.employers.length
    ? `<ul class="plain-list money-list">${f.employers.map((e) => row(esc(e.employer), money(e.total), `${e.count} donors · ${esc(industryName(e.industry))}`)).join("")}</ul>
       <p class="hint">Employers named by donors who gave more than $200, summed; an employer is listed only when ${MIN_EMPLOYER_DONORS} or more people named it. Individual donors are never listed.</p>`
    : '<p class="secondary small">No employer was named by 3 or more donors.</p>';

  return `
${cycleNav(base, f)}
<section class="card hero-stat">
  <p class="label">Raised · ${span}</p>
  <p class="hero-num">${money(t.receipts)}</p>
  <p class="small secondary">Spent ${money(t.disbursements)} · Cash on hand ${money(t.cash_on_hand)}${t.coverage_end ? ` as of ${fmtDate(t.coverage_end)}` : ""}</p>
</section>
${intro}
<section class="card stack">
  <h3>Where it came from</h3>
  ${breakdown}
  ${avg}
</section>
<section class="card stack-sm">
  <h3>Top PACs</h3>
  ${pacs}
</section>
<section class="card stack-sm">
  <h3>Outside spending for and against</h3>
  ${outside}
</section>
<section class="card stack-sm">
  <h3>Top contributing industries <span class="secondary small">(approximate)</span></h3>
  ${industries}
</section>
<section class="card stack-sm">
  <h3>Donors' employers</h3>
  ${employers}
</section>
${lobbyContribSection(official, f.lobby)}
<p class="hint">Source: Federal Election Commission${fecLink ? ` (<a class="tap" href="${esc(fecLink)}" target="_blank" rel="noopener">${esc(official.name)} at the FEC ↗</a>)` : ""}, ${span}. Read ${fmtDate(f.progress.done_at)}. Federal law bars using contributor information from FEC reports to ask for contributions or for commercial purposes; ThePillory shows totals only and has no donor export. <a class="tap" href="${METHOD}">Methodology</a></p>`;
}

const LD203_SEARCH = "https://lda.gov/filings/public/contribution/search/";
const CONTRIB_TYPES = { feca: "campaign contributions", he: "honorary expenses", me: "meeting expenses", ple: "presidential library", pic: "inaugural committee" };
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "From lobbyists and lobbying organizations" on a member's Funding tab (LD-203). */
export function lobbyContribSection(official, l) {
  const head = '<h3>From lobbyists and lobbying organizations</h3>';
  if (!l) return "";
  const yrs = `${l.years[0]}–${l.years[1]}`;
  if (!l.progress) {
    return `<section class="card stack-sm">${head}<p class="secondary small">Contribution reports from lobbyists and lobbying organizations (Form LD-203) haven't been searched for ${esc(official.name)} yet. They're searched a few hundred at a time each day.</p></section>`;
  }
  const searching = l.progress.done < l.progress.n;
  const orgRow = (o) =>
    row(
      `<a class="inline-link" href="${esc(safeUrl(o.latest.source_url) || LD203_SEARCH)}" target="_blank" rel="noopener">${esc(o.name)}</a>`,
      money(o.total),
      [plural(o.count, "contribution"), dateSpan(o.dates), o.contributors.size ? `through ${[...o.contributors].slice(0, 2).map(esc).join(", ")}` : "", [...o.types].filter((t) => t && t !== "feca").map((t) => CONTRIB_TYPES[t] || t).join(", ")]
        .filter(Boolean)
        .join(" · ")
    );
  const orgs = l.orgs.length
    ? `<ul class="plain-list money-list">${l.orgs.slice(0, 10).map(orgRow).join("")}</ul>${
        l.orgs.length > 10 ? `<details class="weigh-details"><summary>${l.orgs.length - 10} more organizations</summary><ul class="plain-list money-list">${l.orgs.slice(10).map(orgRow).join("")}</ul></details>` : ""
      }
       <p class="hint">${plural(l.orgs.length, "lobbying organization")} reported ${money(l.orgs.reduce((x, o) => x + o.total, 0))} honoring ${esc(official.name)} in ${yrs}: their own contributions and their PACs', by name.</p>`
    : `<p class="secondary small">No lobbying organization reported a contribution honoring ${esc(official.name)} in ${yrs}${searching ? " so far" : ""}.</p>`;
  const lob = l.lobbyists.count
    ? `<div class="stat"><div class="stat-label">Registered lobbyists, giving personally</div><div class="stat-num">${money(l.lobbyists.total)}</div></div>
       <p class="small">${plural(l.lobbyists.count, "contribution")} from ${plural(l.lobbyists.people, "lobbyist")}${l.lobbyists.span ? `, ${l.lobbyists.span}` : ""}. Individual lobbyists aren't named.</p>`
    : `<p class="secondary small">No registered lobbyist reported a personal contribution honoring ${esc(official.name)} in ${yrs}${searching ? " so far" : ""}.</p>`;
  return `<section class="card stack-sm">
  ${head}
  ${orgs}
  ${lob}
  <p class="hint">From Form LD-203, which registered lobbyists and lobbying organizations file with Congress twice a year (January to June, July to December), ${yrs}${searching ? "; still searching" : `; read ${fmtDate(l.progress.read_at)}`}. Each report lists contributions to federal candidates and their committees and money for events honoring them; it's shown here when the person it honors matches ${esc(official.name)}'s name exactly, so a report that writes the name differently can be missed. Some of this also appears above as PAC contributions reported to the FEC: the two come from different reports, so don't add them together. These are facts about money; they don't explain any vote. <a class="tap" href="${LD203_SEARCH}" target="_blank" rel="noopener">LD-203 reports at lda.gov ↗</a> · <a class="tap" href="${METHOD.replace("#funding", "#lobbying")}">How</a></p>
</section>`;
}

/** Organizations that lobbied on a bill and also gave to members: both facts, side by side, with dates. */
export function giversSideBySide(bill, givers) {
  if (!givers || !givers.length) return "";
  const item = (g) => {
    const lob = g.lobbied;
    const clients = lob ? [...lob.clients] : [];
    const members = g.members;
    const memberLine = (m) =>
      `<li><a class="inline-link" href="/reps/${esc(m.slug)}/#funding">${esc(m.member)}</a>: ${money(m.total)} (${plural(m.count, "contribution")}${m.dates.length ? `; ${[...new Set(m.dates)].sort().slice(-3).map(fmtDate).join(", ")}${m.dates.length > 3 ? ", …" : ""}` : ""})</li>`;
    return `<div class="card-inset stack-xs">
      <p class="small"><strong>${esc(g.name)}</strong></p>
      <p class="small"><span class="label">Lobbying</span> ${plural(lob.reports, "report")} that mention ${esc(bill.bill_number)}${clients.length ? `, for ${clients.slice(0, 3).map(esc).join(", ")}${clients.length > 3 ? ` and ${clients.length - 3} more` : ""}` : ""}; latest ${esc(lob.latest.filing_period || "")} ${esc(String(lob.latest.filing_year || ""))}, filed ${fmtDate(lob.latest.posted_at)}. <a class="tap" href="${esc(safeUrl(lob.latest.source_url) || "#")}" target="_blank" rel="noopener">Report ↗</a></p>
      <p class="small"><span class="label">Contributions</span> ${money(g.total)} honoring ${plural(members.length, "member")} of Congress, reported on Form LD-203. <a class="tap" href="${esc(safeUrl(g.latest.source_url) || LD203_SEARCH)}" target="_blank" rel="noopener">Latest report ↗</a></p>
      <ul class="plain-list small">${members.slice(0, 5).map(memberLine).join("")}</ul>
      ${members.length > 5 ? `<details class="weigh-details"><summary>${members.length - 5} more members</summary><ul class="plain-list small">${members.slice(5).map(memberLine).join("")}</ul></details>` : ""}
    </div>`;
  };
  return `<h3 class="money-sub">Organizations that lobbied on this bill and also gave to members of Congress</h3>
    ${givers.slice(0, 8).map(item).join("")}
    ${givers.length > 8 ? `<details class="weigh-details"><summary>${givers.length - 8} more organizations</summary>${givers.slice(8).map(item).join("")}</details>` : ""}
    <p class="hint">Two separate facts from two kinds of report, in the same Congress: lobbying reports (Form LD-2) that mention this bill, and contribution reports (Form LD-203) from the same registered organization, matched by its lobbying registration number. They don't show that one led to the other, what position anyone took, or how anyone voted. A lobbying firm reports its own and its PAC's contributions, not its clients'. Contributions from individual lobbyists aren't included here.</p>`;
}

/** "Follow the money" on a bill page. `repMoney`: [{rep, vote, position, money}] for the visitor's reps. */
export function followTheMoney(bill, l, { reps = null, repMoney = [], cycle = null, bare = false, givers = null } = {}) {
  const head = '<h2 class="label" id="h-money">Follow the money</h2>';
  // bare: the contents only, for a collapsed section that has its own heading.
  const wrap = (inner) => (bare ? inner : `<section class="card stack-sm" id="money" aria-labelledby="h-money">${head}${inner}</section>`);
  if (bill.level !== "federal") {
    return wrap(`<p class="secondary small">Lobbying reports are shown for bills in Congress (from the federal lobbying disclosure database). California lobbying comes with the state's new disclosure system.</p>`);
  }
  if (!l || !l.progress) {
    return wrap(`<p class="secondary small">Lobbying reports for this bill haven't been searched yet. They're searched for every bill in this Congress with a final-passage vote or committee action, newest first.</p>`);
  }
  const searching = !l.progress.done_at;
  const first = 2 * parseInt(bill.session, 10) + 1787; // the 119th Congress: 2025–2026
  const span = `${first}–${first + 1}`;
  const orgs = l.orgs.length
    ? `<p class="small"><strong>${l.orgs.length}</strong> organization${l.orgs.length === 1 ? "" : "s"} filed <strong>${l.reports}</strong> lobbying report${l.reports === 1 ? "" : "s"} in ${span} that mention ${esc(bill.bill_number)}${searching ? " so far (still searching)" : ""}.</p>
       <ul class="plain-list money-list">${l.orgs
         .slice(0, 12)
         .map((o) =>
           row(
             `<a class="inline-link" href="${esc(safeUrl(o.latest.source_url) || "#")}" target="_blank" rel="noopener">${esc(o.name)}</a>`,
             o.amount ? money(o.amount) : '<span class="secondary">not stated</span>',
             `${o.reports} report${o.reports === 1 ? "" : "s"} · ${esc(industryName(o.industry))}`
           )
         )
         .join("")}</ul>
       ${l.orgs.length > 12 ? `<details class="weigh-details"><summary>${l.orgs.length - 12} more organizations</summary><ul class="plain-list money-list">${l.orgs.slice(12).map((o) => row(`<a class="inline-link" href="${esc(safeUrl(o.latest.source_url) || "#")}" target="_blank" rel="noopener">${esc(o.name)}</a>`, o.amount ? money(o.amount) : '<span class="secondary">not stated</span>')).join("")}</ul></details>` : ""}
       <p class="hint">Reported lobbying income and expenses in these reports: <strong>${money(l.amount)}</strong>. Each amount covers everything a report lists, not only this bill, so it overstates spending on this bill. Reports are found by searching for the bill number and checking each mention; a report that writes the number differently can be missed. Each organization links to its latest report. <a class="tap" href="${METHOD}">How</a></p>`
    : `<p class="secondary small">${searching ? "Searching lobbying reports for this bill. None matched so far." : `No lobbying reports from ${span} mention ${esc(bill.bill_number)}.`}</p>`;

  let yours = "";
  if (l.orgs.length) {
    if (!reps) {
      yours = '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see their votes on this bill beside contributions from these industries.</p>';
    } else if (repMoney.length) {
      const inds = l.industries.length ? l.industries : [];
      yours = `<h3 class="money-sub">Your reps: their vote, and contributions from these industries</h3>
        ${repMoney
          .map(({ rep, position, vote, money: m }) => {
            const rows = (m && m.rows) || [];
            const total = rows.reduce((s, r) => s + r.pac + r.emp, 0);
            return `<div class="card-inset stack-xs">
              <p class="small"><a class="inline-link" href="/reps/${esc(rep.slug)}/#funding">${esc(rep.name)}</a> · ${
                position ? `recorded as <strong>${esc(position)}</strong> on ${esc(vote.question)} (${fmtDate(vote.vote_date)})` : "no recorded final-passage vote on this bill"
              }</p>
              ${
                !m || !m.read
                  ? '<p class="secondary small">Funding for this period isn\'t loaded yet.</p>'
                  : rows.length
                    ? `<ul class="plain-list money-list">${rows.map((r) => row(esc(industryName(r.industry)), money(r.pac + r.emp))).join("")}</ul><p class="hint">${money(total)} in ${period(cycle)} from PACs and donors' employers in these industries (approximate).</p>`
                    : `<p class="secondary small">No contributions in ${period(cycle)} matched these industries.</p>`
              }
            </div>`;
          })
          .join("")}
        <p class="hint"><strong>${esc(NOT_A_CAUSE)}</strong> Industries that lobbied: ${inds.map((i) => esc(industryName(i))).join(", ") || "none classified"}.</p>`;
    }
  }
  return wrap(`${orgs}${giversSideBySide(bill, givers)}${yours}`);
}
