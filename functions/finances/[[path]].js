// /finances/             federal debt, receipts, spending by category, interest and
//                        the deficit, by presidential term
// /finances/california/  California's General Fund by governor's term
// Data: data/history/finances.json (tools/build_history.py). Every term uses the
// same layout and measures; who held office and which party led each chamber are
// plain facts beside the numbers, never colored and never framed as cause.
import { page, esc, fmtDate, notFound, guard, edgeCached, loadSection, FAILED, sectionError } from "../_lib/render.js";
import { loadFinances, loadCalifornia } from "../_lib/history.js";
import { federalTerms, californiaTerms, usd, pctText } from "../_lib/finances.js";
import { miniBars } from "../_lib/charts.js";

const CACHE_SECONDS = 300;
const METHOD = "/about/methodology/#time-machine";

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (context.params.path || []).filter(Boolean).map((s) => s.toLowerCase());
  if (parts.length === 0) return edgeCached(context, CACHE_SECONDS, () => federalPage(context.env, context.request));
  if (parts.length === 1 && parts[0] === "california") return edgeCached(context, CACHE_SECONDS, () => californiaPage(context.env, context.request));
  return notFound("No page at this address.", "laws", ["Federal finances", "/finances/"]);
}, { tab: "laws" });

const today = () => new Date().toISOString().slice(0, 10);
const fy = (y, fed) => (fed ? `FY${y}` : `${y - 1}–${String(y).slice(2)}`);
const span = (t) => `${fmtDate(t.start)} to ${t.end && t.end <= today() ? fmtDate(t.end) : "present"}`;

/** One measure, the same block for every term. */
function measureBlock(label, m, { fed, signedChange = true, noPct = false, gapNote, perPerson = true }) {
  const gaps = [];
  if (m.start == null) gaps.push(`${label} for ${fy(m.from, fed)}`);
  if (m.end == null) gaps.push(`${label} for ${fy(m.to, fed)}`);
  if (perPerson) {
    if (m.start != null && m.startPerPerson == null) gaps.push(`population for ${fy(m.from, fed)}`);
    if (m.end != null && m.endPerPerson == null) gaps.push(`population for ${fy(m.to, fed)}`);
    if (m.start != null && m.startPerHousehold == null) gaps.push(`household count for ${fy(m.from, fed)}`);
    if (m.end != null && m.endPerHousehold == null) gaps.push(`household count for ${fy(m.to, fed)}`);
  }
  if (!gapNote && m.start != null && m.startShare == null) gaps.push(`GDP for ${fy(m.from, fed)}`);
  if (!gapNote && m.end != null && m.endShare == null) gaps.push(`GDP for ${fy(m.to, fed)}`);
  const pair = (a, b, f) => `${a == null ? "Not available" : f(a)} → ${b == null ? "Not available" : f(b)}`;
  const share = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
  const rows = [
    [`${fy(m.from, fed)} → ${fy(m.to, fed)}`, pair(m.start, m.end, (v) => usd(v))],
    ["Change", m.change == null ? "Not available" : `${usd(m.change, { signed: signedChange })}${noPct ? "" : ` (${pctText(m.changePct)})`}`],
    ["Share of GDP", m.startShare == null && m.endShare == null ? gapNote || "Not available" : pair(m.startShare, m.endShare, share)],
  ];
  if (perPerson) {
    rows.push(["Per person", m.startPerPerson == null && m.endPerPerson == null ? "Not available" : pair(m.startPerPerson, m.endPerPerson, (v) => usd(v))]);
    rows.push(["Per household", m.startPerHousehold == null && m.endPerHousehold == null ? "Not available" : pair(m.startPerHousehold, m.endPerHousehold, (v) => usd(v))]);
  }
  return {
    html: `<div class="fin-measure stack-xs">
  <h4 class="fin-measure-name">${esc(label)}</h4>
  <dl class="kv kv--tight">${rows.map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
</div>`,
    gaps,
  };
}

const lastName = (n) => n.replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/, "").split(/\s+/).pop();
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;

function congressRow(c) {
  const h = c.house ? `House: ${c.house.majority} majority (Democrats ${c.house.democrats}, Republicans ${c.house.republicans} at the start)` : "House: not available";
  const s = !c.senate
    ? "Senate: not available"
    : c.senate.majority
      ? `Senate: ${c.senate.majority} majority`
      : c.senate.majorities && c.senate.majorities.length > 1
        ? `Senate: the majority changed during this Congress (${c.senate.majorities.join(", then ")})`
        : "Senate: no single majority listed (see the Senate Historian)";
  return `<li class="small">${ordinal(c.congress)} Congress (${c.years[0]}–${c.years[1]}) · ${esc(h)} · ${esc(s)}</li>`;
}

