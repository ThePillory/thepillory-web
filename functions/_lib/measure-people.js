// Ballot measure pages: who's behind each side, and the people and
// organizations who signed the arguments. Facts side by side, the same layout
// for Yes and No and for every measure; nothing says why anyone took a side,
// and no money is tied to a position in words.
//
//   loadMeasureMoney   data/elections/measure-money-<election>.json (Cal-Access,
//                      tools/build_measure_money.py), or null
//   behindSection      "Who's behind each side": the committees formed for the
//                      measure, their money and top donors (organizations by
//                      name; individuals only as totals), and other spending
//   signerContext      who a signer could be: the state's officials (D1) and the
//                      election's certified candidates
//   signerDetails      for one measure's signers: the link and the collapsed
//                      panel for each official, candidate and organization
//                      (private individuals stay as printed, with no panel)
import { esc, safeUrl, sourceLink, fmtDate, loadSection, FAILED } from "./render.js";
import { asset } from "./geo.js";
import { fold } from "./summary.js";
import { STATE_NAME } from "./districts.js";
import { voteCounts, votesFor } from "./data.js";
import { networthFor, networthPoints, rangeText } from "./networth.js";
import { stateCandidateHref, nameSlug } from "./candidates.js";
import { orgKey, nonprofitPage, SUBSECTIONS } from "../../workers/sync/src/funding/darkmoney.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";
import { orgFromTitle, isGovernment, matchSigner } from "../../workers/sync/src/elections/signers.js";

export const BEHIND_NOTE = "Money and positions are listed side by side as facts, from the committees' own filings. ThePillory doesn't say why anyone took a side.";
const dollars = (n) => `${Number(n) < 0 ? "−" : ""}$${Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US")}`;
const SIDE_LABEL = { support: "Yes", oppose: "No" };

/** The measure-money file for an election, or null when there isn't one. */
export async function loadMeasureMoney(env, request, electionId) {
  try {
    return await asset(env, request, `/data/elections/measure-money-${electionId}.json`);
  } catch {
    return null;
  }
}

const propsList = (props) => props.map((p) => `Prop. ${p.number} (${SIDE_LABEL[p.side]})`).join(", ");

