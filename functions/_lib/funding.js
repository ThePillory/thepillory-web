// Campaign funding (FEC) and lobbying (lda.gov) for the rep and bill pages.
// Facts side by side, never cause and effect: every number says what it is,
// what period it covers and where it comes from, and nothing here says or implies
// that money caused a vote. No individual donor is ever named.
import { esc, safeUrl, fmtDate } from "./render.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";

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
      q("SELECT * FROM funding_outside WHERE official_id = ? AND cycle = ? ORDER BY total DESC").all(),
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
    return { fec: fecRow, cycles, cycle: c, totals, progress, pacs: pacs.results, outside: outside.results, employers: employers.results, industries: industries.results, avg };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

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
    return {
      progress,
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
export function fundingTab(official, f, base) {
  if (official.level !== "federal") {
    return `<p class="secondary small">Campaign funding is shown for members of Congress, from the Federal Election Commission. California's state disclosure system is being replaced (the new system is expected after the November 2026 election); state and county funding comes after that. <a class="inline-link" href="${METHOD}">How funding is shown</a></p>`;
  }
  if (!f || !f.fec) return `<p class="secondary small">Not loaded yet. Campaign funding appears after the funding sync reaches this member; the first full load takes a few days.</p>`;
  if (!f.fec.candidate_id || !f.progress) {
    return `<p class="secondary small">${esc(f.fec.note || "Not loaded yet. Campaign funding appears after the funding sync reaches this member; the first full load takes a few days.")}</p>
      ${safeUrl(f.fec.source_url) ? `<a class="small inline-link" href="${esc(f.fec.source_url)}" target="_blank" rel="noopener">Source ↗</a>` : ""}`;
  }
  const t = f.totals;
  const span = period(f.cycle);
  const fecLink = safeUrl((t && t.source_url) || f.fec.source_url);
  const asOf = t && t.coverage_end ? `through ${fmtDate(t.coverage_end)}${t.last_report ? ` (latest report: ${esc(t.last_report.toLowerCase())})` : ""}` : "";
  const intro = `<p class="small">Money raised by ${esc(official.name)}'s campaign committees in ${span}${asOf ? `, ${asOf}` : ""}, as reported to the Federal Election Commission. These are facts about money, shown beside the voting record; they don't explain any vote.</p>`;
  if (!t) return `${cycleNav(base, f)}${intro}<p class="secondary small">${esc((f.progress && f.progress.note) || `No FEC totals for ${span}.`)}</p>`;

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
    return `<div class="stack-xs"><h4 class="money-sub">${label}: ${money(sum)}</h4>${
      rows.length
        ? `<ul class="plain-list money-list">${rows.slice(0, 5).map((x) => row(esc(x.name), money(x.total))).join("")}</ul>${rows.length > 5 ? `<p class="hint">And ${rows.length - 5} more.</p>` : ""}`
        : '<p class="secondary small">None reported.</p>'
    }</div>`;
  };
  const outside = `
    ${outsideList("S", "Spent to support")}
    ${outsideList("O", "Spent to oppose")}
    <p class="hint">Independent expenditures: groups spending on ads and outreach about this member, without coordinating with the campaign. This money isn't given to the campaign. ${fecLink ? `<a class="tap" href="${esc(fecLink)}" target="_blank" rel="noopener">FEC record ↗</a>` : ""}</p>`;

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
  const breakdown = `<ul class="plain-list money-list">${parts
    .map(([label, v]) => row(esc(label), `${money(v)} <span class="secondary">${pct(v, t.receipts)}</span>`))
    .join("")}</ul>`;
  const avg = f.avg && f.avg.n > 1
    ? `<p class="hint">For comparison, the average of the ${f.avg.n} ${official.chamber === "us-senate" ? "senators" : "House members"} with ${span} filings loaded: raised ${money(f.avg.receipts)}; PACs ${Math.round(100 * (f.avg.pac_share || 0))}% of money raised; small donors ${Math.round(100 * (f.avg.small_share || 0))}%; cash on hand ${money(f.avg.cash)}.${official.chamber === "us-senate" ? " A senator's fundraising varies with where they are in a six-year term." : ""}</p>`
    : "";
  const employers = f.employers.length
    ? `<ul class="plain-list money-list">${f.employers.map((e) => row(esc(e.employer), money(e.total), `${e.count} donors · ${esc(industryName(e.industry))}`)).join("")}</ul>
       <p class="hint">Employers named by donors who gave more than $200, summed; an employer is listed only when ${MIN_EMPLOYER_DONORS} or more people named it. Individual donors are never listed.</p>`
    : '<p class="secondary small">No employer was named by 3 or more donors.</p>';

  return `
${cycleNav(base, f)}
${intro}
<section class="card stack-sm">
  <h3 class="label">Top PAC contributors</h3>
  ${pacs}
</section>
<section class="card stack-sm">
  <h3 class="label">Outside spending for and against</h3>
  ${outside}
</section>
<section class="card stack-sm">
  <h3 class="label">Top contributing industries (approximate)</h3>
  ${industries}
</section>
<section class="card stack-sm">
  <h3 class="label">Totals</h3>
  <div class="grid-2">
    <div class="stat"><div class="stat-num">${money(t.receipts)}</div><div class="stat-label">Raised</div></div>
    <div class="stat"><div class="stat-num">${money(t.disbursements)}</div><div class="stat-label">Spent</div></div>
  </div>
  <p class="small">Cash on hand: <strong>${money(t.cash_on_hand)}</strong>${t.coverage_end ? ` as of ${fmtDate(t.coverage_end)}` : ""}.</p>
  <h4 class="money-sub">Where the money came from</h4>
  ${breakdown}
  ${avg}
</section>
<section class="card stack-sm">
  <h3 class="label">Donors' employers</h3>
  ${employers}
</section>
<p class="hint">Source: Federal Election Commission${fecLink ? ` (<a class="tap" href="${esc(fecLink)}" target="_blank" rel="noopener">${esc(official.name)} at the FEC ↗</a>)` : ""}, ${span}. Read ${fmtDate(f.progress.done_at)}. Federal law bars using contributor information from FEC reports to ask for contributions or for commercial purposes; ThePillory shows totals only and has no donor export. <a class="tap" href="${METHOD}">Methodology</a></p>`;
}

/** "Follow the money" on a bill page. `repMoney`: [{rep, vote, position, money}] for the visitor's reps. */
export function followTheMoney(bill, l, { reps = null, repMoney = [], cycle = null } = {}) {
  const head = '<h2 class="label" id="h-money">Follow the money</h2>';
  if (bill.level !== "federal") {
    return `<section class="card stack-sm" id="money" aria-labelledby="h-money">${head}<p class="secondary small">Lobbying reports are shown for bills in Congress (from the federal lobbying disclosure database). California lobbying comes with the state's new disclosure system.</p></section>`;
  }
  if (!l || !l.progress) {
    return `<section class="card stack-sm" id="money" aria-labelledby="h-money">${head}<p class="secondary small">Lobbying reports for this bill haven't been searched yet. They're searched for every bill with a final-passage vote.</p></section>`;
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
  return `<section class="card stack-sm" id="money" aria-labelledby="h-money">${head}${orgs}${yours}</section>`;
}
