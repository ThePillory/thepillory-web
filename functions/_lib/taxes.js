// Taxes (docs/taxes.md): the Corporations side of /taxes/ and the line on
// organization panels.
//   /taxes/companies/         every company filing a 10-K that tags these values:
//                             search by name or ticker, filter by industry (SIC) and
//                             state, sorted by name, revenue or pretax income only
//   /taxes/companies/<cik>/   one company: the latest fiscal year, a chart of taxes
//                             paid and pretax income by year, the federal / state /
//                             foreign split when filed, every number linked to its
//                             filing, and what ThePillory already has for the same
//                             organization, side by side as facts
//   taxMarker() / fillTaxLines()  "Taxes paid (FY2025): $X · pretax income $Y ›" on
//                             donor, lobbying and measure-signer organization panels,
//                             filled in by functions/_middleware.js in one query
// Data: companies, company_tax_years, company_tax_jurisdictions, company_orgs
// (migration 0047; tools/build_company_taxes.py, weekly, from SEC EDGAR XBRL).
// Rules: a value the filing doesn't tag is shown as not reported, never estimated;
// nothing is sorted, ranked, labeled or colored by taxes paid or by any rate; the
// same layout for every company; no person is named.
import { esc, fmtDate, safeUrl, sourceLink } from "./render.js";
import { pairBars } from "./charts.js";
import { fold } from "./summary.js";
import { STATE_NAME } from "./districts.js";
import { nameKey } from "../awards/index.js";

export const TAXES_METHOD = "/about/methodology/#company-taxes";
export const PER_PAGE = 25;
export const SORTS = { name: "Name", revenue: "Revenue", pretax: "Pretax income" };

// Each value, labeled for what it is (the XBRL element behind it is in "Show the numbers").
export const LABELS = {
  taxes_paid: "Income taxes paid, net of refunds",
  paid_federal: "Federal income taxes paid, net of refunds",
  paid_state: "State and local income taxes paid, net of refunds",
  paid_foreign: "Foreign income taxes paid, net of refunds",
  current_federal: "Current federal income tax expense (benefit)",
  current_state: "Current state and local income tax expense (benefit)",
  deferred: "Deferred income tax expense (benefit)",
  pretax: "Income (loss) before income taxes",
  pretax_us: "Income (loss) before income taxes, U.S.",
  pretax_foreign: "Income (loss) before income taxes, foreign",
  revenue: "Revenue",
};
export const ELEMENTS = {
  taxes_paid: "IncomeTaxesPaidNet",
  paid_federal: "IncomeTaxPaidFederalAfterRefundReceived",
  paid_state: "IncomeTaxPaidStateAndLocalAfterRefundReceived",
  paid_foreign: "IncomeTaxPaidForeignAfterRefundReceived",
  current_federal: "CurrentFederalTaxExpenseBenefit",
  current_state: "CurrentStateAndLocalTaxExpenseBenefit",
  deferred: "DeferredIncomeTaxExpenseBenefit",
  pretax_us: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic",
  pretax_foreign: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign",
};
// The second element some companies use excludes income from equity-method investments: said so.
const PRETAX_EQUITY = "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";
const pretaxLabel = (tag) => (tag === PRETAX_EQUITY ? "Income (loss) before income taxes and equity-method investments" : LABELS.pretax);
const TABLE_FIELDS = ["taxes_paid", "paid_federal", "paid_state", "paid_foreign", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"];
const NOT_REPORTED = "Not reported";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** "$34.6 billion", "−$72.0 million", "$850,000". */
export function money(n) {
  const v = num(n);
  if (v == null) return NOT_REPORTED;
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)} trillion`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)} billion`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)} million`;
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}
/** Every dollar: "$34,588,000,000". */
export function exact(n) {
  const v = num(n);
  return v == null ? NOT_REPORTED : `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (iso) => (iso ? `${MONTHS[parseInt(iso.slice(5, 7), 10) - 1]} ${iso.slice(0, 4)}` : "");