function committeeCard(c, number) {
  const others = c.props.filter((p) => p.number !== String(number));
  const orgs = c.organizations.length
    ? `<ul class="plain-list money-list">${c.organizations
        .map((o) => `<li class="money-row small"><span>${sourceLink(o.statement_url, o.name)}</span><span class="money-amount">${esc(dollars(o.total))}</span></li>`)
        .join("")}</ul>${c.organizations_count > c.organizations.length ? `<p class="hint">${esc(`The ${c.organizations.length} largest of ${c.organizations_count} organizations.`)}</p>` : ""}`
    : '<p class="small secondary">No contributions from organizations itemized.</p>';
  return `<div class="inset stack-xs">
  <p class="list-title">${sourceLink(c.source_url, c.name)}</p>
  <p class="small">Raised ${esc(dollars(c.raised))} · Spent ${esc(dollars(c.spent))}${c.cash_end != null ? ` · Cash on hand ${esc(dollars(c.cash_end))}` : ""}</p>
  ${c.raised < 0 ? '<p class="small secondary">Below zero: the committee reported returning more than it received in these statements.</p>' : ""}
  ${others.length ? `<p class="small secondary">${esc(`Also formed for ${propsList(others)}; these totals cover all of them.`)}</p>` : ""}
  <p class="label">Largest donors that are organizations</p>
  ${orgs}
  <p class="small">${esc(`From individuals: ${dollars(c.individuals.total)} in ${c.individuals.count.toLocaleString("en-US")} itemized ${c.individuals.count === 1 ? "contribution" : "contributions"} (people aren't named).`)}</p>
  <p class="hint">${esc(`As of the statement covering through ${fmtDate(c.through)}`)}, ${esc(`${c.statements} ${c.statements === 1 ? "statement" : "statements"} since 2025`)}. ${sourceLink(c.statement_url, "Latest statement")}</p>
</div>`;
}

function spendingRow(x) {
  const who = x.person ? `${x.people} ${x.people === 1 ? "person" : "people"} spending their own money (not named)` : x.spender;
  const when = x.first && x.last ? (x.first === x.last ? fmtDate(x.first) : `${fmtDate(x.first)} – ${fmtDate(x.last)}`) : "";
  return `<li class="money-row small"><span>${x.source_url ? sourceLink(x.source_url, who) : esc(who)}${when ? `<span class="money-when">${esc(when)}</span>` : ""}</span><span class="money-amount">${esc(dollars(x.total))}</span></li>`;
}

/** "Who's behind each side", folded: committees formed for the measure, then other independent spending, Yes and No alike. */
export function behindSection(money, m, election) {
  const st = election.election.state;
  if (!money || !money.measures) {
    return fold("behind", "Who's behind each side", `<p class="small secondary">${esc(`Campaign committee data for ${STATE_NAME[st] || st}'s measures isn't loaded yet.`)}</p>`);
  }
  const x = money.measures[String(m.number)];
  if (!x) return fold("behind", "Who's behind each side", '<p class="small secondary">Campaign committee data for this measure isn\'t loaded yet.</p>');
  const side = (s) => {
    const committees = x.committees.filter((c) => c.side === s);
    const spending = x.spending.filter((y) => y.side === s);
    return `<div class="stack-sm behind-side">
  <h3 class="label">${esc(s === "support" ? "Supporting (Yes)" : "Opposing (No)")}</h3>
  ${committees.length ? committees.map((c) => committeeCard(c, m.number)).join("") : `<p class="small secondary">${esc(`No committee formed to ${s} this measure has filed a campaign statement naming it.`)}</p>`}
  <p class="label">Independent spending by others</p>
  ${spending.length ? `<ul class="plain-list money-list">${spending.map(spendingRow).join("")}</ul>` : '<p class="small secondary">None reported.</p>'}
</div>`;
  };
  const inner = `<div class="behind-sides">${side("support")}${side("oppose")}</div>
<p class="hint">${esc(BEHIND_NOTE)} Committees formed for this measure are those whose campaign statements name it with a side; independent spending is reported on Form 496. ${sourceLink(x.cal_access_url || "https://cal-access.sos.ca.gov/Campaign/Measures/", "Cal-Access: this proposition")} · ${esc(`Read ${fmtDate(money.generated)}.`)}</p>`;
  return fold("behind", "Who's behind each side", inner);
}

/** Who a signer could be: the state's officials and the election's certified candidates (with their contest). */
export async function signerContext(db, election) {
  const st = election.election.state;
  let officials = [];
  if (db) {
    officials = (await db.prepare("SELECT id, slug, name, last_name, office, chamber, level, district, party FROM officials WHERE active = 1 AND state = ?").bind(st).all()).results;
  }
  const candidates = [];
  for (const contest of election.contests || []) for (const c of contest.candidates || []) candidates.push({ ...c, contest });
  return { officials, candidates };
}

const line = (label, html) => `<div class="signer-fact"><p class="label">${esc(label)}</p><p class="small">${html}</p></div>`;

async function officialPanel(db, o) {
  const cycle = currentCycle();
  const federal = o.level === "federal";
  const [counts, latest, raised, nw] = await Promise.all([
    loadSection("signer votes", () => voteCounts(db, o.id), {}),
    loadSection("signer latest vote", () => votesFor(db, o.id, { all: false, limit: 1, offset: 0 }), { rows: [] }),
    loadSection("signer money", async () => {
      const r = federal
        ? await db.prepare("SELECT receipts AS raised FROM funding_totals WHERE official_id = ? AND cycle = ?").bind(o.id, cycle).first()
        : await db.prepare("SELECT raised FROM state_money_cycles WHERE official_id = ? AND cycle = ?").bind(o.id, `${cycle - 1}-${cycle}`).first();
      return r ? r.raised : null;
    }, null),
    federal ? loadSection("signer net worth", async () => networthPoints(await networthFor(db, o.id)), null) : null,
  ]);
  const c = counts === FAILED ? null : counts;
  const v = latest === FAILED ? null : latest.rows[0];
  const votes = c && c.final
    ? `${c.final.toLocaleString("en-US")} final-passage ${c.final === 1 ? "vote" : "votes"} on record${v ? `; the latest, ${fmtDate(v.vote_date)}: ${v.position} on ${v.bill_number || v.question}` : ""}.`
    : "No final-passage votes on record.";
  const money = raised === FAILED ? "Couldn't load right now." : raised != null ? `${dollars(raised)} raised in ${cycle - 1}–${cycle}.` : "Not loaded for this period.";
  const worth = nw && nw !== FAILED && nw.first ? `${rangeText(nw.first)} (${nw.first.year}, ${nw.label})${nw.latest ? ` → ${rangeText(nw.latest)} (${nw.latest.year})` : ""}` : "None on record.";
  const href = `/reps/${o.slug}/`;
  return `<details class="signer-more">
  <summary>About ${esc(o.name)}</summary>
  <div class="inset stack-xs">
    ${line("Office", esc([o.office, o.district].filter(Boolean).join(", ")))}
    ${line("Party", esc(o.party || "None listed"))}
    ${line("Votes", `${esc(votes)} <a class="inline-link" href="${esc(href)}#votes">Full record ›</a>`)}
    ${line("Money raised", `${esc(money)} <a class="inline-link" href="${esc(href)}#funding">Full record ›</a>`)}
    ${line("Net worth, as reported", `${esc(worth)} <a class="inline-link" href="${esc(href)}#more">Full record ›</a>`)}
  </div>
</details>`;
}

async function candidatePanel(db, c) {
  const cycle = currentCycle();
  const href = stateCandidateHref(c.contest.id, nameSlug(c.name));
  const raised = db
    ? await loadSection("signer candidate money", async () => {
        const key = `ca-cand:${c.contest.id}:${nameSlug(c.name)}`;
        const r = await db.prepare("SELECT raised FROM state_money_cycles WHERE official_id = ? AND cycle = ?").bind(key, `${cycle - 1}-${cycle}`).first();
        return r ? r.raised : null;
      }, null)
    : null;
  const money = raised === FAILED ? "Couldn't load right now." : raised != null ? `${dollars(raised)} raised in ${cycle - 1}–${cycle}.` : "Not loaded for this period.";
  return `<details class="signer-more">
  <summary>About ${esc(c.name)}</summary>
  <div class="inset stack-xs">
    ${line("Race", esc(`Candidate for ${c.contest.office}`))}
    ${line("Party", esc(c.party || "None listed"))}
    ${line("Votes", `Not in this office: no votes on record. <a class="inline-link" href="${esc(href)}">Full record ›</a>`)}
    ${line("Money raised", `${esc(money)} <a class="inline-link" href="${esc(href)}#funding">Full record ›</a>`)}
    ${line("Net worth, as reported", `None on record. <a class="inline-link" href="${esc(href)}">Full record ›</a>`)}
  </div>
</details>`;
}

async function orgPanel(db, name, money, state) {
  const key = orgKey(name);
  const [irs, lobby] = db
    ? await Promise.all([
        loadSection("signer org IRS", () => db.prepare("SELECT ein, subsection FROM org_lookups WHERE name_key = ?").bind(`${key}|${state}`).first(), null),
        state === "CA"
          ? loadSection("signer org lobbying", async () => {
              const word = key.split(" ").sort((a, b) => b.length - a.length)[0] || key;
              const rows = (await db.prepare("SELECT employer_id, employer_name, period_end, amount, source_url FROM ca_lobby_reports WHERE employer_name LIKE ? LIMIT 400").bind(`%${word}%`).all()).results.filter((r) => orgKey(r.employer_name) === key);
              const ids = new Set(rows.map((r) => r.employer_id));
              return ids.size === 1 ? rows : [];
            }, [])
          : [],
      ])
    : [null, []];
  let type = "IRS record not looked up yet.";
  let more = null;
  if (irs === FAILED) type = "Couldn't load right now.";
  else if (irs && irs.ein) {
    type = `${irs.subsection != null ? `${SUBSECTIONS[irs.subsection] || `501(c)(${irs.subsection})`} tax-exempt organization` : "Tax-exempt organization"}, per its IRS record. ${sourceLink(nonprofitPage(irs.ein), "IRS record (ProPublica)")}`;
    more = nonprofitPage(irs.ein);
  } else if (irs) type = "No single IRS exempt-organization record under this exact name.";
  let lobbying = state === "CA" ? "No California lobbying reports under this exact name." : "Not loaded for this state.";
  if (lobby === FAILED) lobbying = "Couldn't load right now.";
  else if (lobby.length) {
    const years = [...new Set(lobby.map((r) => String(r.period_end).slice(0, 4)))].sort();
    const total = lobby.reduce((s, r) => s + (r.amount || 0), 0);
    lobbying = `${esc(dollars(total))} in total lobbying payments reported, ${esc(years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0])} (${lobby.length} ${lobby.length === 1 ? "report" : "reports"}). ${sourceLink(lobby[0].source_url, "Latest report")}`;
    more = more || lobby[0].source_url;
  }
  const o = money && money.orgs ? money.orgs[key] : null;
  const measures = o && (o.gave.length || o.spent.length)
    ? `<ul class="plain-list stack-xs">${[
        ...o.gave.map((g) => `<li>${esc(`Gave ${dollars(g.total)} to ${g.committee}, formed for ${propsList(g.props)}`)}. ${sourceLink(g.source_url, "Statement")}</li>`),
        ...o.spent.map((s) => `<li>${esc(`Spent ${dollars(s.total)} on its own ${s.side === "support" ? "supporting" : "opposing"} Prop. ${s.number}`)}. ${s.source_url ? sourceLink(s.source_url, "Filings") : ""}</li>`),
      ].join("")}</ul>`
    : money ? "None reported under this exact name on 2026 statewide measures." : "Not loaded for this state.";
  return `<details class="signer-more">
  <summary>About ${esc(name)}</summary>
  <div class="inset stack-xs">
    ${line("Type", type)}
    ${line("California lobbying", lobbying)}
    <div class="signer-fact"><p class="label">Spending on ballot measures</p>${/^<ul/.test(measures) ? measures.replace(/<li>/g, '<li class="small">') : `<p class="small">${esc(measures)}</p>`}</div>
    ${more && safeUrl(more) ? `<a class="inline-link" href="${esc(more)}" target="_blank" rel="noopener">More ›</a>` : ""}
  </div>
</details>`;
}

/**
 * One measure's signers: Map(signer key → {href, panel}) where key is "name|title".
 * Officials and candidates (a unique match, and a title naming an office) get a link
 * and a panel; organizations named in a title get a panel; everyone else nothing.
 */
export async function signerDetails(db, election, m, money, ctx) {
  const out = new Map();
  const orgDone = new Map();
  const st = election.election.state;
  for (const a of m.arguments || []) {
    for (const s of a.signers || []) {
      const k = `${s.name}|${s.title}`;
      if (out.has(k)) continue;
      const hit = ctx ? matchSigner(s, ctx.officials, ctx.candidates) : null;
      const org = orgFromTitle(s.title);
      const entry = { href: null, panel: "" };
      if (hit && hit.kind === "official") {
        entry.href = `/reps/${hit.o.slug}/`;
        entry.panel = db ? await officialPanel(db, hit.o) : "";
      } else if (hit && hit.kind === "candidate") {
        entry.href = stateCandidateHref(hit.c.contest.id, nameSlug(hit.c.name));
        entry.panel = await candidatePanel(db, hit.c);
      }
      if (org && !isGovernment(org)) {
        if (!orgDone.has(org)) orgDone.set(org, await orgPanel(db, org, money, st));
        entry.panel += orgDone.get(org);
      }
      out.set(k, entry);
    }
  }
  return out;
}
