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

/** "$1.23 billion", "$28 million", "−$7.4 million", "$850,000": three significant figures. */
export function shortMoney(n) {
  const v = num(n);
  if (v == null) return NOT_REPORTED;
  const sign = v < 0 ? "−" : "";
  let a = Math.abs(v);
  const units = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]];
  for (let i = 0; i < units.length; i++) {
    const [size, word] = units[i];
    if (a < size) continue;
    const x = Number((a / size).toPrecision(3));
    if (x >= 1000 && i > 0) return `${sign}$${Number((a / units[i - 1][0]).toPrecision(3))} ${units[i - 1][1]}`;
    return `${sign}$${x} ${word}`;
  }
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}

/**
 * The U.S. line: federal income taxes paid on U.S. profit before taxes, with the percent only when
 * both are tagged, the profit is above zero and the taxes aren't a net refund. "" when neither is tagged.
 * Pure; tested.
 */
export function usLine(y) {
  const pf = num(y && y.paid_federal);
  const pu = num(y && y.pretax_us);
  if (pf == null && pu == null) return "";
  const taxes = pf == null ? "" : pf < 0 ? `received ${shortMoney(-pf)} more in refunds than it paid` : shortMoney(pf);
  if (pu == null) return `U.S. taxes: ${taxes}`;
  if (pf == null) return pu < 0 ? `U.S. loss before taxes: ${shortMoney(-pu)}` : `U.S. profit before taxes: ${shortMoney(pu)}`;
  if (pu < 0) return `U.S. taxes: ${taxes}, with a U.S. loss before taxes of ${shortMoney(-pu)}`;
  const share = shareOfProfit(pf, pu);
  return `U.S. taxes: ${taxes} on ${shortMoney(pu)} of U.S. profit${share.pct != null ? ` (${share.pct}%)` : ""}`;
}

/**
 * Where the taxes went, one row each, only rows with a value: the U.S. government, then each state, then
 * each country (the places of 5% or more the 10-K lists). Where the 10-K lists no places for states or
 * other countries but tags the total, that total is one row. Pure; tested.
 */
