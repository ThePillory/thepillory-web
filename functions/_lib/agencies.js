// Federal agencies (docs/agencies.md; migration 0052, loaded by tools/load_agencies.py):
// /agencies/ and /agencies/<slug>/. Facts only: each number with its fiscal year, what it counts
// and its source; reports in their own titles; the same sections in the same order for every
// agency, each hidden when empty. No grades, rankings across agencies, or good/bad colors.
import { esc, safeUrl } from "./render.js";
import { shortMoney, exact } from "./taxes.js";
import { pairBars } from "./charts.js";
import { fold } from "./summary.js";

export const PER_PAGE = 25;
export const METHOD = "/about/methodology/#agencies";
export const USAS_HOME = "https://www.usaspending.gov/agency";
export const NOT_LOADED = "Agencies load weekly from the Federal Register, OPM, USAspending.gov and GAO; none are loaded yet.";
export const KIND_HEAD = { department: "Executive departments", independent: "Independent agencies and other offices" };
export const INDEPENDENT_NOTE = "Every agency the Federal Register lists that isn't part of an executive department.";
export const TERMS = {
  resources: "Total budgetary resources: what the agency could spend in the year (new funding plus balances carried over), as USAspending.gov reports it.",
  obligations: "Obligations: what the agency committed to spend (contracts signed, grants awarded, salaries owed).",
  outlays: "Outlays: what the agency paid out during the year.",
};
export const RECIPIENT_NOTE = "Organizations only: people who receive awards aren't listed. Names as USAspending.gov lists them.";
export const REPORTS_NOTE = "Listed in their own titles, newest first. GAO reports naming the agency by its full name.";

