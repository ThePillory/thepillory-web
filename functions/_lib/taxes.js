// Taxes (docs/taxes.md): the Corporations side of /taxes/ and the line on
// organization panels.
//   /taxes/companies/         every company filing a 10-K that tags these values:
//                             search by name or ticker, filter by industry (SIC) and
//                             state, sorted by name, revenue or profit before taxes only
//   /taxes/companies/<cik>/   one company: a lead sentence (profit before taxes, taxes
//                             paid and the share of profit, for the latest year and the
//                             last five), the latest fiscal year, a chart of taxes
//                             paid and profit before taxes by year, the federal / state /
//                             foreign split when filed, every number linked to its
//                             filing, and what ThePillory already has for the same
//                             organization, side by side as facts
//   taxMarker() / fillTaxLines()  "Taxes paid (FY2025): $X · profit before taxes $Y ›" on
//                             donor, lobbying and measure-signer organization panels,
//                             filled in by functions/_middleware.js in one query
// Data: companies, company_tax_years, company_tax_jurisdictions, company_orgs
// (migration 0047; tools/build_company_taxes.py, weekly, from SEC EDGAR XBRL).
// Rules: a value the filing doesn't tag is shown as not reported, never estimated;
// nothing is sorted, ranked, labeled or colored by taxes paid or by any rate (a company's
// own share of profit is shown on its own page only, never in the list or on other
// pages); no comparisons between companies in words; the same layout for every company;
// no person is named. Labels are plain words, each with the filing's own term under it.
import { esc, fmtDate, safeUrl, sourceLink } from "./render.js";
import { pairBars } from "./charts.js";
import { fold } from "./summary.js";
import { STATE_NAME } from "./districts.js";
import { nameKey } from "../awards/index.js";

export const TAXES_METHOD = "/about/methodology/#company-taxes";
export const PER_PAGE = 25;
export const SORTS = { name: "Name", revenue: "Revenue", pretax: "Profit before taxes" };

// Each value in plain words, for readers with no accounting background (used everywhere: the
// page, the chart, Show the numbers, the list and the line on organization panels).
export const LABELS = {
  taxes_paid: "Income taxes actually paid",
  paid_federal: "Paid to the U.S. government",
  paid_state: "Paid to states and cities",
  paid_foreign: "Paid to other countries",
  current_federal: "Federal tax owed on this year's profit",
  current_state: "State and local tax owed on this year's profit",
  deferred: "Tax put off until later years",
  pretax: "Profit before taxes",
  pretax_us: "Profit before taxes, in the U.S.",
  pretax_foreign: "Profit before taxes, outside the U.S.",
  revenue: "Revenue",
};
// The filing's own term for each, shown in small text under the plain label.
export const FILING_TERMS = {
  taxes_paid: "Income taxes paid, net of refunds",
  paid_federal: "Federal income taxes paid, net of refunds",
  paid_state: "State and local income taxes paid, net of refunds",
  paid_foreign: "Foreign income taxes paid, net of refunds",
  current_federal: "Current federal income tax expense (benefit)",
  current_state: "Current state and local income tax expense (benefit)",
  deferred: "Deferred income tax expense (benefit)",
  pretax: "Income (loss) before income taxes",
  pretax_us: "Income (loss) before income taxes, domestic",
  pretax_foreign: "Income (loss) before income taxes, foreign",
  revenue: "Revenues",
};
// One line explaining a value, where it helps.
const OWED = "What the company recorded as due for this year; it can differ from what it paid this year";
export const NOTES = {
  taxes_paid: "Cash sent to tax authorities this year, minus refunds received",
  pretax: "A minus sign means a loss",
  current_federal: OWED,
  current_state: OWED,
  deferred: "Recorded now; paid in a later year, or sometimes not at all",
};
export const RATE_NOTE = "The federal corporate income tax rate is 21%. States add their own, and companies also pay taxes to other countries.";
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
const filingTerm = (field, y) => (field === "pretax" && y && y.pretax_tag === PRETAX_EQUITY ? "Income (loss) before income taxes and equity-method investments" : FILING_TERMS[field]);
/** A value's label: the plain words, then (small, gray) the explanation where there is one and the filing's own term. */
export function labelHtml(field, { y = null, note = true } = {}) {
  return `${esc(LABELS[field])}${note && NOTES[field] ? `<span class="list-meta">${esc(NOTES[field])}</span>` : ""}<span class="list-meta">In the 10-K: ${esc(filingTerm(field, y))}</span>`;
}
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

