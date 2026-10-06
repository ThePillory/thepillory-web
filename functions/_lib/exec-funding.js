// The Funding tab for the executive branch: the same rules as for Congress
// (facts with what, when and where from; no cause and effect; no individual
// donor named), applied to every office the same way.
//
//   President         FEC campaign money (the same tab as Congress), the
//                     inaugural committee, and OGE financial disclosures.
//   Vice President    the ticket's campaign money (the President's committee),
//                     the inaugural committee, and OGE financial disclosures.
//   Cabinet           no campaign money (appointed); OGE financial disclosure
//                     reports and ethics agreements.
//   California        Cal-Access campaign committees and FPPC Form 700s.
import { esc, safeUrl, fmtDate } from "./render.js";
import { fundingFor, fundingTab, money, METHOD } from "./funding.js";
import { stateMoneyFor, stateFundingTab } from "./state-funding.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const ext = (href, label) => (safeUrl(href) ? `<a class="tap" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>` : "");
const DISCLOSURES = "/about/methodology/#disclosures";

// ---------------------------------------------------------------------------
// Data

async function orNull(fn) {
  try {
    return await fn();
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

export async function disclosuresFor(db, officialId, source) {
  return orNull(async () => {
    const [rows, check] = await Promise.all([
      db.prepare("SELECT * FROM disclosures WHERE official_id = ? AND source = ? ORDER BY filed_on DESC, doc_type").bind(officialId, source).all(),
      db.prepare("SELECT * FROM disclosure_checks WHERE official_id = ? AND source = ?").bind(officialId, source).first(),
    ]);
    return { rows: rows.results, check };
  });
}

export async function inauguralFor(db, presidentId) {
  return orNull(async () => {
    const committee = await db.prepare("SELECT * FROM inaugural_committees WHERE official_id = ? ORDER BY term_start DESC LIMIT 1").bind(presidentId).first();
    if (!committee) return { committee: null };
    const [reports, breakdown, orgs] = await Promise.all([
      db.prepare("SELECT * FROM inaugural_reports WHERE committee_id = ? ORDER BY coverage_start").bind(committee.committee_id).all(),
      db.prepare("SELECT * FROM inaugural_breakdown WHERE committee_id = ?").bind(committee.committee_id).first(),
      db.prepare("SELECT * FROM inaugural_organizations WHERE committee_id = ? ORDER BY total DESC LIMIT 15").bind(committee.committee_id).all(),
    ]);
    return { committee, reports: reports.results, breakdown, orgs: orgs.results };
  });
}

/** A California official's money (Cal-Access) and Form 700s (FPPC): the Governor, statewide officers and legislators alike. */
export async function stateOfficialMoney(db, o, cycle) {
  const [money_, form700] = await Promise.all([stateMoneyFor(db, o.id, cycle), disclosuresFor(db, o.id, "fppc")]);
  return { kind: "state", money: money_, form700 };
}

/**
 * Everything the Funding tab needs for an executive office. `o.rank`: 1 the
 * President (or the Governor), 2 the Vice President (or Lieutenant Governor).
 */
export async function executiveMoney(db, o, cycle) {
  if (o.chamber === "ca-executive") return stateOfficialMoney(db, o, cycle);
  const president = o.rank === 1 ? o : await db.prepare("SELECT * FROM officials WHERE chamber = 'us-executive' AND rank = 1 AND active = 1").first();
  const elected = o.rank === 1 || o.rank === 2;
  // The Vice President ran on the President's ticket when their terms began together.
  const ticket = o.rank === 2 && president && president.term_start && president.term_start === o.term_start;
  const [campaign, inaugural, oge] = await Promise.all([
    elected && president && (o.rank === 1 || ticket) ? fundingFor(db, president, cycle) : null,
    elected && president && (o.rank === 1 || ticket) ? inauguralFor(db, president.id) : null,
    disclosuresFor(db, o.id, "oge"),
  ]);
  return { kind: o.rank === 1 ? "president" : o.rank === 2 ? "vice-president" : "cabinet", president, ticket, campaign, inaugural, oge };
}

// ---------------------------------------------------------------------------
// Rendering

const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;

function inauguralSection(i) {
  const head = '<h3 class="label" id="inaugural">Inaugural committee donations</h3>';
  if (!i) return "";
  if (!i.committee) {
    return `<section class="card stack-sm">${head}<p class="secondary small">No inaugural committee loaded yet. It's looked up at the Federal Election Commission in the daily data sync.</p></section>`;
  }
  const c = i.committee;
  const year = String(c.term_start).slice(0, 4);
  const reports = i.reports.length
    ? `<ul class="plain-list money-list">${i.reports
        .map((r) =>
          row(
            `${esc(r.report)}${r.amended ? " (amended)" : ""}`,
            r.total_receipts == null ? '<span class="secondary">not stated</span>' : money(r.total_receipts),
            `Covers ${fmtDate(r.coverage_start)}${r.coverage_end ? ` to ${fmtDate(r.coverage_end)}` : ""}${r.receipt_date ? ` · filed ${fmtDate(r.receipt_date)}` : ""} ${ext(r.pdf_url || r.source_url, "Report")}`
          )
        )
        .join("")}</ul>
       <p class="hint">Total receipts as each report states them. A later report can repeat earlier amounts, so these aren't added together.</p>`
    : '<p class="secondary small">No Form 13 reports filed yet.</p>';
  const b = i.breakdown;
  let breakdown = "";
  if (b && !b.note) {
    breakdown = `<h4 class="money-sub">Itemized donations in the report "${esc(b.report || "Form 13")}"</h4>
      <ul class="plain-list money-list">
        ${row("From organizations", money(b.organization_total), `${(b.organization_count || 0).toLocaleString("en-US")} organizations`)}
        ${row("From individuals", money(b.individual_total), `${(b.individual_count || 0).toLocaleString("en-US")} donations · names not shown`)}
        ${b.other_total ? row("Unitemized or unattributed", money(b.other_total)) : ""}
      </ul>
      ${b.refunds_total ? `<p class="hint">The report also lists ${money(b.refunds_total)} in donations refunded.</p>` : ""}
      ${
        i.orgs.length
          ? `<h4 class="money-sub">Largest organizations</h4><ul class="plain-list money-list">${i.orgs.map((o) => row(esc(o.name), money(o.total), `${o.count} donation${o.count === 1 ? "" : "s"}`)).join("")}</ul>`
          : ""
      }`;
  } else if (b && b.note) {
    breakdown = `<p class="secondary small">${esc(b.note)}</p>`;
  }
  return `<section class="card stack-sm" aria-labelledby="inaugural">
  ${head}
  <p class="small">${esc(c.name)} raised money for the ${esc(year)} inauguration. Inaugural committees have no federal limit on donation size; they report every donation of $200 or more to the Federal Election Commission after the inauguration (Form 13). This money pays for inaugural events; it isn't campaign money.</p>
  ${reports}
  ${breakdown}
  <p class="hint">Source: ${ext(c.source_url, "the committee at the FEC")}. Individual donors are never named on ThePillory, at any amount. <a class="tap" href="${METHOD}">Methodology</a></p>
</section>`;
}

function disclosureRows(rows) {
  return rows
    .map((d) => {
      const link =
        d.source === "fppc"
          ? `<a class="tap" href="/api/form700/${esc(String(d.id).replace(/^fppc:/, ""))}" target="_blank" rel="noopener">Statement (PDF) ↗</a>`
          : d.document_url ? ext(d.document_url, "Document") : d.request_url ? ext(d.request_url, "Request from OGE") : "";
      const meta = [d.position, d.agency !== d.position ? d.agency : null].filter(Boolean).map(esc).join(" · ");
      return `<li class="exec-row stack-xs">
  <span>${esc(d.doc_type)}${d.amended_on && d.source === "oge" ? ` <span class="secondary small">(amended ${esc(d.amended_on)})</span>` : ""}</span>
  ${meta ? `<span class="small secondary">${meta}</span>` : ""}
  <span class="small secondary">${d.filed_on ? `${d.source === "oge" ? "Added" : "Filed"} ${fmtDate(d.filed_on)}` : ""}${d.period ? ` · covers ${esc(d.period)}` : ""}${d.amended_on && d.source === "fppc" ? " · amendment" : ""} ${link}</span>
</li>`;
    })
    .join("");
}

function ogeSection(d, name) {
  const head = '<h3 class="label" id="disclosures">Financial disclosures and ethics agreements</h3>';
  const intro = `<p class="small">Senior federal officials file public financial disclosure reports (OGE Form 278e): their assets, income, debts, outside positions and agreements. Nominees also sign an ethics agreement saying how they will avoid conflicts of interest, for example by selling assets or stepping aside from certain matters. These are the records the Office of Government Ethics lists for ${esc(name)}.</p>`;
  if (!d || !d.check) {
    return `<section class="card stack-sm" aria-labelledby="disclosures">${head}${intro}<p class="secondary small">Not loaded yet. The Office of Government Ethics' records are searched in the daily data sync.</p></section>`;
  }
  if (!d.rows.length) {
    return `<section class="card stack-sm" aria-labelledby="disclosures">${head}${intro}<p class="secondary small">${esc(d.check.note || "No records listed.")} Searched ${fmtDate(String(d.check.checked_at).slice(0, 10))}.</p><p class="hint">${ext("https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm", "Search OGE's records")}</p></section>`;
  }
  const ethics = d.rows.filter((r) => r.kind === "ethics");
  const reports = d.rows.filter((r) => r.kind !== "ethics");
  const list = (rows, n) =>
    `<ul class="plain-list exec-list">${disclosureRows(rows.slice(0, n))}</ul>${
      rows.length > n ? `<details class="weigh-details"><summary>${rows.length - n} more</summary><ul class="plain-list exec-list">${disclosureRows(rows.slice(n))}</ul></details>` : ""
    }`;
  return `<section class="card stack-sm" aria-labelledby="disclosures">
  ${head}
  ${intro}
  <h4 class="money-sub">Ethics agreements (${ethics.length})</h4>
  ${ethics.length ? list(ethics, 6) : '<p class="secondary small">None listed.</p>'}
  <h4 class="money-sub">Financial disclosure reports (${reports.length})</h4>
  ${reports.length ? list(reports, 6) : '<p class="secondary small">None listed.</p>'}
  <p class="hint">"Added" is the date OGE posted the record. OGE releases some documents only on request (its Form 201), so those link to the request form. Records are matched to ${esc(name)} by name. Source: ${ext("https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm", "Office of Government Ethics")}, searched ${fmtDate(String(d.check.checked_at).slice(0, 10))}. <a class="tap" href="${DISCLOSURES}">How</a></p>
</section>`;
}

/** Form 700s (FPPC), for More. */
export function stateForm700(m) {
  const f = m.form700;
  const head7 = '<h3 class="label" id="disclosures">Statements of economic interests (Form 700)</h3>';
  const intro7 = `<p class="small">California officials file a Statement of Economic Interests (Form 700) each year: their investments, real property, income and gifts. Statewide officers and members of the Legislature file theirs with the Fair Political Practices Commission (FPPC), which publishes them.</p>`;
  let form700;
  if (!f || !f.check) form700 = `<section class="card stack-sm" aria-labelledby="disclosures">${head7}${intro7}<p class="secondary small">Not loaded yet. The FPPC's Form 700 records are searched in the daily data sync.</p></section>`;
  else if (!f.rows.length) form700 = `<section class="card stack-sm" aria-labelledby="disclosures">${head7}${intro7}<p class="secondary small">${esc(f.check.note || "No statements listed.")}</p></section>`;
  else
    form700 = `<section class="card stack-sm" aria-labelledby="disclosures">${head7}${intro7}<ul class="plain-list exec-list">${disclosureRows(f.rows.slice(0, 10))}</ul><p class="hint">Source: ${ext("https://form700search.fppc.ca.gov/", "FPPC Form 700 search")}, searched ${fmtDate(String(f.check.checked_at).slice(0, 10))}. <a class="tap" href="${DISCLOSURES}">How</a></p></section>`;
  return form700;
}

/**
 * An executive office's money and disclosures, apart: `funding` for the
 * Funding tab (campaign money; the President's inaugural committee) and
 * `disclosures` for More (OGE reports and ethics agreements, or Form 700s).
 * Cabinet members have no campaign money: `funding` is null for them.
 */
export function executiveFundingParts(o, m, base) {
  if (!m) return { funding: '<p class="secondary small">Not loaded yet.</p>', disclosures: '<p class="secondary small">Not loaded yet.</p>' };
  if (m.kind === "state") return { funding: stateFundingTab(o, m.money, base), disclosures: stateForm700(m) };
  const parts = [];
  if (m.kind === "president") {
    parts.push(fundingTab(o, m.campaign, base));
    if (m.inaugural) parts.push(inauguralSection(m.inaugural));
  } else if (m.kind === "vice-president") {
    if (m.ticket && m.president) {
      parts.push(`<p class="small">The President and Vice President ran on one ticket. The Federal Election Commission records the ticket's money under the presidential campaign committee, so these are the same figures as on <a class="inline-link" href="/reps/${esc(m.president.slug)}/#funding">${esc(m.president.name)}'s</a> Funding tab.</p>`);
      parts.push(fundingTab(m.president, m.campaign, base));
    } else {
      parts.push('<p class="secondary small">The Vice President took office separately from the President\'s ticket, so the presidential campaign\'s money isn\'t theirs.</p>');
    }
    if (m.inaugural) parts.push(inauguralSection(m.inaugural));
  }
  return { funding: parts.length ? parts.join("\n") : null, disclosures: ogeSection(m.oge, o.name) };
}