const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const date = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
export const agencyHref = (id) => `/agencies/${encodeURIComponent(id)}/`;
const ext = (url, text, cls = "inline-link") => (safeUrl(url) ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${text}</a>` : text);
const card = (id, title, inner, foot = "") => `<section class="card stack-sm agency-card" id="${esc(id)}"><h2 class="tax-title">${esc(title)}</h2>${inner}${foot ? `<p class="small secondary">${foot}</p>` : ""}</section>`;
const row = (label, meta, status, href, external = false) => {
  const inner = `<div><span class="list-title">${label}</span>${meta ? `<span class="list-meta">${meta}</span>` : ""}</div>${status ? `<span class="list-status">${status}</span>` : ""}`;
  if (!href) return `<li class="list-row">${inner}</li>`;
  return `<li><a class="list-row" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ""}>${inner}</a></li>`;
};
const list = (rows) => `<ul class="plain-list tax-rows">${rows.join("")}</ul>`;
const amount = (n) => `<span title="${esc(exact(n))}">${esc(shortMoney(n))}</span>`;

/** The fiscal year that ended most recently (the federal year ends September 30). Pure. */
export function lastCompleteFy(now = new Date()) {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ---------------------------------------------------------------------------
// Loading

export async function loadIndex(db, { q = "", offset = 0 } = {}, fy = lastCompleteFy()) {
  const outlay = "(SELECT outlays FROM agency_money m WHERE m.agency_id = a.id AND m.fy = ?)";
  const cols = `a.id, a.name, a.short_name, a.parent_id, a.kind, ${outlay} AS outlays`;
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const r = await db
      .prepare(`SELECT ${cols}, p.name AS parent_name FROM agencies a LEFT JOIN agencies p ON p.id = a.parent_id WHERE a.name LIKE ? ESCAPE '\\' OR a.short_name LIKE ? ESCAPE '\\' ORDER BY a.name LIMIT ? OFFSET ?`)
      .bind(fy, like, like, PER_PAGE + 1, offset)
      .all();
    return { fy, q, offset, search: r.results.slice(0, PER_PAGE), more: r.results.length > PER_PAGE };
  }
  const [deps, subs, ind] = await Promise.all([
    db.prepare(`SELECT ${cols} FROM agencies a WHERE a.kind = 'department' ORDER BY a.name`).bind(fy).all(),
    offset ? { results: [] } : db.prepare(`SELECT ${cols} FROM agencies a WHERE a.parent_id IN (SELECT id FROM agencies WHERE kind = 'department') ORDER BY a.parent_id, a.name`).bind(fy).all(),
    db.prepare(`SELECT ${cols} FROM agencies a WHERE a.kind = 'independent' ORDER BY a.name LIMIT ? OFFSET ?`).bind(fy, PER_PAGE + 1, offset).all(),
  ]);
  return { fy, q, offset, departments: deps.results, subs: subs.results, independent: ind.results.slice(0, PER_PAGE), more: ind.results.length > PER_PAGE };
}

export async function loadAgency(db, id) {
  const a = await db.prepare("SELECT a.*, p.name AS parent_name FROM agencies a LEFT JOIN agencies p ON p.id = a.parent_id WHERE a.id = ?").bind(id).first();
  if (!a) return null;
  const q = (sql, ...b) => db.prepare(sql).bind(...b).all().then((r) => r.results);
  const [children, leaders, money, parts, recipients, workforce, reports, ruleCounts, rules, bills] = await Promise.all([
    q("SELECT id, name, short_name FROM agencies WHERE parent_id = ? ORDER BY name", id),
    q(`SELECT l.*, o.slug AS official_slug, v.source_url AS vote_url, v.vote_date FROM agency_leaders l
       LEFT JOIN officials o ON o.id = l.official_id LEFT JOIN votes v ON v.id = l.vote_id
       WHERE l.agency_id = ? ORDER BY l.organization, l.position, l.status, l.name`, id),
    q("SELECT fy, resources, obligations, outlays, source_url FROM agency_money WHERE agency_id = ? ORDER BY fy", id),
    q("SELECT fy, kind, name, parent, obligations, outlays FROM agency_money_parts WHERE agency_id = ? AND fy = (SELECT MAX(fy) FROM agency_money_parts WHERE agency_id = ? AND fy <= ?)", id, id, lastCompleteFy()),
    q("SELECT fy, award, rank, name, amount FROM agency_recipients WHERE agency_id = ? AND fy = (SELECT MAX(fy) FROM agency_recipients WHERE agency_id = ? AND fy <= ?) ORDER BY award, rank", id, id, lastCompleteFy()),
    q("SELECT year, employees, source_url FROM agency_workforce WHERE agency_id = ? ORDER BY year DESC", id),
    q("SELECT source, number, title, published_on, url FROM agency_reports WHERE agency_id = ? ORDER BY published_on DESC LIMIT 20", id),
    q("SELECT year, rules FROM agency_rule_counts WHERE agency_id = ? ORDER BY year DESC", id),
    q("SELECT document_number, title, published_on, url FROM agency_rules WHERE agency_id = ? ORDER BY published_on DESC LIMIT 10", id),
    q(`SELECT b.bill_id, b.subcommittee, l.bill_number, l.title, l.final_result, l.final_chamber, l.last_final, l.yea, l.nay
       FROM agency_bills b JOIN bill_list l ON l.bill_id = b.bill_id WHERE b.agency_id = ? ORDER BY l.last_vote DESC LIMIT 20`, id),
  ]);
  return { agency: a, children, leaders, money, parts, recipients, workforce, reports, ruleCounts, rules, bills };
}

// ---------------------------------------------------------------------------
// The index

export function agencyRow(a, fy) {
  const meta = [a.short_name, a.parent_name ? `Part of the ${a.parent_name}` : "", num(a.outlays) != null ? `FY${fy} outlays ${shortMoney(a.outlays)}` : ""].filter(Boolean).map(esc).join(" · ");
  return `<a class="compact-row" href="${agencyHref(a.id)}"><span class="cr-main"><span class="cr-title">${esc(a.name)}</span>${meta ? `<span class="cr-meta">${meta}</span>` : ""}</span><span class="cr-side"><span class="chev" aria-hidden="true">›</span></span></a>`;
}

export function searchForm(q = "") {
  return `<form class="card stack-sm" method="get" action="/agencies/" role="search">
  <label class="tax-field" for="agency-q">Find an agency</label>
  <div class="lookup-row"><input class="input" id="agency-q" name="q" type="search" value="${esc(q)}" placeholder="A name, like Forest Service" autocomplete="off" /><button class="btn" type="submit">Search</button></div>