// ---------------------------------------------------------------------------
// Taxes paid as a share of profit before taxes (not of revenue). Never estimated: a missing value,
// a loss or a net refund gives no percentage, and says why.

export const SHARE_WORDS = { missing: "Not reported", loss: "Not meaningful: loss year", refund: "Not meaningful: net refund", losses: "Not meaningful: a loss over these years" };

/** { pct } (whole percent) or { why: "missing" | "loss" | "refund" }. Pure; tested. */
export function shareOfProfit(paid, pretax) {
  const p = num(paid);
  const b = num(pretax);
  if (p == null || b == null) return { why: "missing" };
  if (b <= 0) return { why: "loss" };
  if (p < 0) return { why: "refund" };
  return { pct: Math.round((p / b) * 100) };
}
export const shareText = (r) => (r.pct != null ? `${r.pct}%` : SHARE_WORDS[r.why]);

/** "fiscal 2021–2025", or the years named when one is missing between them ("fiscal 2021, 2022 and 2024"). */
export function yearsWords(ys) {
  if (!ys.length) return "";
  if (ys.every((y) => y.fy)) {
    const f = ys.map((y) => y.fy);
    if (f.length === 1) return `fiscal ${f[0]}`;
    if (f.every((v, i) => i === 0 || v === f[i - 1] + 1)) return `fiscal ${f[0]}–${f[f.length - 1]}`;
    return `fiscal ${f.slice(0, -1).join(", ")} and ${f[f.length - 1]}`;
  }
  const n = ys.map(fyShort);
  return n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/**
 * The most recent `n` fiscal years with both taxes paid and profit before taxes (fewer if fewer exist):
 * { years, paid, pretax, share } with share from the sums. Null with fewer than two such years. Pure; tested.
 */
export function multiYear(years, n = 5) {
  const both = years.filter((y) => num(y.taxes_paid) != null && num(y.pretax) != null);
  const pick = both.slice(-n);
  if (pick.length < 2) return null;
  const paid = pick.reduce((a, y) => a + y.taxes_paid, 0);
  const pretax = pick.reduce((a, y) => a + y.pretax, 0);
  const share = shareOfProfit(paid, pretax);
  return { years: pick, paid, pretax, share: share.why === "loss" ? { why: "losses" } : share };
}

/**
 * "In fiscal 2025, Example Retail Inc reported $40.0 million in profit before taxes and paid $9.0 million
 * in income taxes: 23% of its profit." Parts not reported are left out; a loss is "a loss of $X"; no
 * percentage without both values, a profit and taxes paid. Pure; tested.
 */
export function leadSentence(name, y) {
  if (!y) return "";
  const p = num(y.taxes_paid);
  const b = num(y.pretax);
  if (p == null && b == null) return "";
  const when = y.fy ? `In fiscal ${y.fy}` : `In the fiscal year ended ${fmtDate(y.period_end)}`;
  const profit = b == null ? "" : b < 0 ? `reported a loss of ${money(-b)} before taxes` : `reported ${money(b)} in profit before taxes`;
  const taxes = p == null ? "" : p < 0 ? `received ${money(-p)} more in income tax refunds than it paid` : `paid ${money(p)} in income taxes`;
  const share = shareOfProfit(p, b);
  return `${when}, ${name} ${[profit, taxes].filter(Boolean).join(" and ")}${share.pct != null ? `: ${share.pct}% of its profit` : ""}.`;
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

// Name, revenue or profit before taxes: the only orders there are (never taxes paid, never a rate).
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
  <p class="small">Taxes paid is cash out the door this year. It doesn't line up exactly with this year's profit: some tax is paid a year early or late, refunds from past years count when they arrive, and some tax is put off to later years. Losses from past years, tax credits and deductions set by law can also lower what's paid in a given year.</p>
  <p class="small">The figures are as each company reports them in its 10-K, shown without conclusions about them. <a class="inline-link" href="${TAXES_METHOD}">How this works</a></p>
</section>`;

const SWITCH = (on) => `<nav class="segmented list-switch" aria-label="Show">${[["taxpayers", "Taxpayers", "/taxes/taxpayers/"], ["wealth", "Wealth", "/taxes/wealth/"], ["companies", "Corporations", "/taxes/companies/"]]
  .map(([k, label, href]) => `<a class="toggle" href="${href}"${k === on ? ' aria-current="true"' : ""}>${label}</a>`)
  .join("")}</nav>`;
export const taxesSwitch = SWITCH;

const meta = (c) => [c.sic_desc ? esc(c.sic_desc) : "", c.state ? esc(STATE_NAME[c.state] || c.state) : ""].filter(Boolean).join(" · ");

/** One company in the list: name and tickers; industry, state, the latest year's revenue and profit before taxes (dollars only, no rates). */
export function companyRow(c) {
  const fy = c.latest_fy ? `FY${c.latest_fy}` : "";
  const facts = [meta(c), num(c.revenue) != null ? `${esc(fy)} revenue ${esc(money(c.revenue))}` : "", num(c.pretax) != null ? `profit before taxes ${esc(money(c.pretax))}` : ""].filter(Boolean).join(" · ");
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

/** The lead: the latest year in one sentence, the last five years' share, and the statutory rate. */
function leadCard(c, years, latest) {
  const sentence = leadSentence(c.name, latest);
  const multi = multiYear(years);
  return `<section class="card stack-sm" id="summary">
  <p class="lead-sentence">${sentence ? esc(sentence) : "This company's 10-K filings don't tag its profit before taxes or the income taxes it paid for its latest fiscal year."}</p>
  ${multi ? `<p class="small">Over ${esc(yearsWords(multi.years))}: ${multi.share.pct != null ? `${multi.share.pct}% of profit` : esc(SHARE_WORDS[multi.share.why])} <span class="secondary">(${esc(money(multi.paid))} in income taxes paid on ${esc(money(multi.pretax))} in profit before taxes)</span></p>` : ""}
  <p class="xsmall secondary">${esc(RATE_NOTE)}</p>
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
  const line = (field, y = latest, opts = {}) => `<div class="kv-row"><dt>${labelHtml(field, { y, ...opts })}</dt><dd>${valueLink(c.cik, y, field)}</dd></div>`;
  const split = ["paid_federal", "paid_state", "paid_foreign"].some((f) => num(latest[f]) != null);
  const jurs = jurisdictions.filter((j) => j.period_end === latest.period_end);
  const elementName = { IncomeTaxPaidFederalAfterRefundReceived: "U.S. government", IncomeTaxPaidStateAndLocalAfterRefundReceived: "state or city", IncomeTaxPaidForeignAfterRefundReceived: "another country", IncomeTaxesPaidNet: "total" };
  const share = shareOfProfit(latest.taxes_paid, latest.pretax);
  const card = `<section class="card stack-sm" id="latest">
  <h2 class="h3">${esc(fiscalYear(latest))}</h2>
  <dl class="kv kv--tight kv--labeled">
    ${line("taxes_paid")}
    ${line("pretax")}
    <div class="kv-row"><dt>Income taxes paid as a share of profit<span class="list-meta">Income taxes actually paid ÷ profit before taxes</span></dt><dd>${esc(shareText(share))}</dd></div>
  </dl>
  ${split ? `<p class="label">Where the taxes went, as the 10-K splits them</p>
  <dl class="kv kv--tight kv--labeled">${line("paid_federal")}${line("paid_state")}${line("paid_foreign")}</dl>` : ""}
  ${jurs.length ? `<p class="label">By place, as filed</p>
  <dl class="kv kv--tight kv--labeled">${jurs.map((j) => `<div class="kv-row"><dt>${esc(j.name)} <span class="secondary">(${esc(elementName[j.element] || "")})</span></dt><dd>${filingUrl(c.cik, j.accn) ? `<a class="inline-link" href="${esc(filingUrl(c.cik, j.accn))}" target="_blank" rel="noopener">${esc(exact(j.amount))}</a>` : esc(exact(j.amount))}</dd></div>`).join("")}</dl>
  <p class="xsmall secondary">Companies list each place that gets 5% or more of their income taxes paid (ASU 2023-09).</p>` : ""}
  <p class="xsmall secondary">Each amount links to the 10-K it's from. "Not reported" means the filing doesn't tag that value; nothing is estimated.</p>
</section>`;
  const chart = pairBars(
    years.map((y) => ({ label: fiscalYear(y), tick: y.fy ? `'${String(y.fy).slice(2)}` : y.period_end.slice(2, 4), a: num(y.taxes_paid), b: num(y.pretax), hrefA: filingUrl(c.cik, srcOf(y).taxes_paid), hrefB: filingUrl(c.cik, srcOf(y).pretax) })),
    { series: [LABELS.taxes_paid, LABELS.pretax], format: exact, head: "Fiscal year", caption: "By fiscal year, as each 10-K reports them. A bar below the line is a loss. A missing bar is a value the filing doesn't tag.", ariaLabel: `${c.name}: income taxes actually paid and profit before taxes by fiscal year` }
  );
  const all = fold(
    "numbers",
    "Show the numbers",
    `<div class="table-scroll"><table class="usage-table tax-table"><thead><tr><th scope="col">Value</th>${years.map((y) => `<th scope="col">${esc(fyShort(y))}</th>`).join("")}</tr></thead><tbody>${TABLE_FIELDS.map((f) => `<tr><th scope="row">${labelHtml(f, { y: latest, note: false })}</th>${years.map((y) => `<td>${valueLink(c.cik, y, f)}</td>`).join("")}</tr>`).join("")}<tr><th scope="row">Income taxes paid as a share of profit<span class="list-meta">Income taxes actually paid ÷ profit before taxes</span></th>${years.map((y) => `<td>${esc(shareText(shareOfProfit(y.taxes_paid, y.pretax)))}</td>`).join("")}</tr></tbody></table></div>
  <p class="xsmall secondary">Fiscal years: ${years.map((y) => esc(fiscalYear(y))).join("; ")}.</p>`,
    { meta: `${years.length} ${years.length === 1 ? "year" : "years"}` }
  );
  const technical = fold(
    "technical",
    "Technical details",
    `<p class="xsmall secondary xbrl-note">The XBRL elements each value is read from (us-gaap): ${TABLE_FIELDS.map((f) => `${esc(LABELS[f])}: ${f === "pretax" ? "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest (or, where that isn't tagged, …MinorityInterestAndIncomeLossFromEquityMethodInvestments, which leaves out income from equity-method investments)" : f === "revenue" ? "Revenues or RevenueFromContractWithCustomer…" : esc(ELEMENTS[f])}`).join("; ")}. Companies' own (extension) elements aren't used.</p>`
  );
  const source = `<p class="hint">From ${esc(c.name)}'s 10-K filings with the SEC (XBRL financial data), loaded weekly; a restated year shows the latest filing's value. ${sourceLink(c.source_url, "The company's 10-K filings")}</p>`;
  return `${head}
${leadCard(c, years, latest)}
${card}
<section class="card stack-sm" id="years"><h2 class="h3">Over the years</h2>${chart || `<p class="small secondary">The chart starts once the 10-K filings tag these values for two fiscal years; ${years.length === 1 ? "one is" : "none are"} tagged so far.</p>`}</section>
${all}
${READING}
${orgFacts(c, orgs)}
${source}
${technical}`;
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

/** "Taxes paid (FY2025): $2.9 billion · profit before taxes $16.0 billion ›" (dollars only, no rate), or nothing. */
export function taxLine(c) {
  if (!c || (num(c.taxes_paid) == null && num(c.pretax) == null)) return "";
  const fy = c.latest_fy ? `FY${c.latest_fy}` : "latest year";
  return `<a class="tax-line tap small" href="${companyHref(c.cik)}">Taxes paid (${esc(fy)}): ${esc(money(c.taxes_paid))} · profit before taxes ${esc(money(c.pretax))} ›</a>`;
}

/** The page with each marker replaced by its line (or removed). */
export function fillTaxLines(html, info) {
  return String(html).replace(MARKER, (_, n) => {
    const c = info[nameKey(unesc(n))];
    return c ? ` ${taxLine(c)}` : "";
  });
}
