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

// ---------------------------------------------------------------------------
// Where the taxes went: the 10-K's own breakdown of taxes paid (ASU 2023-09), every place it lists.

const GROUPS = ["federal", "state", "foreign"];
const GROUP_FIELD = { federal: "paid_federal", state: "paid_state", foreign: "paid_foreign" };
const GROUP_ELEMENT = { IncomeTaxPaidFederalAfterRefundReceived: "federal", IncomeTaxPaidStateAndLocalAfterRefundReceived: "state", IncomeTaxPaidForeignAfterRefundReceived: "foreign" };
export const GROUP_LABEL = { federal: "U.S. government", state: "States", foreign: "Other countries" };
// The standard members of the 10-K's breakdown: the group each belongs to; the first four are a group's total.
const TOTAL_MEMBERS = { "us-gaap:DomesticCountryMember": "federal", "us-gaap:FederalMember": "federal", "country:US": "federal", "us-gaap:StateAndLocalJurisdictionMember": "state", "us-gaap:ForeignCountryMember": "foreign" };
const OTHER_MEMBERS = { "us-gaap:ForeignTaxJurisdictionOtherMember": "foreign" };
const OTHER_LABEL = { state: "Other states", foreign: "Other countries" };
export const SUM_NOTE = "sum of the places listed";
export const GAP_LABEL = "Not broken out in the 10-K";
// When the 10-K's parts add up to more than its own total (its rounding, or a total and parts filed on different bases).
export const OVER_LABEL = "Parts listed in the 10-K exceed its total by";
/** The row for a difference: what the 10-K doesn't break out, or how far its parts go past its total. */
export const gapRow = (amount) => (amount >= 0 ? { label: GAP_LABEL, amount, gap: true } : { label: OVER_LABEL, amount: -amount, gap: true, over: true });

function groupOf(j) {
  const m = String(j.jurisdiction || "");
  if (TOTAL_MEMBERS[m]) return TOTAL_MEMBERS[m];
  if (OTHER_MEMBERS[m]) return OTHER_MEMBERS[m];
  if (m.startsWith("stpr:")) return "state";
  if (m.startsWith("country:")) return "foreign";
  return GROUP_ELEMENT[j.element] || null; // a company's own member: the element says which group
}
const same = (a, b) => Math.abs(a - b) < 1; // whole dollars

/**
 * Taxes paid for one year, by group and place, exactly as the 10-K files them. Each group (U.S. government,
 * states, other countries) is its tagged total, or, when only its places are tagged, their sum (how: "sum").
 * Where a tagged total and its places differ, or the groups and the total taxes paid differ, the difference is
 * a "Not broken out in the 10-K" row: never a silent gap, never an estimate. Pure; tested.
 * -> { groups: {federal, state, foreign: {amount, how, places: [{label, amount, gap?}]} | null}, total, gap, any }
 */
export function taxesTree(y, jurisdictions) {
  const rows = (jurisdictions || []).filter((j) => j.period_end === y.period_end && num(j.amount) != null);
  const groups = {};
  for (const g of GROUPS) {
    const mine = rows.filter((j) => groupOf(j) === g);
    // One amount per place: the group's own element over the total's (IncomeTaxesPaidNet by place).
    const pick = (list) => {
      const best = new Map();
      for (const j of list) if (!best.has(j.jurisdiction) || j.element !== "IncomeTaxesPaidNet") best.set(j.jurisdiction, j);
      return [...best.values()];
    };
    const totals = pick(mine.filter((j) => TOTAL_MEMBERS[j.jurisdiction]));
    const places = pick(mine.filter((j) => !TOTAL_MEMBERS[j.jurisdiction]));
    const listed = places.filter((j) => /^(stpr|country):/.test(j.jurisdiction)).sort((a, b) => b.amount - a.amount);
    const others = places.filter((j) => !/^(stpr|country):/.test(j.jurisdiction));
    const out = [
      ...listed.map((j) => ({ label: j.name, amount: j.amount })),
      ...others.map((j) => ({ label: others.length === 1 && OTHER_LABEL[g] ? OTHER_LABEL[g] : j.name, amount: j.amount })),
    ];
    const sum = out.reduce((t, p) => t + p.amount, 0);
    let amount = num(y[GROUP_FIELD[g]]);
    let how = "tagged";
    if (amount == null && totals.length) amount = totals[0].amount;
    if (amount == null && out.length) {
      amount = sum;
      how = "sum";
    }
    if (amount == null) {
      groups[g] = null;
      continue;
    }
    if (how === "tagged" && out.length && !same(sum, amount)) out.push(gapRow(amount - sum));
    groups[g] = { amount, how, places: out };
  }
  const total = num(y.taxes_paid);
  const known = GROUPS.map((g) => groups[g]).filter(Boolean);
  const parts = known.reduce((t, x) => t + x.amount, 0);
  const gap = total != null && known.length && !same(total, parts) ? total - parts : null;
  return { groups, total, gap, any: known.length > 0 };
}