</form>`;
}

const moreLink = (href, id) => `<a class="btn btn--block load-more" href="${esc(href)}" data-load-more="${id}">Load more</a>`;

export function indexMain(data) {
  if (!data || (!data.q && !data.departments.length && !data.independent.length)) {
    return `<header class="page-head"><h1>Agencies</h1></header>${searchForm()}<section class="card"><p class="secondary">${esc(NOT_LOADED)}</p></section>`;
  }
  const head = `<header class="page-head"><h1>Agencies</h1><p class="subtitle">Federal departments and agencies: who leads them, what they're given and spend, the people who work there, and the reports and rules that name them.</p></header>`;
  if (data.q) {
    const rows = data.search.length ? data.search.map((a) => agencyRow(a, data.fy)).join("") : `<p class="secondary small cr-empty">No agency's name matches "${esc(data.q)}".</p>`;
    const more = data.more ? moreLink(`/agencies/?q=${encodeURIComponent(data.q)}&offset=${data.offset + PER_PAGE}`, "agency-results") : "";
    return `${head}${searchForm(data.q)}<section class="card compact-list" id="agency-results" data-more-list>${rows}</section>${more}`;
  }
  const ind = `<section class="card compact-list" id="agency-independent" data-more-list>${data.independent.map((a) => agencyRow(a, data.fy)).join("")}</section>${data.more ? moreLink(`/agencies/?offset=${data.offset + PER_PAGE}`, "agency-independent") : ""}`;
  if (data.offset) return `<header class="page-head"><h1>${esc(KIND_HEAD.independent)}</h1><p class="subtitle">From number ${data.offset + 1}.</p></header>${ind}`;
  const deps = data.departments
    .map((d) => {
      const subs = data.subs.filter((s) => s.parent_id === d.id);
      return `<section class="card compact-list agency-dept">${agencyRow(d, data.fy)}${subs.length ? `<details class="agency-subs"><summary class="small">${subs.length} sub-agenc${subs.length === 1 ? "y" : "ies"}</summary>${subs.map((s) => agencyRow(s, data.fy)).join("")}</details>` : ""}</section>`;
    })
    .join("");
  return `${head}${searchForm()}
<div class="section-head"><h2>${esc(KIND_HEAD.department)}</h2></div>${deps}
<div class="section-head"><h2>${esc(KIND_HEAD.independent)}</h2></div><p class="small secondary">${esc(INDEPENDENT_NOTE)}</p>${ind}
<p class="small secondary">From the Federal Register's list of agencies. <a class="inline-link" href="${METHOD}">How this works ›</a></p>`;
}

// ---------------------------------------------------------------------------
// One agency

export function whatItIs(a) {
  const desc = a.description ? String(a.description).split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("") : "";
  const links = [ext(a.source_url, "Federal Register"), a.website ? ext(a.website, "The agency's website") : ""].filter(Boolean).join(" · ");
  if (!desc && !a.website) return "";
  return card("about", "What it is", `${desc ? `<blockquote class="quote agency-desc">${desc}</blockquote><p class="small secondary">In its own words, from the Federal Register.</p>` : ""}`, links);
}

export function confirmLine(l) {
  if (l.appointment !== "PAS") return l.placement ? `${esc(l.placement)}, as OPM lists it` : "";
  if (l.vote_id) return `Confirmed by the Senate${l.vote_date ? `, ${esc(date(l.vote_date))}` : ""} · ${ext(l.vote_url, "roll call vote")}`;
  if (l.confirm_note) return `${esc(String(l.confirm_note).replace(/\.$/, ""))}${l.confirmed_on ? `, ${esc(date(l.confirmed_on))}` : ""}`;
  return "";
}

export function leadership(leaders, agency) {
  if (!leaders.length) return "";
  const rows = leaders.map((l) => {
    const org = l.organization && l.organization.toLowerCase() !== String(agency.name).toLowerCase() && !/department of/i.test(l.organization) ? l.organization : "";
    const who = l.status === "Vacant" ? "Vacant" : esc(l.name);
    const meta = [org ? esc(org) : "", l.since && l.status !== "Vacant" ? `Since ${esc(date(l.since))}` : "", confirmLine(l)].filter(Boolean).join(" · ");
    const label = `${esc(l.position)}`;
    return row(label, meta, l.official_slug ? `${who} <span class="chev" aria-hidden="true">›</span>` : who, l.official_slug ? `/reps/${encodeURIComponent(l.official_slug)}/` : "");
  });
  return card("leadership", "Leadership", list(rows), `Senate-confirmed positions and who holds them, as OPM's PLUM data lists them; "Vacant" as listed. ${ext("https://www.opm.gov/about-us/open-government/plum-reporting/plum-data/", "OPM PLUM data")}`);
}