function eventRows(events) {
  return events.map((e) => `<li class="small">${esc(e.label)}: ${esc(e.from)}${e.to ? ` to ${esc(e.to)}` : ""} · <a class="inline-link" href="${esc(e.source)}" target="_blank" rel="noopener">Source ↗</a></li>`).join("");
}

const FISCAL_NOTE_FED = "The federal fiscal year starts October 1. A President takes office in January, partway through a fiscal year whose budget was largely set by the previous administration and Congress, so a term's first fiscal year mostly reflects decisions made before it began.";
const FISCAL_NOTE_CA = "California's fiscal year starts July 1. A Governor takes office in January, partway through a fiscal year whose budget was enacted under the previous Governor and Legislature, so a term's first fiscal year mostly reflects decisions made before it began.";
const READ_NOTE = "Amounts are in dollars of each year, not adjusted for inflation; the share of GDP and the per-person figures help compare years. Many things move these numbers at once: the economy, laws passed by earlier Congresses, programs that grow on their own, emergencies. The figures show what happened during each term, not who caused it.";

/** Two small bar charts by fiscal year: debt as a share of GDP, and the surplus or deficit. One color, no party colors. */
function debtChart(years) {
  const tick = (y, i) => (i === 0 || y % 8 === 0 ? `’${String(y).slice(2)}` : "");
  const debt = years.filter((r) => r.debt != null && r.gdp);
  const def = years.filter((r) => r.surplus != null);
  const share = miniBars(debt.map((r, i, all) => ({ label: `FY${r.fy}`, value: (r.debt / r.gdp) * 100, tick: tick(r.fy, i, all) })), {
    format: (v) => `${v.toFixed(1)}%`,
    caption: "Federal debt as a share of GDP at the end of each fiscal year (Treasury; OMB Table 10.1).",
    ariaLabel: `Federal debt as a share of GDP, FY${debt[0] ? debt[0].fy : ""} to FY${debt.length ? debt[debt.length - 1].fy : ""}`,
    head: ["Fiscal year", "Debt, % of GDP"],
  });
  const flow = miniBars(def.map((r, i, all) => ({ label: `FY${r.fy}`, value: r.surplus, tick: tick(r.fy, i, all) })), {
    format: (v) => usd(v),
    caption: "Surplus (above the line) or deficit (below the line, gray) in each fiscal year (OMB Table 1.1).",
    ariaLabel: "Federal surplus or deficit by fiscal year",
    head: ["Fiscal year", "Surplus or deficit"],
  });
  if (!share && !flow) return "";
  return `<section class="card stack">${share ? `<h2>Debt as a share of GDP</h2>${share}` : ""}${flow ? `<h2>Surplus or deficit</h2>${flow}` : ""}</section>`;
}

