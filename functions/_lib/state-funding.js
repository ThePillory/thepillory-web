// The Funding tab for California officials (the Governor, the statewide
// offices and every legislator), from Cal-Access: the same rules as federal
// funding. Facts with what, when and where from; no cause and effect; no
// individual donor named, at any amount (individuals only as totals and by
// employer). See docs/funding.md.
import { esc, safeUrl, fmtDate } from "./render.js";
import { money, period, METHOD } from "./funding.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const ext = (href, label) => (safeUrl(href) ? `<a class="tap" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>` : "");
const industryName = (k) => INDUSTRIES[k] || INDUSTRIES.other;
const pct = (part, whole) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—");
const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;
const cycleKey = (cycle) => `${cycle - 1}-${cycle}`;
export const CA_SOURCE = "https://cal-access.sos.ca.gov/";

/** Everything the tab needs for one official and two-year period (cycle: the even year it ends). */
export async function stateMoneyFor(db, officialId, cycle) {
  try {
    const key = cycleKey(cycle);
    const [cycles, industries, employers, orgs, ie, committees, check] = await Promise.all([
      db.prepare("SELECT * FROM state_money_cycles WHERE official_id = ? ORDER BY cycle DESC").bind(officialId).all(),
      db.prepare("SELECT * FROM state_money_industries WHERE official_id = ? AND cycle = ? ORDER BY total DESC").bind(officialId, key).all(),
      db.prepare("SELECT * FROM state_money_employers WHERE official_id = ? AND cycle = ? ORDER BY total DESC LIMIT 10").bind(officialId, key).all(),
      db.prepare("SELECT * FROM state_money_orgs WHERE official_id = ? AND cycle = ? ORDER BY total DESC LIMIT 10").bind(officialId, key).all(),
      db.prepare("SELECT * FROM state_money_ie WHERE official_id = ? AND cycle = ? ORDER BY total DESC").bind(officialId, key).all(),
      db.prepare("SELECT * FROM state_campaign_committees WHERE official_id = ? ORDER BY name").bind(officialId).all(),
      db.prepare("SELECT * FROM disclosure_checks WHERE official_id = ? AND source = 'cal-access'").bind(officialId).first(),
    ]);
    const filers = committees.results.map((c) => c.filer_id);
    const totals = filers.length
      ? (await db.prepare(`SELECT * FROM state_campaign_totals WHERE filer_id IN (${filers.map(() => "?").join(",")}) ORDER BY period_end DESC`).bind(...filers).all()).results
      : [];
    return {
      cycle,
      cycles: cycles.results.map((c) => parseInt(c.cycle.slice(5), 10)).filter(Boolean),
      row: cycles.results.find((c) => c.cycle === key) || null,
      industries: industries.results,
      employers: employers.results,
      orgs: orgs.results,
      ie: ie.results,
      committees: committees.results,
      totals,
      check,
    };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

function cycleNav(base, m) {
  const cycles = [...new Set([...m.cycles, m.cycle])].sort((a, b) => b - a);
  if (cycles.length < 2) return "";
  return `<nav class="pill-filter" aria-label="Two-year period">${cycles
    .map((c) => `<a class="toggle" href="${base}?cycle=${c}#funding"${c === m.cycle ? ' aria-current="true"' : ""}>${period(c)}</a>`)
    .join("")}</nav>`;
}

/** "Funding data is loading", until the Cal-Access data has been loaded for this official. */
function loading() {
  return `<div class="card empty-state stack-sm">
  <p>Funding data is loading.</p>
  <p class="small secondary">California campaign finance comes from the Secretary of State's Cal-Access records, rebuilt every week and loaded by the daily data sync. This official's figures appear here once they're loaded.</p>
  <a class="inline-link" href="${METHOD}">How funding is shown</a>
</div>`;
}

function statementsSection(o, m) {
  if (!m.committees.length) return "";
  const blocks = m.committees
    .map((k) => {
      const t = m.totals.filter((x) => x.filer_id === k.filer_id).slice(0, 4);
      return `<div class="stack-xs"><h4 class="money-sub">${esc(k.name || `Committee ${k.filer_id}`)}</h4>${
        t.length
          ? `<ul class="plain-list money-list">${t
              .map((x) => row(`${fmtDate(x.period_start)} to ${fmtDate(x.period_end)}`, `${money(x.contributions)} <span class="secondary">received</span>`, `Spent ${money(x.expenditures)}${x.cash_end != null ? ` · cash at end ${money(x.cash_end)}` : ""} ${ext(x.source_url, "Statement")}`))
              .join("")}</ul>`
          : '<p class="secondary small">No statements loaded for this committee.</p>'
      } ${ext(k.source_url, "Committee record")}</div>`;
    })
    .join("");
  return `<details class="card stack-sm weigh-details" id="campaign">
  <summary class="label">Campaign committees and statements (${m.committees.length})</summary>
  <p class="small">The committees ${esc(o.name)} controls, and each campaign statement (Form 460) with its own totals for its period. A committee can be for another office or a future race, or an officeholder account; each is listed under its own name.</p>
  ${blocks}
</details>`;
}

/** The Funding tab for a California official. `m` is stateMoneyFor's result. */
export function stateFundingTab(o, m, base) {
  if (!m || !m.check) return loading();
  // Statements loaded from an older build of the file, before totals by period: still loading.
  if (!m.cycles.length && m.committees.length) return `${loading()}${statementsSection(o, m)}`;
  const span = period(m.cycle);
  const asOf = esc(String(m.check.note || "").replace(/^Cal-Access export of /, "the Cal-Access export of "));
  const intro = `<p class="small">Money raised and spent by the campaign committees ${esc(o.name)} controls in ${span}, as reported to the California Secretary of State. These are facts about money; they don't explain any vote or action in office.</p>`;
  const r = m.row;
  if (!r) {
    return `${cycleNav(base, m)}${intro}<p class="secondary small">${esc(m.committees.length ? `No campaign statements for ${span}.` : m.check.note || "No campaign statements found.")}</p>${statementsSection(o, m)}`;
  }

  const totals = `<section class="card hero-stat">
  <p class="label">Raised · ${span}</p>
  <p class="hero-num">${money(r.raised)}</p>
  <p class="small secondary">Spent ${money(r.spent)}</p>
</section>
<section class="card stack-sm">
  <h3>Totals</h3>
  <ul class="plain-list money-list">
    ${row("Raised", money(r.raised), `${r.statements} statement${r.statements === 1 ? "" : "s"}, Summary Page line 5`)}
    ${row("Spent", money(r.spent), "Summary Page line 11")}
    ${r.individuals_total != null ? row("From individuals (itemized)", `${money(r.individuals_total)} <span class="secondary">${pct(r.individuals_total, r.raised)}</span>`, `${(r.individuals_count || 0).toLocaleString("en-US")} contributions of $100 or more, net of refunds`) : ""}
  </ul>
  ${r.raised === 0 ? `<p class="small">No contributions were reported received in ${span} by the committees ${esc(o.name)} controls. A committee can keep spending money raised in earlier periods${m.committees.length ? '; each statement\'s cash on hand is listed under "Campaign committees and statements" below' : ""}.${m.cycles.some((c) => c !== m.cycle) ? " Other periods are listed above." : ""}</p>` : ""}
  <p class="hint">Sums of each statement's own figures for its period. Contributions under $100 aren't itemized, so they're in "Raised" but not in the lists below.</p>
</section>`;

  const known = m.industries.filter((i) => i.industry !== "other");
  const all = m.industries.reduce((s, i) => s + i.total, 0);
  const classified = known.reduce((s, i) => s + i.total, 0);
  const industries = `<section class="card stack-sm">
  <h3>Top contributing industries (approximate)</h3>
  ${
    known.length
      ? `<ul class="plain-list money-list">${known.slice(0, 8).map((i) => row(esc(industryName(i.industry)), money(i.total))).join("")}</ul>
  <p class="hint">Approximate. Industries are assigned by keywords in organizations' names and in the employers individual donors named; ${pct(classified, all)} of these itemized dollars matched an industry, and the rest are left unclassified rather than guessed.</p>
  <a class="inline-link" href="${METHOD}">How industries are assigned</a>`
      : '<p class="secondary small">No itemized contributions matched an industry category.</p>'
  }
</section>`;

  const employers = `<section class="card stack-sm">
  <h3>Top employers of individual donors</h3>
  ${
    m.employers.length
      ? `<ul class="plain-list money-list">${m.employers.map((e) => row(esc(e.employer), money(e.total), `${e.count} donors · ${esc(industryName(e.industry))}`)).join("")}</ul>`
      : '<p class="secondary small">No employer was named by 3 or more donors.</p>'
  }
  <p class="hint">The employers individual donors named, summed; an employer is listed only when 3 or more people named it.${r.not_employed_total ? ` ${money(r.not_employed_total)} came from people who listed no employer (retired, not employed or self-employed).` : ""} Individual donors are never named on ThePillory, at any amount.</p>
</section>`;

  const orgs = `<section class="card stack-sm">
  <h3>Committees, parties and organizations</h3>
  ${
    m.orgs.length
      ? `<ul class="plain-list money-list">${m.orgs.map((x) => row(esc(x.name), money(x.total), `${x.count} contribution${x.count === 1 ? "" : "s"} · ${esc(x.kind)} · ${esc(industryName(x.industry))}`)).join("")}</ul>`
      : '<p class="secondary small">No contributions from committees or organizations itemized in this period.</p>'
  }
  <p class="hint">Contributions itemized on Schedule A from political committees, parties, businesses and other organizations, by the name reported. Transfers between ${esc(o.name)}'s own committees aren't counted.</p>
</section>`;

  const side = (so) => m.ie.filter((x) => x.support_oppose === so);
  const ieList = (so, label) => {
    const rows = side(so);
    const sum = rows.reduce((s, x) => s + x.total, 0);
    return `<div class="stack-xs"><h4 class="money-sub">${label}: ${money(sum)}</h4>${
      rows.length
        ? `<ul class="plain-list money-list">${rows
            .slice(0, 6)
            .map((x) => row(esc(x.spender), money(x.total), `${[x.race ? `race: ${esc(x.race)}` : "", `${x.filings} report${x.filings === 1 ? "" : "s"}`, x.first_date ? `${fmtDate(x.first_date)}${x.last_date && x.last_date !== x.first_date ? ` to ${fmtDate(x.last_date)}` : ""}` : ""].filter(Boolean).join(" · ")}<div>${ext(x.source_url, "Spender's record")}</div>`))
            .join("")}</ul>${rows.length > 6 ? `<p class="hint">And ${rows.length - 6} more.</p>` : ""}`
        : '<p class="secondary small">None reported.</p>'
    }</div>`;
  };
  const ie = `<section class="card stack-sm">
  <h3>Independent expenditures for and against</h3>
  ${ieList("support", "Spent to support")}
  ${ieList("oppose", "Spent to oppose")}
  <p class="hint">Spending on ads and outreach about ${esc(o.name)} by committees that don't coordinate with the campaign; this money isn't given to the campaign. From Form 496 reports, which are filed for independent expenditures of $1,000 or more made in the 90 days before an election; spending outside that window isn't included. Each spender links to its committee record, where its own donors are listed.</p>
</section>`;

  return `
${cycleNav(base, m)}
${intro}
${totals}
${industries}
${employers}
${orgs}
${ie}
${statementsSection(o, m)}
<p class="hint">From ${asOf}. California replaces Cal-Access with a new disclosure system after the November 2026 election.</p>
<a class="inline-link" href="${METHOD}">Methodology</a>`;
}