export function moneySection(money, parts, recipients, agency, fy = lastCompleteFy()) {
  const years = money.filter((m) => num(m.outlays) != null || num(m.resources) != null);
  if (!years.length && !parts.length && !recipients.length) return "";
  const done = years.filter((m) => m.fy <= fy);
  const latest = done[done.length - 1] || years[years.length - 1];
  const open = latest && latest.fy > fy;
  const big = latest && num(latest.outlays) != null
    ? `<div class="tax-fig"><p class="hero-num" title="${esc(exact(latest.outlays))}">${esc(shortMoney(latest.outlays))}</p><p class="small secondary">Outlays in fiscal year ${latest.fy}${open ? " so far" : ""} (October ${latest.fy - 1} to September ${latest.fy}), from ${ext(latest.source_url, "USAspending.gov")}.</p></div>`
    : "";
  const table = `<div class="table-scroll"><table><thead><tr><th scope="col">Fiscal year</th><th scope="col">Total budgetary resources</th><th scope="col">Obligations</th><th scope="col">Outlays</th></tr></thead><tbody>${years
    .map((m) => `<tr><th scope="row">${ext(m.source_url, `FY${m.fy}`)}</th><td>${esc(exact(m.resources))}</td><td>${esc(exact(m.obligations))}</td><td>${esc(exact(m.outlays))}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const chart = pairBars(
    years.map((m) => ({ label: `FY${m.fy}`, tick: `’${String(m.fy).slice(2)}`, a: m.resources, b: m.outlays })),
    { series: ["Total budgetary resources", "Outlays"], format: shortMoney, ariaLabel: `${agency.name}: total budgetary resources and outlays by fiscal year`, caption: `By fiscal year since ${years[0] ? years[0].fy : 2017}, from USAspending.gov.`, table }
  );
  const pfy = parts[0] && parts[0].fy;
  const byObligation = (a, b) => (num(b.obligations) || 0) - (num(a.obligations) || 0);
  const oc = parts.filter((p) => p.kind === "object_class").sort(byObligation);
  const fn = parts.filter((p) => p.kind === "function").sort(byObligation);
  const partRows = (rows) => list(rows.map((p) => row(esc(p.name), p.parent ? esc(p.parent) : "", amount(p.obligations))));
  const what = oc.length ? fold("money-what", "What it went to", `${partRows(oc)}<p class="small secondary">Obligations in fiscal year ${pfy}, by object class (what was bought: pay, contracts, grants…), from USAspending.gov.</p>`, { meta: `FY${pfy}` }) : "";
  const forWhat = fn.length ? fold("money-function", "What it was for", `${partRows(fn)}<p class="small secondary">Obligations in fiscal year ${pfy}, by budget function and subfunction, from USAspending.gov.</p>`, { meta: `FY${pfy}` }) : "";
  const rfy = recipients[0] && recipients[0].fy;
  const rec = (award, title) => {
    const r = recipients.filter((x) => x.award === award);
    return r.length ? `<h3 class="small"><b>${title}</b></h3>${list(r.map((x) => row(esc(x.name), "", amount(x.amount))))}` : "";
  };
  const who = recipients.length ? fold("money-recipients", "Largest recipients", `${rec("contracts", "Contracts")}${rec("grants", "Grants")}<p class="small secondary">The 10 largest recipients of the agency's contracts and of its grants in fiscal year ${rfy}, by amount awarded, from USAspending.gov. ${esc(RECIPIENT_NOTE)}</p>`, { meta: `FY${rfy}` }) : "";
  const terms = `<p class="small secondary">${esc(TERMS.resources)} ${esc(TERMS.obligations)} ${esc(TERMS.outlays)}</p>`;
  return card("money", "Money", `${big}${chart}${terms}${what}${forWhat}${who}`, agency.usas_code ? ext(`${USAS_HOME}/${agency.usas_code}`, "This agency on USAspending.gov") : "");
}