/** "Fiscal year 2025 (Feb 2025 – Jan 2026)": the year as the company names it, with its months. */
export function fiscalYear(y) {
  const name = y.fy ? `Fiscal year ${y.fy}` : `Fiscal year ended ${fmtDate(y.period_end)}`;
  return y.period_start ? `${name} (${month(y.period_start)} – ${month(y.period_end)})` : name;
}
export const fyShort = (y) => (y.fy ? `FY${y.fy}` : `FY ending ${month(y.period_end)}`);

/** The filing a value comes from: its index page on EDGAR. */
export function filingUrl(cik, accn) {
  if (!/^\d{10}-\d{2}-\d{6}$/.test(String(accn || ""))) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/${accn}-index.htm`;
}
const srcOf = (y) => {
  try {
    return typeof y.src === "string" ? JSON.parse(y.src || "{}") : y.src || {};
  } catch {
    return {};
  }
};
const valueLink = (cik, y, field) => {
  const v = num(y[field]);
  const href = v == null ? null : filingUrl(cik, srcOf(y)[field]);
  return href ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(exact(v))}</a>` : esc(v == null ? NOT_REPORTED : exact(v));
};

export const companyHref = (cik) => `/taxes/companies/${Number(cik)}/`;

// ---------------------------------------------------------------------------
// Data

