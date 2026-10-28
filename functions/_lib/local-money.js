// Local campaign money: California counties and cities that publish filings
// through NetFile (data/local-money/<CODE>.json, tools/build_netfile.py), in
// the same layout as state and federal money. Facts side by side; nothing ties
// money to a vote or a position in words.
//
//   loadLocalMoney        every loaded agency in a county (the county and its cities)
//   committeeBlock        one committee: itemized contributions and payments, organizations
//                         by name, individuals as a total, employers with 3+ donors, "As of"
//   candidateMoney        a local candidate's committee (a unique match only), or a plain line
//   contestSpending       independent expenditures naming a contest's candidates
//   localBehindSection    "Who's behind each side" for a local measure
//   officialMoney         a county official's committees, for the Funding tab
//
// What NetFile's public data doesn't give is said plainly: the Form 460 summary
// (total raised including unitemized contributions, and cash on hand) and whether
// an independent expenditure supports or opposes; both are on each filing, linked.
import { esc, sourceLink, fmtDate } from "./render.js";
import { asset } from "./geo.js";
import { fold } from "./summary.js";

export const LOCAL_NOTE = "Totals are the itemized transactions in the committee's e-filed statements, read from NetFile's public data: contributions of $100 or more and itemized payments. Each statement's summary page, with small unitemized contributions and cash on hand, is in the filing itself.";
const IE_NOTE = "NetFile's data names the candidate an independent expenditure was about, but not whether it supported or opposed them; the filing says.";
const dollars = (n) => `${Number(n) < 0 ? "−" : ""}$${Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US")}`;

/** Every agency loaded for a county: [{code, name, ...doc}]. Missing files are skipped. */
export async function loadLocalMoney(env, request, fips) {
  const index = await asset(env, request, "/data/local-money/index.json");
  const codes = ((index && index.agencies) || []).filter((a) => a.county === fips).map((a) => a.code);
  const docs = await Promise.all(codes.map((c) => asset(env, request, `/data/local-money/${c}.json`).catch(() => null)));
  return docs.filter(Boolean);
}

function filingsLine(c, doc) {
  const latest = c.filings[0];
  const n = c.filings.length;
  return `${esc(`As of the latest filing${c.as_of ? `, ${fmtDate(c.as_of)}` : ""}`)}. ${latest ? sourceLink(latest.url, "Latest filing") : ""}${n > 1 ? ` · ${esc(`${n} filings since ${fmtDate(doc.since)}`)}` : ""} · ${sourceLink(doc.source_url, `${doc.name}'s filings on NetFile`)}`;
}