export function workforceSection(rows) {
  if (!rows.length) return "";
  const latest = rows[0];
  const big = `<div class="tax-fig"><p class="hero-num">${esc(Number(latest.employees).toLocaleString("en-US"))}</p><p class="small secondary">Employees in September ${latest.year}, from OPM's Federal Workforce Data.</p></div>`;
  const more = rows.length > 1 ? `<details class="mini-bars-table"><summary>Show the numbers</summary><table><thead><tr><th scope="col">September</th><th scope="col">Employees</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${r.year}</th><td>${esc(Number(r.employees).toLocaleString("en-US"))}</td></tr>`).join("")}</tbody></table></details>` : "";
  return card("workforce", "Workforce", `${big}${more}`, `Civilian employees on board, counted from OPM's monthly records. ${ext(latest.source_url, "OPM data")}`);
}

export function reportsSection(reports) {
  if (!reports.length) return "";
  return card("oversight", "Oversight reports", list(reports.map((r) => row(esc(r.title), [esc(String(r.source).toUpperCase()), esc(r.number), esc(date(r.published_on))].filter(Boolean).join(" · "), "", r.url, true))), esc(REPORTS_NOTE));
}

export function rulesSection(counts, rules, agency) {
  if (!counts.length && !rules.length) return "";
  const total = counts[0] ? `<p class="small">${counts.slice(0, 3).map((c) => `${c.rules.toLocaleString("en-US")} rule${c.rules === 1 ? "" : "s"} in ${c.year}`).join(" · ")}</p>` : "";
  const table = counts.length > 3 ? `<details class="mini-bars-table"><summary>Show the numbers</summary><table><thead><tr><th scope="col">Year</th><th scope="col">Rules published</th></tr></thead><tbody>${counts.map((c) => `<tr><th scope="row">${c.year}</th><td>${c.rules.toLocaleString("en-US")}</td></tr>`).join("")}</tbody></table></details>` : "";
  const latest = rules.length ? list(rules.map((r) => row(esc(r.title), esc(date(r.published_on)), "", r.url, true))) : "";
  return card("rules", "Rules", `${total}${latest}${table}`, `Documents of type Rule the Federal Register publishes for the agency. ${ext(`https://www.federalregister.gov/agencies/${encodeURIComponent(agency.id)}`, "Federal Register")}`);
}

export function lawsSection(bills) {
  if (!bills.length) return "";
  const rows = bills.map((b) => {
    const vote = b.final_result && b.last_final ? `${esc(b.final_result)}, ${esc(date(b.last_final))}${num(b.yea) != null ? ` · ${b.yea} yes, ${b.nay} no` : ""}` : "No final-passage vote recorded";
    return row(`${esc(b.bill_number)} · ${esc(b.title)}`, vote, `<span class="chev" aria-hidden="true">›</span>`, `/laws/bills/${encodeURIComponent(b.bill_id)}/`);
  });
  const sub = [...new Set(bills.map((b) => b.subcommittee).filter(Boolean))];
  return card("laws", "Funding laws", list(rows), `Appropriations bills from the ${esc(sub.join(" and "))} subcommittee${sub.length === 1 ? "" : "s"}, matched by the bill's own title. Each bill's page lists every member's vote.`);
}

export function childrenSection(children) {
  if (!children.length) return "";
  return `<section class="card compact-list agency-card" id="parts"><h2 class="tax-title">Agencies in this department</h2>${children.map((c) => agencyRow(c)).join("")}</section>`;
}

export function agencyMain(d) {
  const a = d.agency;
  const sub = [a.short_name, a.parent_name ? `Part of the ${a.parent_name}` : a.kind === "department" ? "Executive department" : ""].filter(Boolean).map(esc).join(" · ");
  const sections = [whatItIs(a), leadership(d.leaders, a), moneySection(d.money, d.parts, d.recipients, a), workforceSection(d.workforce), reportsSection(d.reports), rulesSection(d.ruleCounts, d.rules, a), lawsSection(d.bills), childrenSection(d.children)].filter(Boolean);
  const parent = a.parent_id ? `<p class="small"><a class="inline-link" href="${agencyHref(a.parent_id)}">${esc(a.parent_name)} ›</a></p>` : "";
  return `<div class="tax-page agency-page">
<header class="page-head"><h1>${esc(a.name)}</h1>${sub ? `<p class="subtitle">${sub}</p>` : ""}${parent}</header>
${sections.join("\n") || `<section class="card"><p class="secondary">Only this agency's name is loaded so far. ${esc(NOT_LOADED.replace("; none are loaded yet.", "."))}</p></section>`}
<p class="small secondary">Facts from official sources, each with its year and source. <a class="inline-link" href="${METHOD}">How this works ›</a></p>
</div>`;
}