async function federalPage(env, request) {
  const fin = await loadSection("finances", () => loadFinances(env, request), null);
  const head = `<header class="page-head stack-xs">
  <p class="label">Time Machine</p>
  <h1>Federal finances by presidential term</h1>
  <p class="subtitle">Debt, receipts, spending by category, interest and the deficit, at the start and end of each term, the same way for every administration.</p>
</header>
<nav class="pill-filter" aria-label="Finances"><a class="toggle" href="/finances/" aria-current="true">Federal</a><a class="toggle" href="/finances/california/">California</a></nav>`;
  if (!fin || fin === FAILED) return page("Federal finances", `${head}${fin === FAILED ? sectionError("Federal finances") : '<section class="card"><p class="small secondary">Not loaded yet. The figures appear after the history data is built from Treasury and OMB records.</p></section>'}`, { tab: "laws", back: ["Laws", "/laws/"], partial: fin === FAILED });
  const terms = federalTerms(fin, today());
  const termNumber = new Map();
  for (const t of terms) termNumber.set(t.name, (termNumber.get(t.name) || 0) + 1), (t.n = termNumber.get(t.name));
  const cards = terms
    .slice()
    .reverse()
    .map((t) => {
      const parts = [
        measureBlock("Federal debt", t.debt, { fed: true }),
        measureBlock("Receipts", t.receipts, { fed: true }),
        measureBlock("Spending (outlays)", t.outlays, { fed: true }),
        measureBlock("Surplus or deficit (−)", t.surplus, { fed: true, noPct: true }),
        measureBlock("Net interest", t.interest, { fed: true }),
      ];
      const gaps = [...new Set(parts.flatMap((p) => p.gaps))];
      const cats = t.categories
        .map((c) => `<li class="fin-cat"><span class="fin-cat-name">${esc(c.name)}</span><span class="small">${usd(c.start)} → ${usd(c.end)} · ${c.changePct == null ? "change not available" : pctText(c.changePct)}${c.endShare != null ? ` · ${c.endShare.toFixed(1)}% of GDP in ${fy(c.to, true)}` : ""}</span></li>`)
        .join("");
      const id = `term-${t.start.slice(0, 4)}`;
      return `<article class="card stack fin-term" id="${id}" aria-labelledby="h-${id}">
  <div class="stack-xs">
    <p class="label">President${t.n > 1 || terms.filter((x) => x.name === t.name).length > 1 ? ` · Term ${t.n}` : ""}</p>
    <h2 class="fin-name" id="h-${id}">${esc(t.name)}</h2>
    <p class="small secondary">${span(t)}</p>
    <p class="small">Start: ${fy(t.years.before, true)} (ended Sep 30, ${t.years.before}). End: ${fy(t.years.last, true)}${t.years.inProgress ? ", the latest with published figures; this term is in progress" : ""}.</p>
  </div>
  <div class="fin-measures">${parts.map((p) => p.html).join("")}</div>
  ${cats ? `<details class="fin-details"><summary>Spending by category</summary><ul class="plain-list stack-xs">${cats}</ul><p class="hint">OMB Historical Tables, Table 3.1 functions. Net interest is also a category.</p></details>` : ""}
  <details class="fin-details"><summary>Congress during this term</summary><ul class="plain-list stack-xs">${t.congresses.map(congressRow).join("") || '<li class="small secondary">Not available.</li>'}</ul><p class="hint">Party divisions as the House and Senate historians list them.</p></details>
  ${t.events.length ? `<div class="stack-xs"><p class="label">Marked events that began during this term</p><ul class="plain-list stack-xs">${eventRows(t.events)}</ul></div>` : ""}
  ${gaps.length ? `<p class="xsmall secondary">Not available: ${esc(gaps.join("; "))}.</p>` : ""}
</article>`;
    })
    .join("");
  const jump = terms.slice().reverse().map((t) => `<li><a class="chip chip--tap" href="#term-${t.start.slice(0, 4)}">${esc(lastName(t.name))} ${t.start.slice(0, 4)}</a></li>`).join("");
  const src = fin.federal.sources || {};
  const main = `${head}
<section class="card stack-xs"><p class="small">${esc(FISCAL_NOTE_FED)}</p><p class="small">${esc(READ_NOTE)}</p></section>
${debtChart(fin.federal.years)}
<nav aria-label="Terms"><ul class="plain-list chips">${jump}</ul></nav>
${cards}
<section class="card stack-xs"><h2 class="label">Sources</h2><ul class="plain-list stack-xs">${Object.values(src).map((s) => `<li class="small"><a class="inline-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a></li>`).join("")}<li class="small"><a class="inline-link" href="${esc(fin.federal.control.house_source)}" target="_blank" rel="noopener">House party divisions: Office of the Historian ↗</a></li><li class="small"><a class="inline-link" href="${esc(fin.federal.control.senate_source)}" target="_blank" rel="noopener">Senate party division: Senate Historical Office ↗</a></li></ul><p class="hint"><a class="inline-link" href="${METHOD}">How the Time Machine works</a></p></section>`;
  return page("Federal finances by presidential term", main, { tab: "laws", back: ["Laws", "/laws/"] });
}