/**
 * The U.S. figure for the top card: federal plus state and local taxes paid when both are known ("Taxes paid in
 * the U.S."), federal alone when only it is ("Paid to the U.S. government"), otherwise null. Pure; tested.
 */
export function usTaxes(tree) {
  const f = tree.groups.federal;
  const s = tree.groups.state;
  if (f && s) return { label: "Taxes paid in the U.S.", amount: f.amount + s.amount, split: [f, s], sum: s.how === "sum" };
  if (f) return { label: "Paid to the U.S. government", amount: f.amount, split: null };
  return null;
}

/** "on $4.77 billion of U.S. profit · 4%", or the loss; no percent on a loss, a net refund or a missing value. Pure; tested. */
export function profitLine(paid, pretax, where) {
  const b = num(pretax);
  const p = num(paid);
  const refund = p != null && p < 0 ? "More refunded than paid · " : "";
  if (b == null) return refund.replace(/ · $/, "");
  const of = where === "us" ? "U.S." : "total";
  if (b < 0) return `${refund}with a ${where === "us" ? "U.S. " : ""}loss before taxes of ${shortMoney(-b)}`;
  const share = shareOfProfit(p, b);
  return `${refund}on ${shortMoney(b)} of ${of} profit${share.pct != null ? ` · ${share.pct}%` : ""}`;
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
    // Federal awards already looked up for this exact name (read only: a company page never queues a lookup).
    let awards = null;
    try {
      const row = await db.prepare("SELECT result FROM federal_awards_cache WHERE name_key = ?").bind(nameKey(c.name)).first();
      awards = row ? JSON.parse(row.result) : null;
    } catch (err) {
      if (!missing(err) && !(err instanceof SyntaxError)) throw err;
    }
    return { company: c, years: years.results, jurisdictions: jur.results, orgs: orgs.results, awards };
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

// Plain text, the same on every company page and the list.
export const READING_TEXT = "Taxes paid is cash paid this year, after refunds. It won't match this year's profit exactly: some tax is paid a year early or late. Deductions, credits and past losses set by law lower what's paid.";
export const READING = `<p class="small">${esc(READING_TEXT)}</p>`;
export const RATE_LINE = "The federal corporate income tax rate is 21%. States add their own.";
export const LAWS_LINE = "Congress sets the rates, deductions and credits companies pay under. See how your representatives voted on each.";
export const NO_RECORDS = "No PAC, lobbying or ballot measure records under this name.";

/** A card's title: bold, sentence case, body size. */
const title = (t) => `<h2 class="tax-title">${esc(t)}</h2>`;
/** The one source link a card carries. */
const from10k = (href, text = "From the 10-K ›") => (href ? `<p class="small"><a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a></p>` : "");
/** A row: label left, amount right, at most one gray line under the label. */
const amountRow = (label, amount, { meta = "", sub = false } = {}) =>
  `<li class="list-row${sub ? " tax-sub-row" : ""}"><div><span class="list-title">${esc(label)}</span>${meta ? `<span class="list-meta">${esc(meta)}</span>` : ""}</div><span class="list-status" title="${esc(exact(amount))}">${esc(shortMoney(amount))}</span></li>`;

/** The laws that set these taxes: one line each, linked to the bill's page. Empty when the file isn't loaded. */
export function lawsSection(file) {
  const laws = ((file && file.laws) || []).filter((l) => l.bill_id && safeUrl(l.source_url));
  if (!laws.length) return "";
  return `<section class="card stack-sm" id="laws">
  ${title("Laws that set these taxes")}
  <ul class="plain-list tax-rows">${laws.map((l) => `<li><a class="list-row" href="/laws/bills/${esc(l.bill_id)}/"><div><span class="list-title">${esc(l.name)} · ${esc(String(l.year))}</span></div><span class="list-status"><span class="chev" aria-hidden="true">›</span></span></a></li>`).join("")}</ul>
  <p class="small secondary">${esc(LAWS_LINE)}</p>
</section>`;
}

const SWITCH = (on) => `<nav class="segmented list-switch" aria-label="Show">${[["taxpayers", "Taxpayers", "/taxes/taxpayers/"], ["wealth", "Wealth", "/taxes/wealth/"], ["companies", "Corporations", "/taxes/companies/"]]
  .map(([k, label, href]) => `<a class="toggle" href="${href}"${k === on ? ' aria-current="true"' : ""}>${label}</a>`)
  .join("")}</nav>`;
export const taxesSwitch = SWITCH;

const meta = (c) => [c.sic_desc ? esc(c.sic_desc) : "", c.state ? esc(STATE_NAME[c.state] || c.state) : ""].filter(Boolean).join(" · ");

/** One company in the list: name and tickers; one gray line with industry, state, the latest year's revenue and profit before taxes (dollars only, no rates). */
export function companyRow(c) {
  const fy = c.latest_fy ? `FY${c.latest_fy}` : "";
  const facts = [meta(c), num(c.revenue) != null ? `${esc(fy)} revenue ${esc(shortMoney(c.revenue))}` : "", num(c.pretax) != null ? `profit before taxes ${esc(shortMoney(c.pretax))}` : ""].filter(Boolean).join(" · ");
  return `<a class="compact-row" href="${companyHref(c.cik)}">
  <span class="cr-main"><span class="cr-title">${esc(c.name)}${c.tickers ? ` <span class="secondary">(${esc(c.tickers.split(",").join(", "))})</span>` : ""}</span><span class="cr-meta">${facts}</span></span>
  <span class="cr-side"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function listForm(f, inds) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const states = Object.entries(STATE_NAME).sort((a, b) => a[1].localeCompare(b[1]));
  return `<form class="card stack-sm trade-filters" method="get" action="/taxes/companies/">
  <label class="tax-field" for="co-q">Name or ticker</label>
  <div class="lookup-row">
    <input class="input" id="co-q" name="q" type="search" value="${esc(f.q)}" placeholder="A company's name or ticker" autocomplete="off" />
    <button class="btn btn--primary" type="submit">Show</button>
  </div>
  <label class="tax-field" for="co-sic">Industry</label>
  <select class="input" id="co-sic" name="sic" data-autosubmit>${opt("", "Every industry", f.sic)}${inds.map((i) => opt(i.sic, i.sic_desc, f.sic)).join("")}</select>
  <label class="tax-field" for="co-state">State (business address)</label>
  <select class="input" id="co-state" name="state" data-autosubmit>${opt("", "Every state", f.state)}${states.map(([c, n]) => opt(c, n, f.state)).join("")}</select>
  <label class="tax-field" for="co-sort">Order</label>
  <select class="input" id="co-sort" name="sort" data-autosubmit>${Object.entries(SORTS).map(([k, label]) => opt(k, label, f.sort)).join("")}</select>
</form>`;
}

const KINDS = [
  ["pac", "Political action committee", "contributions"],
  ["lobbying", "Federal lobbying", "reports"],
  ["ld203", "Lobbyist contributions (LD-203)", "reports"],
  ["ca-lobbying", "California lobbying", "reports"],
  ["ca-measures", "California ballot measures, 2026", "records"],
];

/** Federal awards already looked up for this exact name (never queued from here): {total, years} or null. */
function awardsFacts(awards) {
  const rec = (awards && awards.recipients) || [];
  const years = rec.flatMap((r) => (r.years || []).filter((y) => num(y.total) != null && y.total !== 0));
  if (!years.length) return null;
  const fys = years.map((y) => y.fy).sort();
  return { total: years.reduce((t, y) => t + y.total, 0), first: fys[0], last: fys[fys.length - 1] };
}

/** Only the records that exist, one row each, linked to the latest filing; one line when there are none. */
function recordsSection(c, orgs, awards) {
  const rows = [];
  for (const [kind, label, unit] of KINDS) {
    for (const o of orgs.filter((x) => x.kind === kind)) {
      let s = {};
      try {
        s = JSON.parse(o.summary || "{}");
      } catch {
        s = {};
      }
      const years = s.first && s.last ? (s.first === s.last ? s.first : `${s.first}–${s.last}`) : "";
      const metaLine = [o.org_name, years, s.count ? `${s.count} ${s.count === 1 ? unit.replace(/s$/, "") : unit}` : "", o.how === "confirmed" ? "linked by a person" : "same name"].filter(Boolean).join(" · ");
      const inner = `<div><span class="list-title">${esc(label)}</span><span class="list-meta">${esc(metaLine)}</span></div><span class="list-status" title="${esc(exact(s.total))}">${esc(shortMoney(s.total))}</span>`;
      rows.push(s.source_url && safeUrl(s.source_url) ? `<li><a class="list-row" href="${esc(s.source_url)}" target="_blank" rel="noopener">${inner}</a></li>` : `<li class="list-row">${inner}</li>`);
    }
  }
  const aw = awardsFacts(awards);
  if (aw) rows.push(`<li><a class="list-row" href="/awards/?name=${encodeURIComponent(c.name)}"><div><span class="list-title">Federal awards</span><span class="list-meta">${esc(`Contracts and grants · fiscal ${aw.first === aw.last ? aw.first : `${aw.first}–${aw.last}`} · USAspending.gov`)}</span></div><span class="list-status" title="${esc(exact(aw.total))}">${esc(shortMoney(aw.total))}</span></a></li>`);
  return `<section class="card stack-sm" id="records">
  ${title("Other records under this name")}
  ${rows.length ? `<ul class="plain-list tax-rows">${rows.join("")}</ul>
  <p class="small secondary">Shown side by side as facts. ThePillory doesn't connect them to the taxes above.</p>` : `<p class="small secondary">${esc(NO_RECORDS)}</p>`}
</section>`;
}

/** The filing a year's figures come from (its taxes paid, else profit before taxes, else any value). */
const yearAccn = (y) => {
  const src = srcOf(y);
  return src.taxes_paid || src.pretax || Object.values(src)[0] || null;
};

/** The top card: the fiscal year, the U.S. figure first, then the total worldwide, then the years together. */
function topCard(c, years, latest, tree) {
  const fig = (label, amount, line, split = "") => `<div class="tax-fig">
    <p>${esc(label)}</p>
    <p class="hero-num"${num(amount) != null ? ` title="${esc(exact(amount))}"` : ""}>${esc(shortMoney(amount))}</p>
    ${line ? `<p>${esc(line)}</p>` : ""}
    ${split ? `<p class="small secondary">${esc(split)}</p>` : ""}
  </div>`;
  const us = usTaxes(tree);
  const usFig = us
    ? fig(us.label, us.amount, profitLine(us.amount, latest.pretax_us, "us"), us.split ? `U.S. government ${shortMoney(us.split[0].amount)} · States ${shortMoney(us.split[1].amount)}${us.sum ? ` (${SUM_NOTE})` : ""}` : "")
    : "";
  const multi = multiYear(years);
  return `<section class="card stack-sm tax-top" id="latest">
  ${title(fyLabel(latest))}
  ${usFig}
  ${fig("Total taxes paid worldwide", latest.taxes_paid, profitLine(latest.taxes_paid, latest.pretax, "total"))}
  ${multi && multi.share.pct != null ? `<p class="small secondary">${esc(yearsShort(multi.years))}: ${multi.share.pct}% of total profit</p>` : ""}
  <p class="small secondary">${esc(RATE_LINE)}</p>
  ${from10k(filingUrl(c.cik, yearAccn(latest)))}
</section>`;
}

/** Where the taxes went: every place the 10-K lists, under its group, adding up to the total. Hidden without a breakdown. */
function placesCard(c, latest, jurisdictions, tree) {
  if (!tree.any) return "";
  const rows = [];
  for (const g of GROUPS) {
    const x = tree.groups[g];
    if (!x) continue;
    rows.push(amountRow(GROUP_LABEL[g], x.amount, { meta: x.how === "sum" ? SUM_NOTE[0].toUpperCase() + SUM_NOTE.slice(1) : "" }));
    for (const p of x.places) rows.push(amountRow(p.label, p.amount, { sub: true }));
  }
  if (tree.gap != null) {
    const g = gapRow(tree.gap);
    rows.push(amountRow(g.label, g.amount));
  }
  if (tree.total != null) rows.push(amountRow("Total", tree.total));
  const accn = (jurisdictions || []).find((j) => j.period_end === latest.period_end && j.accn)?.accn || srcOf(latest).paid_federal || srcOf(latest).paid_state || srcOf(latest).paid_foreign || yearAccn(latest);
  return `<section class="card stack-sm" id="places">
  ${title("Where the taxes went")}
  <ul class="plain-list tax-rows">${rows.join("")}</ul>
  ${from10k(filingUrl(c.cik, accn))}
</section>`;
}

/** Every value by year, exact, newest year first: one block of rows per year (label left, amount right), each year
 * linked to its 10-K (a value from another filing links to that one). Rows, not a wide table: nothing to pan. */
function numbersList(c, years) {
  const row = (label, value) => `<li class="list-row"><div><span class="list-title">${esc(label)}</span></div><span class="list-status">${value}</span></li>`;
  const cell = (y, f) => {
    const v = num(y[f]);
    const accn = srcOf(y)[f];
    if (v == null) return esc(NOT_REPORTED);
    return accn && accn !== yearAccn(y) && filingUrl(c.cik, accn) ? `<a class="inline-link" href="${esc(filingUrl(c.cik, accn))}" target="_blank" rel="noopener">${esc(exact(v))}</a>` : esc(exact(v));
  };
  const share = (y) => {
    const r = shareOfProfit(y.taxes_paid, y.pretax);
    return r.why === "missing" ? "" : row("Taxes as a share of profit", esc(shareText(r)));
  };
  const blocks = [...years].reverse().map((y) => {
    const href = filingUrl(c.cik, yearAccn(y));
    return `<div class="tax-year stack-xs" id="fy-${esc(y.period_end)}">
    <p class="small">${href ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(fiscalYear(y))} ›</a>` : esc(fiscalYear(y))}</p>
    <ul class="plain-list tax-rows">${TABLE_FIELDS.filter((f) => num(y[f]) != null).map((f) => row(LABELS[f], cell(y, f))).join("")}${share(y)}</ul>
  </div>`;
  });
  return `<div class="stack">${blocks.join("")}</div>
  <p class="small secondary">Each year shows the values its 10-K tags; one it doesn't tag is left out, never estimated. Taxes as a share of profit is income taxes actually paid ÷ profit before taxes. Each year links to its 10-K.</p>`;
}