/** One committee, the same card as a ballot measure committee's. */
export function committeeBlock(c, doc) {
  const orgs = c.organizations.length
    ? `<ul class="plain-list money-list">${c.organizations
        .map((o) => `<li class="money-row small"><span>${esc(o.name)}</span><span class="money-amount">${esc(dollars(o.total))}</span></li>`)
        .join("")}</ul>${c.organizations_count > c.organizations.length ? `<p class="hint">${esc(`The ${c.organizations.length} largest of ${c.organizations_count} organizations.`)}</p>` : ""}`
    : '<p class="small secondary">No contributions from organizations itemized.</p>';
  const emps = c.employers.length
    ? `<p class="label">Individuals' employers named by 3 or more donors</p><ul class="plain-list money-list">${c.employers
        .map((e) => `<li class="money-row small"><span>${esc(e.employer)}<span class="money-when">${esc(`${e.donors} donors`)}</span></span><span class="money-amount">${esc(dollars(e.total))}</span></li>`)
        .join("")}</ul>`
    : "";
  return `<div class="inset stack-xs">
  <p class="list-title">${c.filings[0] ? sourceLink(c.filings[0].url, c.name) : esc(c.name)}</p>
  <p class="small">${esc(`Itemized contributions ${dollars(c.contributions)}${c.nonmonetary ? ` · Non-monetary ${dollars(c.nonmonetary)}` : ""} · Itemized payments ${dollars(c.payments)}`)}</p>
  <p class="label">Largest donors that are organizations</p>
  ${orgs}
  <p class="small">${esc(`From individuals: ${dollars(c.individuals.total)} in ${c.individuals.count.toLocaleString("en-US")} itemized ${c.individuals.count === 1 ? "contribution" : "contributions"} (people aren't named).`)}</p>
  ${emps}
  <p class="hint">${filingsLine(c, doc)}</p>
</div>`;
}

/** A local candidate's committee: [{c, doc}] for the one committee matched to them, else []. */
export function candidateCommittees(docs, contestId, name) {
  const out = [];
  for (const doc of docs || []) {
    for (const [lid, m] of Object.entries(doc.candidates || {})) {
      if (m.contest === contestId && m.candidate === name && doc.committees[lid]) out.push({ c: doc.committees[lid], doc });
    }
  }
  return out;
}

/** The campaign money fold on a local candidate's card. */
export function candidateMoney(docs, contestId, name) {
  if (!docs || !docs.length) return "";
  const found = candidateCommittees(docs, contestId, name);
  const body = found.length
    ? `${found.map(({ c, doc }) => committeeBlock(c, doc)).join("")}<p class="hint">${esc(LOCAL_NOTE)}</p>`
    : `<p class="small secondary">${esc(`No committee in ${docs.map((d) => d.name).join(" or ")}'s NetFile filings matched this candidate by name and office. Unmatched committees aren't guessed.`)}</p>`;
  return `<details class="cand-statement"><summary>Campaign money</summary><div class="statement-body stack-xs">${body}</div></details>`;
}

/** Independent expenditures that name one of a contest's candidates. */
export function contestSpending(docs, contestId) {
  const rows = [];
  for (const doc of docs || []) for (const x of doc.ies || []) if (x.contest === contestId) rows.push({ x, doc });
  if (!rows.length) return "";
  rows.sort((a, b) => (b.x.date || "").localeCompare(a.x.date || ""));
  return `<section class="stack-sm" aria-labelledby="h-ie"><h2 class="label" id="h-ie">Independent spending naming these candidates</h2>
  <div class="card stack-xs"><ul class="plain-list money-list">${rows
    .map(({ x }) => `<li class="money-row small"><span>${sourceLink(x.url, x.spender)}<span class="money-when">${esc(`${x.candidate}${x.date ? ` · ${fmtDate(x.date)}` : ""}`)}</span></span><span class="money-amount">${esc(dollars(x.amount))}</span></li>`)
    .join("")}</ul>
  <p class="hint">${esc(IE_NOTE)} From each spender's Form 496 filings on NetFile.</p></div>
</section>`;
}

/** "Who's behind each side" for a local measure: committees whose names say "Yes on" or "No on" the measure. */
export function localBehindSection(docs, m) {
  if (!docs || !docs.length) return fold("behind", "Who's behind each side", '<p class="small secondary">Campaign committee data for this county isn\'t loaded yet.</p>');
  const found = [];
  for (const doc of docs) for (const [lid, x] of Object.entries(doc.measures || {})) if (x.measure === m.id && doc.committees[lid]) found.push({ c: doc.committees[lid], doc, side: x.side });
  const side = (s) => {
    const list = found.filter((f) => f.side === s);
    return `<div class="stack-sm behind-side">
  <h3 class="label">${esc(s === "support" ? "Supporting (Yes)" : "Opposing (No)")}</h3>
  ${list.length ? list.map(({ c, doc }) => committeeBlock(c, doc)).join("") : `<p class="small secondary">${esc(`No committee named "${s === "support" ? "Yes" : "No"} on ${m.title}" has filed with ${docs.map((d) => d.name).join(" or ")} on NetFile.`)}</p>`}
</div>`;
  };
  return fold("behind", "Who's behind each side", `<div class="behind-sides">${side("support")}${side("oppose")}</div>
<p class="hint">Money and positions are listed side by side as facts, from the committees' own filings. A committee is shown only when its name says "Yes on" or "No on" this measure's letter and it filed in this measure's jurisdiction. ${esc(LOCAL_NOTE)}</p>`);
}

/** A county official's committees (matched in the builder by last name, office and district), for the Funding tab. */
export function officialMoney(docs, name) {
  const found = [];
  for (const doc of docs || []) for (const lid of (doc.officials || {})[name] || []) if (doc.committees[lid]) found.push({ c: doc.committees[lid], doc });
  if (!found.length) return "";
  return `<div class="stack-sm">${found.map(({ c, doc }) => committeeBlock(c, doc)).join("")}<p class="hint">${esc(LOCAL_NOTE)}</p></div>`;
}