export function placeRows(y, jurisdictions) {
  const best = new Map();
  const rank = { IncomeTaxPaidFederalAfterRefundReceived: 0, IncomeTaxPaidStateAndLocalAfterRefundReceived: 0, IncomeTaxPaidForeignAfterRefundReceived: 0, IncomeTaxesPaidNet: 1 };
  for (const j of jurisdictions || []) {
    if (j.period_end !== y.period_end || num(j.amount) == null) continue;
    const prev = best.get(j.jurisdiction);
    if (!prev || (rank[j.element] ?? 2) < (rank[prev.element] ?? 2)) best.set(j.jurisdiction, j);
  }
  const all = [...best.values()];
  const states = all.filter((j) => j.jurisdiction.startsWith("stpr:")).sort((a, b) => b.amount - a.amount);
  const countries = all.filter((j) => j.jurisdiction.startsWith("country:") && j.jurisdiction !== "country:US").sort((a, b) => b.amount - a.amount);
  const rows = [];
  if (num(y.paid_federal) != null) rows.push({ label: "U.S. government", field: "paid_federal", amount: y.paid_federal });
  if (states.length) rows.push(...states.map((j) => ({ label: j.name, amount: j.amount, accn: j.accn })));
  else if (num(y.paid_state) != null) rows.push({ label: "States and cities", field: "paid_state", amount: y.paid_state });
  if (countries.length) rows.push(...countries.map((j) => ({ label: j.name, amount: j.amount, accn: j.accn })));
  else if (num(y.paid_foreign) != null) rows.push({ label: "Other countries", field: "paid_foreign", amount: y.paid_foreign });
  return { rows, places: states.length + countries.length > 0 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (iso) => (iso ? `${MONTHS[parseInt(iso.slice(5, 7), 10) - 1]} ${iso.slice(0, 4)}` : "");
/** "Fiscal year 2025 (Feb 2025 – Jan 2026)": the year as the company names it, with its months. */
export function fiscalYear(y) {
  const name = y.fy ? `Fiscal year ${y.fy}` : `Fiscal year ended ${fmtDate(y.period_end)}`;
  return y.period_start ? `${name} (${month(y.period_start)} – ${month(y.period_end)})` : name;
}
export const fyShort = (y) => (y.fy ? `FY${y.fy}` : `FY ending ${month(y.period_end)}`);
/** "FY2025 (Jan–Dec 2025)", "FY2025 (Feb 2025–Jan 2026)". */
export function fyLabel(y) {
  if (!y.period_start) return fyShort(y);
  const [s, e] = [y.period_start, y.period_end];
  const m = (iso) => MONTHS[parseInt(iso.slice(5, 7), 10) - 1];
  return `${fyShort(y)} (${s.slice(0, 4) === e.slice(0, 4) ? `${m(s)}–${m(e)} ${e.slice(0, 4)}` : `${m(s)} ${s.slice(0, 4)}–${m(e)} ${e.slice(0, 4)}`})`;
}
/** "2021–2025", or the years named when one is missing between them. */
const yearsShort = (ys) => yearsWords(ys).replace(/^fiscal /, "");

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
const valueLink = (cik, y, field, { short = false } = {}) => {
  const v = num(y[field]);
  const href = v == null ? null : filingUrl(cik, srcOf(y)[field]);
  const text = v == null ? NOT_REPORTED : short ? shortMoney(v) : exact(v);
  return href ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener"${short ? ` title="${esc(exact(v))}"` : ""}>${esc(text)}</a>` : esc(text);
};
/** An amount on its own (a place's taxes): short, the exact figure in the link's title. */
const amountLink = (cik, accn, amount) => {
  const href = filingUrl(cik, accn);
  return href ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(exact(amount))}">${esc(shortMoney(amount))}</a>` : esc(shortMoney(amount));
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

/** The hand-kept list of laws (data/taxes/corporate-tax-laws.json), read from the site's own files; null if it can't be. */
export async function loadLaws(env, request) {
  if (!env || !env.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new URL("/data/taxes/corporate-tax-laws.json", request.url));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pages

export const READING = `<section class="card stack-sm" id="reading">
  <h2 class="h3">Reading these numbers</h2>
  <p class="small">Taxes paid is cash paid this year, after refunds. It won't match this year's profit exactly: some tax is paid a year early or late. Deductions, credits and past losses set by law lower what's paid.</p>
  <p class="small"><a class="inline-link" href="${TAXES_METHOD}">How this works ›</a></p>
</section>`;

export const LAWS_LINE = "Congress sets the rates, deductions and credits that decide how much income tax companies owe. See how your representatives voted on each law.";

/** The laws that set these taxes (data/taxes/corporate-tax-laws.json), the same on every company page and the list. */
export function lawsSection(file) {
  const laws = (file && file.laws) || [];
  const items = laws
    .filter((l) => l.bill_id && safeUrl(l.source_url))
    .map(
      (l) => `<li class="law-item stack-xs">
    <a class="list-row" href="/laws/bills/${esc(l.bill_id)}/"><div><div class="list-title">${esc(l.name)}</div><div class="list-meta">Public Law ${esc(l.public_law)} · ${esc(String(l.year))} · ${esc(l.bill_label)}, ${esc(String(l.congress))}th Congress</div></div><span class="list-status">Votes ›</span></a>
    <p class="xsmall secondary">Official title: ${esc(l.official_title)}</p>
    ${l.description ? `<p class="small">“${esc(l.description)}” <span class="secondary">${esc(l.description_source)}.</span> ${sourceLink(l.source_url, "Congress.gov")}</p>` : ""}
  </li>`
    );
  return `<section class="card stack-sm" id="laws">
  <h2 class="h3">The laws that set these taxes</h2>
  <p class="small">${esc(LAWS_LINE)}</p>
  ${items.length ? `<ul class="plain-list stack-sm">${items.join("")}</ul>` : `<p class="small secondary">The list of laws isn't loaded right now.</p>`}
  <p class="xsmall secondary">${esc((file && file.note) || "Official titles and summaries from Congress.gov.")}</p>
</section>`;
}

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

/** The top card: the latest year, short and big. */
function topCard(c, years, latest) {
  const p = num(latest.taxes_paid);
  const b = num(latest.pretax);
  const paid = p == null ? `Income taxes paid: ${NOT_REPORTED}` : p < 0 ? `Received ${valueLink(c.cik, { ...latest, taxes_paid: -p }, "taxes_paid", { short: true })} more in income tax refunds than it paid` : `Paid ${valueLink(c.cik, latest, "taxes_paid", { short: true })} in income taxes`;
  const share = shareOfProfit(p, b);
  const profit = b == null ? `Profit before taxes: ${NOT_REPORTED}` : b < 0 ? `Loss before taxes: ${valueLink(c.cik, { ...latest, pretax: -b }, "pretax", { short: true })}` : `Profit before taxes: ${valueLink(c.cik, latest, "pretax", { short: true })}`;
  const multi = multiYear(years);
  return `<section class="card stack-sm tax-top" id="latest">
  <p class="label">${esc(fyLabel(latest))}</p>
  <p class="tax-big">${paid}</p>
  <p class="tax-sub">${profit}${share.pct != null ? ` · Taxes were ${share.pct}% of profit` : ""}</p>
  ${multi && multi.share.pct != null ? `<p class="small secondary">${esc(yearsShort(multi.years))}: ${multi.share.pct}% of profit</p>` : ""}
</section>`;
}

/** The U.S. line, where the profit was made and where the taxes went: only what the 10-K tags. */
function placesCard(c, latest, jurisdictions) {
  const us = usLine(latest);
  const pu = num(latest.pretax_us);
  const pf = num(latest.pretax_foreign);
  const where = [pu != null ? `U.S. ${valueLink(c.cik, latest, "pretax_us", { short: true })}` : "", pf != null ? `Outside the U.S. ${valueLink(c.cik, latest, "pretax_foreign", { short: true })}` : ""].filter(Boolean).join(" · ");
  const { rows, places } = placeRows(latest, jurisdictions);
  if (!us && !where && !rows.length) return "";
  const row = (r) => `<div class="kv-row"><dt>${esc(r.label)}</dt><dd>${r.field ? valueLink(c.cik, latest, r.field, { short: true }) : amountLink(c.cik, r.accn, r.amount)}</dd></div>`;
  return `<section class="card stack-sm" id="places">
  ${us ? `<p class="tax-us">${esc(us)}</p>` : ""}
  ${where ? `<p class="label">Where the profit was made</p><p class="small">${where}</p>` : ""}
  ${rows.length ? `<p class="label">Where the taxes went</p>
  <dl class="kv kv--tight kv--amounts">${rows.map(row).join("")}</dl>
  ${places ? `<p class="xsmall secondary">Places getting 5% or more, as listed in the 10-K.</p>` : ""}` : ""}
</section>`;
}

/** The company page's main content. */
export function companyMain({ company: c, years, jurisdictions, orgs, laws = null }) {
  const latest = [...years].reverse().find((y) => num(y.taxes_paid) != null || num(y.pretax) != null) || years[years.length - 1] || null;
  const head = `<header class="page-head">
  <p class="label">Corporation · SEC filer</p>
  <h1>${esc(c.name)}</h1>
  <p class="subtitle">${[c.tickers ? esc(c.tickers.split(",").join(", ")) : "", meta(c)].filter(Boolean).join(" · ")}</p>
</header>`;
  if (!latest) {
    return `${head}<section class="card"><p class="small secondary">No fiscal year with these values is tagged in this company's 10-K filings yet.</p></section>${lawsSection(laws)}${READING}`;
  }
  const chart = pairBars(
    years.map((y) => ({ label: fiscalYear(y), tick: y.fy ? `'${String(y.fy).slice(2)}` : y.period_end.slice(2, 4), a: num(y.taxes_paid), b: num(y.pretax), hrefA: filingUrl(c.cik, srcOf(y).taxes_paid), hrefB: filingUrl(c.cik, srcOf(y).pretax) })),
    { series: [LABELS.taxes_paid, LABELS.pretax], format: exact, head: "Fiscal year", caption: "By fiscal year, as each 10-K reports them. A bar below the line is a loss. A missing bar is a value the filing doesn't tag.", ariaLabel: `${c.name}: income taxes actually paid and profit before taxes by fiscal year` }
  );
  const all = fold(
    "numbers",
    "Show the numbers",
    `<div class="table-scroll"><table class="usage-table tax-table"><thead><tr><th scope="col">Value</th>${years.map((y) => `<th scope="col">${esc(fyShort(y))}</th>`).join("")}</tr></thead><tbody>${TABLE_FIELDS.map((f) => `<tr><th scope="row">${esc(LABELS[f])}</th>${years.map((y) => `<td>${valueLink(c.cik, y, f)}</td>`).join("")}</tr>`).join("")}<tr><th scope="row">Taxes as a share of profit</th>${years.map((y) => `<td>${esc(shareText(shareOfProfit(y.taxes_paid, y.pretax)))}</td>`).join("")}</tr></tbody></table></div>
  <p class="xsmall secondary">Taxes as a share of profit is income taxes actually paid ÷ profit before taxes. Fiscal years: ${years.map((y) => esc(fiscalYear(y))).join("; ")}.</p>`,
    { meta: `${years.length} ${years.length === 1 ? "year" : "years"}` }
  );
  const technical = fold(
    "technical",
    "Technical details",
    `<div class="table-scroll"><table class="usage-table tax-terms"><thead><tr><th scope="col">On this page</th><th scope="col">In the 10-K</th><th scope="col">XBRL element (us-gaap)</th></tr></thead><tbody>${TABLE_FIELDS.map((f) => `<tr><th scope="row">${esc(LABELS[f])}</th><td>${esc(filingTerm(f, latest))}</td><td class="xbrl-note">${f === "pretax" ? "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest, or where that isn't tagged …MinorityInterestAndIncomeLossFromEquityMethodInvestments (it leaves out income from equity-method investments)" : f === "revenue" ? "Revenues or RevenueFromContractWithCustomer…" : esc(ELEMENTS[f])}</td></tr>`).join("")}</tbody></table></div>
  <p class="xsmall secondary">U.S. taxes on this page are federal income taxes paid; U.S. profit is income before income taxes, domestic. Companies' own (extension) elements aren't used.</p>`
  );
  const source = `<p class="hint">From ${esc(c.name)}'s 10-K filings with the SEC (XBRL financial data), loaded weekly; a restated year shows the latest filing's value. Each amount links to the 10-K it's from; "Not reported" means the filing doesn't tag that value, and nothing is estimated. ${sourceLink(c.source_url, "The company's 10-K filings")}</p>`;
  return `${head}
${topCard(c, years, latest)}
${placesCard(c, latest, jurisdictions)}
<section class="card stack-sm" id="years"><h2 class="h3">Over the years</h2>${chart || `<p class="small secondary">The chart starts once the 10-K filings tag these values for two fiscal years; ${years.length === 1 ? "one is" : "none are"} tagged so far.</p>`}</section>
${lawsSection(laws)}
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