/** One company and its years, jurisdictions and matched organizations; null when it isn't loaded. */
export async function loadCompany(db, cik) {
  try {
    const c = await db.prepare("SELECT * FROM companies WHERE cik = ?").bind(cik).first();
    if (!c) return null;
    const [years, jur, orgs] = await Promise.all([
      db.prepare("SELECT * FROM company_tax_years WHERE cik = ? ORDER BY period_end").bind(cik).all(),
      db.prepare("SELECT * FROM company_tax_jurisdictions WHERE cik = ? ORDER BY period_end DESC, element, amount DESC").bind(cik).all(),
      db.prepare("SELECT kind, org_name, how, summary FROM company_orgs WHERE cik = ? ORDER BY kind, org_name").bind(cik).all(),
    ]);
    return { company: c, years: years.results, jurisdictions: jur.results, orgs: orgs.results };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** The list's filters from a query string, every value checked. */
export function listFilters(params) {
  const q = String(params.get("q") || "").trim().slice(0, 80);
  const sic = /^\d{3,4}$/.test(params.get("sic") || "") ? params.get("sic") : "";
  const state = /^[A-Z]{2}$/.test(params.get("state") || "") && STATE_NAME[params.get("state")] ? params.get("state") : "";
  const sort = SORTS[params.get("sort")] ? params.get("sort") : "name";
  const offset = Math.max(0, parseInt(params.get("offset") || "0", 10) || 0);
  return { q, sic, state, sort, offset };
}

export function listHref(f, offset = 0) {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.sic) p.set("sic", f.sic);
  if (f.state) p.set("state", f.state);
  if (f.sort && f.sort !== "name") p.set("sort", f.sort);
  if (offset) p.set("offset", String(offset));
  const s = p.toString();
  return `/taxes/companies/${s ? `?${s}` : ""}`;
}

// Name, revenue or pretax income: the only orders there are (never taxes paid, never a rate).
const ORDER = { name: "name", revenue: "revenue IS NULL, revenue DESC, name", pretax: "pretax IS NULL, pretax DESC, name" };

/** One page of the list. {rows, more} or null before the tables exist. */
export async function listCompanies(db, f, limit = PER_PAGE) {
  const where = [];
  const args = [];
  if (f.q) {
    where.push("(name LIKE ? OR (',' || IFNULL(tickers, '') || ',') LIKE ?)");
    args.push(`%${f.q.replace(/[%_]/g, "")}%`, `%,${f.q.toUpperCase().replace(/[^A-Z0-9.-]/g, "")},%`);
  }
  if (f.sic) {
    where.push("sic = ?");
    args.push(f.sic);
  }
  if (f.state) {
    where.push("state = ?");
    args.push(f.state);
  }
  try {
    const { results } = await db
      .prepare(`SELECT cik, name, tickers, sic_desc, state, latest_fy, latest_end, revenue, pretax FROM companies${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${ORDER[f.sort] || ORDER.name} LIMIT ? OFFSET ?`)
      .bind(...args, limit + 1, f.offset)
      .all();
    return { rows: results.slice(0, limit), more: results.length > limit };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** Industries (SIC) with companies, for the filter. */
export async function industries(db) {
  try {
    return (await db.prepare("SELECT sic, sic_desc, COUNT(*) AS n FROM companies WHERE sic IS NOT NULL AND sic_desc IS NOT NULL GROUP BY sic, sic_desc ORDER BY sic_desc").all()).results;
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** When the data was last loaded. */
export async function loadedAt(db) {
  try {
    const r = await db.prepare("SELECT MAX(updated_at) AS at, COUNT(*) AS n FROM companies").first();
    return r && r.n ? r : null;
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pages

export const READING = `<section class="card stack-sm" id="reading">
  <h2 class="h3">Reading these numbers</h2>
  <p class="small">Income taxes paid is the cash a company paid to tax authorities in the fiscal year, after refunds. It differs from tax expense, which is what the income statement records for the year: some tax is paid in a later or an earlier year than the income it's on (timing), refunds of earlier years' taxes count in the year they're received, and deferred tax is recorded now but paid, or not, later.</p>
  <p class="small">Losses carried forward from earlier years, tax credits and deductions set by law can lower the taxes paid in a year. Foreign taxes are paid to other countries' governments, on income earned there.</p>
  <p class="small">The figures are as each company reports them in its 10-K. They're shown as filed, without conclusions about them. <a class="inline-link" href="${TAXES_METHOD}">How this works</a></p>
</section>`;

const SWITCH = (on) => `<nav class="segmented list-switch" aria-label="Show">${[["taxpayers", "Taxpayers", "/taxes/taxpayers/"], ["wealth", "Wealth", "/taxes/wealth/"], ["companies", "Corporations", "/taxes/companies/"]]
  .map(([k, label, href]) => `<a class="toggle" href="${href}"${k === on ? ' aria-current="true"' : ""}>${label}</a>`)
  .join("")}</nav>`;
export const taxesSwitch = SWITCH;

const meta = (c) => [c.sic_desc ? esc(c.sic_desc) : "", c.state ? esc(STATE_NAME[c.state] || c.state) : ""].filter(Boolean).join(" · ");

/** One company in the list: name and tickers; industry, state, the latest year's revenue and pretax income. */
export function companyRow(c) {
  const fy = c.latest_fy ? `FY${c.latest_fy}` : "";
  const facts = [meta(c), num(c.revenue) != null ? `${esc(fy)} revenue ${esc(money(c.revenue))}` : "", num(c.pretax) != null ? `pretax income ${esc(money(c.pretax))}` : ""].filter(Boolean).join(" · ");
  return `<a class="compact-row" href="${companyHref(c.cik)}">
  <span class="cr-main"><span class="cr-title">${esc(c.name)}${c.tickers ? ` <span class="secondary">(${esc(c.tickers.split(",").join(", "))})</span>` : ""}</span><span class="cr-meta">${facts}</span></span>
  <span class="cr-side"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function listForm(f, inds) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const states = Object.entries(STATE_NAME).sort((a, b) => a[1].localeCompare(b[1]));
  return `<form class="card stack-sm trade-filters" method="get" action="/taxes/companies/">
  <label class="label" for="co-q">Name or ticker</label>
  <div class="lookup-row">
    <input class="input" id="co-q" name="q" type="search" value="${esc(f.q)}" placeholder="A company's name or ticker" autocomplete="off" />
    <button class="btn btn--primary" type="submit">Show</button>
  </div>
  <label class="label" for="co-sic">Industry</label>
  <select class="input" id="co-sic" name="sic" data-autosubmit>${opt("", "Every industry", f.sic)}${inds.map((i) => opt(i.sic, i.sic_desc, f.sic)).join("")}</select>
  <label class="label" for="co-state">State (business address)</label>
  <select class="input" id="co-state" name="state" data-autosubmit>${opt("", "Every state", f.state)}${states.map(([c, n]) => opt(c, n, f.state)).join("")}</select>
  <label class="label" for="co-sort">Order</label>
  <select class="input" id="co-sort" name="sort" data-autosubmit>${Object.entries(SORTS).map(([k, label]) => opt(k, label, f.sort)).join("")}</select>
</form>`;
}

const KINDS = [
  ["pac", "Political action committee", "Contributions to members of Congress, as the FEC lists them, by election cycle.", "No political action committee under this exact name, or linked to this company by a person."],
  ["lobbying", "Federal lobbying", "Lobbying reports (lda.gov) naming it as the client: the income its lobbying firms reported, or its own lobbying expenses, every issue.", "No federal lobbying reports under this exact name."],
  ["ld203", "Contributions reported by lobbying organizations (LD-203)", "Contributions honoring members of Congress that it reported as a registered lobbying organization.", "No LD-203 reports under this exact name."],
  ["ca-lobbying", "California lobbying", "Payments for lobbying reported on California Forms 635 and 645.", "No California lobbying reports under this exact name."],
  ["ca-measures", "California ballot measures, 2026", "Money it gave to committees formed for 2026 statewide measures, or spent on its own.", "None reported under this exact name on 2026 statewide measures."],
];

function orgFacts(c, orgs) {
  const rows = KINDS.map(([kind, title, what, none]) => {
    const mine = orgs.filter((o) => o.kind === kind);
    if (!mine.length) return `<div class="signer-fact"><p class="label">${esc(title)}</p><p class="small secondary">${esc(none)}</p></div>`;
    const items = mine.map((o) => {
      let s = {};
      try {
        s = JSON.parse(o.summary || "{}");
      } catch {
        s = {};
      }
      const years = s.first && s.last ? (s.first === s.last ? s.first : `${s.first}–${s.last}`) : "";
      const how = o.how === "confirmed" ? "Linked to this company by a person." : "Matched by the same name.";
      return `<li class="small">${esc(o.org_name)}: ${esc(money(s.total))}${years ? `, ${esc(years)}` : ""}${s.count ? ` (${esc(String(s.count))} ${s.count === 1 ? "record" : "records"})` : ""}. <span class="secondary">${esc(how)}</span> ${s.source_url && safeUrl(s.source_url) ? sourceLink(s.source_url, "Latest filing") : ""}</li>`;
    });
    return `<div class="signer-fact"><p class="label">${esc(title)}</p><p class="small secondary">${esc(what)}</p><ul class="plain-list stack-xs">${items.join("")}</ul></div>`;
  });
  rows.push(`<div class="signer-fact"><p class="label">Federal awards</p><p class="small"><a class="inline-link" href="/awards/?name=${encodeURIComponent(c.name)}">Contracts and grants under this exact name (USAspending.gov) ›</a></p></div>`);
  return `<section class="card stack-sm" id="records">
  <h2 class="h3">In ThePillory's other records</h2>
  <p class="small secondary">Under this company's exact name, or an organization a person has linked to it; one company per name. Shown side by side as facts. ThePillory doesn't connect them to the taxes above.</p>
  ${rows.join("")}
</section>`;
}

/** The company page's main content. */
export function companyMain({ company: c, years, jurisdictions, orgs }) {
  const latest = [...years].reverse().find((y) => num(y.taxes_paid) != null || num(y.pretax) != null) || years[years.length - 1] || null;
  const head = `<header class="page-head">
  <p class="label">Corporation · SEC filer</p>
  <h1>${esc(c.name)}</h1>
  <p class="subtitle">${[c.tickers ? esc(c.tickers.split(",").join(", ")) : "", meta(c)].filter(Boolean).join(" · ")}</p>
</header>`;
  if (!latest) {
    return `${head}<section class="card"><p class="small secondary">No fiscal year with these values is tagged in this company's 10-K filings yet.</p></section>${READING}`;
  }
  const line = (label, field, y = latest) => `<div class="kv-row"><dt>${esc(label)}</dt><dd>${valueLink(c.cik, y, field)}</dd></div>`;
  const split = ["paid_federal", "paid_state", "paid_foreign"].some((f) => num(latest[f]) != null);
  const jurs = jurisdictions.filter((j) => j.period_end === latest.period_end);
  const elementName = { IncomeTaxPaidFederalAfterRefundReceived: "federal", IncomeTaxPaidStateAndLocalAfterRefundReceived: "state and local", IncomeTaxPaidForeignAfterRefundReceived: "foreign", IncomeTaxesPaidNet: "total" };
  const card = `<section class="card stack-sm" id="latest">
  <h2 class="h3">${esc(fiscalYear(latest))}</h2>
  <dl class="kv kv--tight">
    ${line(LABELS.taxes_paid, "taxes_paid")}
    ${line(pretaxLabel(latest.pretax_tag), "pretax")}
  </dl>
  ${split ? `<p class="label">Taxes paid, as the 10-K splits them</p>
  <dl class="kv kv--tight">${line("Federal", "paid_federal")}${line("State and local", "paid_state")}${line("Foreign", "paid_foreign")}</dl>` : ""}
  ${jurs.length ? `<p class="label">By jurisdiction, as filed</p>
  <dl class="kv kv--tight">${jurs.map((j) => `<div class="kv-row"><dt>${esc(j.name)} <span class="secondary">(${esc(elementName[j.element] || "")})</span></dt><dd>${filingUrl(c.cik, j.accn) ? `<a class="inline-link" href="${esc(filingUrl(c.cik, j.accn))}" target="_blank" rel="noopener">${esc(exact(j.amount))}</a>` : esc(exact(j.amount))}</dd></div>`).join("")}</dl>
  <p class="xsmall secondary">Companies list each jurisdiction that is 5% or more of their income taxes paid (ASU 2023-09).</p>` : ""}
  <p class="xsmall secondary">Each amount links to the 10-K it's from. "Not reported" means the filing doesn't tag that value; nothing is estimated.</p>
</section>`;
  const chart = pairBars(
    years.map((y) => ({ label: fiscalYear(y), tick: y.fy ? `'${String(y.fy).slice(2)}` : y.period_end.slice(2, 4), a: num(y.taxes_paid), b: num(y.pretax), hrefA: filingUrl(c.cik, srcOf(y).taxes_paid), hrefB: filingUrl(c.cik, srcOf(y).pretax) })),
    { series: [LABELS.taxes_paid, LABELS.pretax], format: exact, head: "Fiscal year", caption: "By fiscal year, as each 10-K reports them. A missing bar is a value the filing doesn't tag.", ariaLabel: `${c.name}: income taxes paid and income before income taxes by fiscal year` }
  );
  const all = fold(
    "numbers",
    "Show the numbers",
    `<div class="table-scroll"><table class="usage-table"><thead><tr><th scope="col">Value</th>${years.map((y) => `<th scope="col">${esc(fyShort(y))}</th>`).join("")}</tr></thead><tbody>${TABLE_FIELDS.map((f) => `<tr><th scope="row">${esc(LABELS[f])}</th>${years.map((y) => `<td>${valueLink(c.cik, y, f)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
  <p class="xsmall secondary xbrl-note">XBRL elements: ${TABLE_FIELDS.map((f) => `${esc(LABELS[f])}: ${f === "pretax" ? "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest (or, where that isn't tagged, …MinorityInterestAndIncomeLossFromEquityMethodInvestments, which leaves out income from equity-method investments)" : f === "revenue" ? "Revenues or RevenueFromContractWithCustomer…" : esc(ELEMENTS[f])}`).join("; ")}.</p>
  <p class="xsmall secondary">Fiscal years: ${years.map((y) => esc(fiscalYear(y))).join("; ")}.</p>`,
    { meta: `${years.length} ${years.length === 1 ? "year" : "years"}` }
  );
  const source = `<p class="hint">From ${esc(c.name)}'s 10-K filings with the SEC (XBRL financial data), loaded weekly; a restated year shows the latest filing's value. ${sourceLink(c.source_url, "The company's 10-K filings")}</p>`;
  return `${head}
${card}
<section class="card stack-sm" id="years"><h2 class="h3">Over the years</h2>${chart || `<p class="small secondary">The chart starts once the 10-K filings tag these values for two fiscal years; ${years.length === 1 ? "one is" : "none are"} tagged so far.</p>`}</section>
${all}
${READING}
${orgFacts(c, orgs)}
${source}`;
}

// ---------------------------------------------------------------------------
// The line on organization panels

/** A placeholder after an organization's name, filled by fillTaxLines() when exactly one company matches it. */
export function taxMarker(name) {
  const n = String(name || "").trim();
  return n.length < 3 ? "" : `<span class="tax-line" data-tax-org="${esc(n)}"></span>`;
}

const MARKER = /<span class="tax-line" data-tax-org="([^"]*)"><\/span>/g;
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The organization names a page's markers carry. */
export function markersIn(html) {
  return [...new Set([...String(html).matchAll(MARKER)].map((m) => unesc(m[1])))];
}

/** {nameKey: company} for names that match exactly one company (or a confirmed link). One or two queries. */
export async function taxInfo(db, names) {
  const keys = [...new Set(names.map(nameKey).filter(Boolean))].slice(0, 200);
  if (!keys.length) return {};
  const ph = keys.map(() => "?").join(",");
  try {
    const [byName, links] = await Promise.all([
      db.prepare(`SELECT cik, name_key, latest_fy, taxes_paid, pretax FROM companies WHERE name_key IN (${ph})`).bind(...keys).all(),
      db.prepare(`SELECT l.org_key, c.cik, c.latest_fy, c.taxes_paid, c.pretax FROM company_org_links l JOIN companies c ON c.cik = l.cik WHERE l.org_key IN (${ph})`).bind(...keys).all(),
    ]);
    const out = {};
    const count = {};
    for (const r of byName.results) count[r.name_key] = (count[r.name_key] || 0) + 1;
    for (const r of byName.results) if (count[r.name_key] === 1) out[r.name_key] = r;
    for (const r of links.results) out[r.org_key] = r;
    return out;
  } catch (err) {
    if (missing(err)) return {};
    throw err;
  }
}

/** "Taxes paid (FY2025): $2.9 billion · pretax income $16.0 billion ›", or nothing. */
export function taxLine(c) {
  if (!c || (num(c.taxes_paid) == null && num(c.pretax) == null)) return "";
  const fy = c.latest_fy ? `FY${c.latest_fy}` : "latest year";
  return `<a class="tax-line tap small" href="${companyHref(c.cik)}">Taxes paid (${esc(fy)}): ${esc(money(c.taxes_paid))} · pretax income ${esc(money(c.pretax))} ›</a>`;
}

/** The page with each marker replaced by its line (or removed). */
export function fillTaxLines(html, info) {
  return String(html).replace(MARKER, (_, n) => {
    const c = info[nameKey(unesc(n))];
    return c ? ` ${taxLine(c)}` : "";
  });
}