/** Each value's term in the 10-K and its XBRL element, one row each. */
function termsList(latest) {
  const element = (f) => (f === "pretax" ? "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest, or where that isn't tagged …MinorityInterestAndIncomeLossFromEquityMethodInvestments (it leaves out income from equity-method investments)" : f === "revenue" ? "Revenues or RevenueFromContractWithCustomer…" : ELEMENTS[f]);
  return `<ul class="plain-list tax-rows tax-terms">${TABLE_FIELDS.map((f) => `<li class="list-row"><div><span class="list-title">${esc(LABELS[f])}</span><span class="list-meta xbrl-note">In the 10-K: ${esc(filingTerm(f, latest))} · XBRL: ${esc(element(f))}</span></div></li>`).join("")}</ul>`;
}

/** The company page's main content. */
export function companyMain({ company: c, years, jurisdictions, orgs, awards = null, laws = null }) {
  const latest = [...years].reverse().find((y) => num(y.taxes_paid) != null || num(y.pretax) != null) || years[years.length - 1] || null;
  const head = `<header class="page-head">
  <h1>${esc(c.name)}</h1>
  <p class="subtitle small">${[c.tickers ? esc(c.tickers.split(",").join(", ")) : "", meta(c)].filter(Boolean).join(" · ")}</p>
</header>`;
  const about = fold(
    "about",
    "About these numbers",
    `${READING}
  <p class="small">From ${esc(c.name)}'s 10-K filings with the SEC (XBRL financial data), loaded weekly. A restated year shows the latest filing's value. "Not reported" means the filing doesn't tag that value; nothing is estimated. U.S. taxes are federal plus state and local income taxes paid; U.S. profit is income before income taxes, domestic. ${sourceLink(c.source_url, "The company's 10-K filings")}</p>
  ${termsList(latest)}
  <p class="small secondary">Where the taxes went is the 10-K's own breakdown of taxes paid (IncomeTaxAuthorityAxis): every place it lists, including its "other" groups. A group whose total isn't tagged shows the ${SUM_NOTE}. Companies' own (extension) elements aren't used for amounts. <a class="inline-link" href="${TAXES_METHOD}">How this works ›</a></p>`
  );
  if (!latest) {
    return `<div class="tax-page">${head}<section class="card"><p class="small secondary">No fiscal year with these values is tagged in this company's 10-K filings yet.</p></section>${lawsSection(laws)}${about}</div>`;
  }
  const tree = taxesTree(latest, jurisdictions);
  const table = numbersList(c, years);
  const chart = pairBars(
    years.map((y) => ({ label: fiscalYear(y), tick: y.fy ? `'${String(y.fy).slice(2)}` : y.period_end.slice(2, 4), a: num(y.taxes_paid), b: num(y.pretax) })),
    { series: ["Taxes paid", LABELS.pretax], format: exact, caption: "A bar below the line is a loss.", table, ariaLabel: `${c.name}: income taxes actually paid and profit before taxes by fiscal year` }
  );
  return `<div class="tax-page">${head}
${topCard(c, years, latest, tree)}
${placesCard(c, latest, jurisdictions, tree)}
<section class="card stack-sm" id="years">${title("Over the years")}${chart || `<details class="mini-bars-table"><summary>Show the numbers</summary>${table}</details>`}</section>
${lawsSection(laws)}
${recordsSection(c, orgs, awards)}
${about}</div>`;
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