async function californiaPage(env, request) {
  const [fin, cal] = await Promise.all([loadSection("finances", () => loadFinances(env, request), null), loadSection("california history", () => loadCalifornia(env, request), null)]);
  const head = `<header class="page-head stack-xs">
  <p class="label">Time Machine</p>
  <h1>California's budget by governor's term</h1>
  <p class="subtitle">General Fund revenues, spending and ending balance at the start and end of each term, the same way for every governor.</p>
</header>
<nav class="pill-filter" aria-label="Finances"><a class="toggle" href="/finances/">Federal</a><a class="toggle" href="/finances/california/" aria-current="true">California</a></nav>`;
  if (!fin || fin === FAILED || !fin.california.general_fund) return page("California's budget", `${head}${fin === FAILED ? sectionError("California's budget") : '<section class="card"><p class="small secondary">Not loaded yet. The figures appear after the history data is built from the Department of Finance\'s historical charts.</p></section>'}`, { tab: "laws", back: ["Federal finances", "/finances/"], partial: fin === FAILED });
  const terms = californiaTerms(fin, today(), cal && cal !== FAILED ? cal.legislature_makeup : []);
  const gdpNote = "Not available: California's GDP isn't in the sources ThePillory reads";
  const cards = terms
    .slice()
    .reverse()
    .map((t) => {
      const parts = [
        measureBlock("General Fund revenues and transfers", t.revenues, { fed: false, gapNote: gdpNote }),
        measureBlock("General Fund spending", t.expenditures, { fed: false, gapNote: gdpNote }),
        measureBlock("General Fund ending balance", t.balance, { fed: false, noPct: true, gapNote: gdpNote }),
      ];
      const gaps = [...new Set(parts.flatMap((p) => p.gaps))];
      gaps.push("California's GDP (so no share of GDP)");
      const id = `term-${t.start.slice(0, 4)}`;
      const leg = t.legislature
        .map((m) => `<li class="small">After the ${m.after_election} general election: ${m.assembly_seats ? `Assembly ${Object.entries(m.assembly).map(([p, n]) => `${esc(p)} ${n}`).join(", ")} (${m.assembly_seats} of 80 seats read)` : "Assembly not read"}; ${m.senate_seats ? `Senate ${Object.entries(m.senate).map(([p, n]) => `${esc(p)} ${n}`).join(", ")} (${m.senate_seats} of 40 seats read)` : "Senate not read"} · <a class="inline-link" href="${esc(m.source)}" target="_blank" rel="noopener">Statement of Vote ↗</a></li>`)
        .join("");
      return `<article class="card stack fin-term" id="${id}" aria-labelledby="h-${id}">
  <div class="stack-xs">
    <p class="label">Governor</p>
    <h2 class="fin-name" id="h-${id}">${esc(t.name)}</h2>
    <p class="small secondary">${t.from}–${t.to || "present"}</p>
    <p class="small">Start: fiscal year ${fy(t.years.before, false)} (ended June 30, ${t.years.before}). End: ${fy(t.years.last, false)}${t.years.inProgress ? ", the latest with actual figures; this term is in progress" : ""}.</p>
  </div>
  <div class="fin-measures">${parts.map((p) => p.html).join("")}</div>
  <details class="fin-details"><summary>The Legislature during this term</summary>${leg ? `<ul class="plain-list stack-xs">${leg}</ul><p class="hint">Seats by the winner's party as listed on the ballot, from general-election results. Seats filled by special election or left vacant aren't counted, so totals can fall short of 80 and 40.</p>` : '<p class="small secondary">Not available: the Statements of Vote ThePillory reads start with the 2002 general election.</p>'}</details>
  ${t.events.length ? `<div class="stack-xs"><p class="label">Marked events that began during this term</p><ul class="plain-list stack-xs">${eventRows(t.events)}</ul></div>` : ""}
  <p class="xsmall secondary">Not available: ${esc(gaps.join("; "))}.</p>
</article>`;
    })
    .join("");
  const gf = fin.california.general_fund;
  const main = `${head}
<section class="card stack-xs"><p class="small">${esc(FISCAL_NOTE_CA)}</p><p class="small">${esc(READ_NOTE.replace("Congresses", "Legislatures"))}</p><p class="small">The General Fund is the state's main operating account; special funds, bond funds and federal funds are outside it.${gf.estimates_from ? ` The Department of Finance's chart${gf.as_of ? ` (${esc(gf.as_of)})` : ""} gives estimates, not actual figures, for fiscal years from ${fy(gf.estimates_from, false)} on, so those years aren't shown. Before 2005–06, the chart shows each year's figures as first published in the Governor's Budget.` : ""}</p></section>
${cards}
<section class="card stack-xs"><h2 class="label">Sources</h2><ul class="plain-list stack-xs">
  <li class="small"><a class="inline-link" href="${esc(gf.source)}" target="_blank" rel="noopener">General Fund budget summary: Department of Finance, Chart A ↗</a></li>
  ${(fin.california.population_sources || []).map((u) => `<li class="small"><a class="inline-link" href="${esc(u)}" target="_blank" rel="noopener">Population and housing estimates: Department of Finance ↗</a></li>`).join("")}
  <li class="small"><a class="inline-link" href="https://governors.library.ca.gov/list.html" target="_blank" rel="noopener">Governors: California State Library ↗</a></li>
</ul><p class="hint"><a class="inline-link" href="${METHOD}">How the Time Machine works</a></p></section>`;
  return page("California's budget by governor's term", main, { tab: "laws", back: ["Federal finances", "/finances/"] });
}
