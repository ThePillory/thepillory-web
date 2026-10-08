// Elections, from official sources only (functions/_lib/elections.js, and
// data/elections/<id>.json built by tools/build_elections.py):
//
//   /elections/                          upcoming elections, How to vote, Your ballot
//   /elections/<id>/                     everything on the ballot, statewide and by district
//   /elections/<id>/ballot/              Your ballot (the visitor's districts; private)
//   /elections/<id>/contest/<contest>/   one contest: candidates in ballot order, the same
//                                        layout for each; or a court's retention questions
//   /elections/<id>/measure/<measure>/   one measure: official title and summary, the
//                                        arguments word for word with their authors
//
// Neutral by design: candidates and measures all get the same layout, in ballot
// order; no endorsements, polls or predictions; results only from the official
// feed, only after the polls close, and no race is called.
import { page, esc, notFound, safeUrl, sourceLink, fmtDate, kv, loadSection, FAILED, sectionError, guard, edgeCached } from "../_lib/render.js";
import { districtsFromCookie, describe, STATE_NAME } from "../_lib/districts.js";
import { loadPlace } from "../_lib/geo.js";
import { lookupForm } from "../_lib/hub.js";
import {
  ELECTIONS, CURRENT, loadElection, electionHref, contestHref, measureHref, ballotHref,
  ballotOrder, ballotFor, courtGroups, scopeLabel, contestTitle,
  officeholders, holderFor, pollsClosed, sosResults, candidateResults, measureResult, resultsBlock,
  whenLine, howToVote, contestRow, measureRow, courtRow,
} from "../_lib/elections.js";
import { pacificNow } from "../_lib/meetings.js";
import { fold } from "../_lib/summary.js";

const BACK = ["Elections", "/elections/"];
const NEUTRAL = "Every candidate and measure is shown the same way, in ballot order, with what the official sources print. ThePillory doesn't endorse candidates or measures, and doesn't publish polls or predictions.";
const STATE_ELECTION_OFFICES = "https://www.usa.gov/state-election-office";

const cacheSeconds = (election) => (election && pollsClosed(election) ? 120 : 300);

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const [id, kind, item, extra] = (params.path || []).filter(Boolean);
  if (!id) return edgeCached(context, 300, () => indexPage(env, request));
  if (!ELECTIONS.includes(id) || extra) return notFound("No election at this address.", "home", BACK);
  const election = await loadElection(env, request, id);
  if (!election) return notFound("This election's data isn't loaded yet.", "home", BACK);
  if (!kind) return edgeCached(context, cacheSeconds(election), () => electionPage(election));
  if (kind === "ballot" && !item) return ballotPage(env, request, election);
  if (kind === "contest" && item) return edgeCached(context, cacheSeconds(election), () => contestPage(env, election, item));
  if (kind === "measure" && item) return edgeCached(context, cacheSeconds(election), () => measurePage(election, item));
  return notFound("No page at this address.", "home", [election.election.name, electionHref(id)]);
}, { tab: "home" });

const today = () => pacificNow().slice(0, 10);

// ---------------------------------------------------------------------------
// /elections/

async function indexPage(env, request) {
  const items = (await Promise.all(ELECTIONS.map((id) => loadElection(env, request, id)))).filter(Boolean);
  const current = items[0];
  const cards = items
    .map((e) => `
<a class="card stack-xs" href="${electionHref(e.election.id)}">
  <p class="label">${esc(STATE_NAME[e.election.state])}</p>
  <h3>${esc(e.election.name)}</h3>
  <p class="small secondary">${esc(whenLine(e, today()))} · ${e.contests.filter((c) => c.scope !== "judicial").length} contests and ${e.measures.length} measures</p>
  <span class="inline-link">What's on the ballot</span>
</a>`)
    .join("");
  const main = `
<header class="page-head stack-xs">
  <h1>Elections</h1>
  <p class="subtitle">What's on the ballot, from official sources: the Secretary of State, county elections offices and the FEC.</p>
</header>
<section class="stack-sm" aria-labelledby="h-up"><h2 class="label" id="h-up">Upcoming</h2>${cards || '<p class="small secondary">No upcoming elections loaded yet.</p>'}</section>
<a class="card briefing-link" href="${ballotHref(CURRENT)}"><span class="stack-xs"><span class="label">Your ballot</span><span class="small">The contests and measures for your address</span></span><span class="chev" aria-hidden="true">›</span></a>
${current ? howToVote(current) : ""}
<section class="card stack-xs">
  <p class="small">ThePillory has California's ballot so far. For elections in other states, find your state's election office at <a class="inline-link" href="${STATE_ELECTION_OFFICES}" target="_blank" rel="noopener">USA.gov ↗</a>.</p>
</section>
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>`;
  return page("Elections", main, { tab: "home" });
}

// ---------------------------------------------------------------------------
// /elections/<id>/

function electionPage(election) {
  const id = election.election.id;
  const by = (scope) => election.contests.filter((c) => c.scope === scope).sort((a, b) => Number(a.district) - Number(b.district));
  const chips = (list, label) => `<ul class="plain-list district-grid">${list.map((c) => `<li><a class="chip chip--tap" href="${contestHref(id, c.id)}" aria-label="${esc(label)} ${esc(c.district)}">${esc(c.district)}</a></li>`).join("")}</ul>`;
  const courts = courtGroups(election.contests);
  const counties = Object.entries(election.counties || {});
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(STATE_NAME[election.election.state])}</p>
  <h1>${esc(election.election.name)}</h1>
  <p class="subtitle">${esc(whenLine(election, today()))}</p>
</header>
<a class="card briefing-link" href="${ballotHref(id)}"><span class="stack-xs"><span class="label">Your ballot</span><span class="small">The contests and measures for your address</span></span><span class="chev" aria-hidden="true">›</span></a>
<section class="stack-sm" aria-labelledby="h-sw"><h2 class="label" id="h-sw">Statewide offices</h2>
  <div class="card">${by("statewide").map((c) => contestRow(id, c)).join("")}</div>
</section>
<section class="stack-sm" aria-labelledby="h-props"><h2 class="label" id="h-props">Statewide propositions</h2>
  <div class="card">${election.measures.filter((m) => m.scope === "statewide").map((m) => measureRow(id, m)).join("")}</div>
</section>
<section class="stack-sm" aria-labelledby="h-dist"><h2 class="label" id="h-dist">By district</h2>
  <div class="card stack-sm">
    <p class="small"><strong>U.S. House</strong> · congressional district</p>${chips(by("cd"), "Congressional District")}
    <p class="small"><strong>State Senate</strong> · senate district</p>${chips(by("sldu"), "State Senate District")}
    <p class="small"><strong>State Assembly</strong> · assembly district</p>${chips(by("sldl"), "Assembly District")}
    <p class="small"><strong>Board of Equalization</strong> · district</p>${chips(by("boe"), "Board of Equalization District")}
    <p class="hint">Not sure of your districts? <a class="inline-link" href="${ballotHref(id)}">Find your ballot</a> by address or ZIP code.</p>
  </div>
</section>
<section class="stack-sm" aria-labelledby="h-courts"><h2 class="label" id="h-courts">Courts</h2>
  <div class="card">${courts.map((g) => courtRow(id, g)).join("")}</div>
</section>
${counties.length ? `<section class="stack-sm" aria-labelledby="h-local"><h2 class="label" id="h-local">Local contests and measures</h2>
  ${counties.map(([fips, cty]) => `<div class="card stack-xs"><p class="label">${esc(cty.name)}</p>${election.contests.filter((c) => c.scope === "county" && c.county === fips).map((c) => contestRow(id, c)).join("")}${election.measures.filter((m) => m.scope === "county" && m.county === fips).map((m) => measureRow(id, m)).join("")}</div>`).join("")}
  <p class="hint">Local contests are listed for counties where ThePillory is live. Other counties' are on their elections office's website and sample ballot.</p>
</section>` : ""}
${howToVote(election)}
${sources(election)}
<p class="hint">${esc(NEUTRAL)}</p>`;
  return page(election.election.name, main, { tab: "home", back: BACK });
}

function sources(election) {
  const e = election.election;
  const links = [
    [e.certified_list, "Certified List of Candidates (Secretary of State)"],
    [e.guide, "Official Voter Information Guide (Secretary of State)"],
    [e.alphabet_source, "Randomized alphabet for ballot order (Secretary of State)"],
    ...Object.values(election.counties || {}).flatMap((c) => [[c.elections_page, `${c.name} Elections: candidates and measures`], [c.pamphlet_pdf, `${c.name} Voter Information Pamphlet (PDF)`]]),
  ];
  return `<section class="stack-sm" aria-labelledby="h-src"><h2 class="label" id="h-src">Sources</h2><div class="card stack-xs">${links
    .filter(([u]) => safeUrl(u))
    .map(([u, l]) => `<p class="small">${sourceLink(u, l)}</p>`)
    .join("")}</div></section>`;
}

// ---------------------------------------------------------------------------
// /elections/<id>/ballot/   (the visitor's districts, from their own browser)

async function countyName(env, request, fips) {
  if (!fips) return null;
  const place = await loadPlace(env, request, "ca");
  const c = place && place.counties.find((x) => x.fips === fips);
  return c ? c.name : null;
}

function ballotSections(election, b, { ad = null, countyLabel = null } = {}) {
  const id = election.election.id;
  const rows = b.contests.map((c) => contestRow(id, c, c.scope === "statewide" && ad ? `order for Assembly District ${ad}` : ""));
  return `
<section class="stack-sm" aria-labelledby="h-yc"><h2 class="label" id="h-yc">Contests</h2>
  <div class="card">${rows.join("")}${b.courts.map((g) => courtRow(id, g)).join("")}</div>
  ${b.boeKnown ? "" : '<p class="hint">Board of Equalization: your district is on your sample ballot. <a class="inline-link" href="' + electionHref(id) + '#h-dist">All four districts</a>.</p>'}
</section>
<section class="stack-sm" aria-labelledby="h-ym"><h2 class="label" id="h-ym">Statewide propositions</h2>
  <div class="card">${b.measures.map((m) => measureRow(id, m)).join("")}</div>
</section>
${b.partial.length || b.partialMeasures.length ? `<section class="stack-sm" aria-labelledby="h-yl"><h2 class="label" id="h-yl">Local, on some ballots in ${esc(countyLabel || "your county")}</h2>
  <div class="card">${b.partial.map((c) => contestRow(id, c)).join("")}${b.partialMeasures.map((m) => measureRow(id, m, "on ballots in this district")).join("")}</div>
  <p class="hint">Each is for part of the county (a supervisor district, a city, or a school, fire or water district). Your sample ballot shows which are yours.</p>
</section>` : ""}`;
}

async function ballotPage(env, request, election) {
  const d = districtsFromCookie(request);
  const id = election.election.id;
  const head = `
<header class="page-head stack-xs">
  <p class="label">${esc(election.election.name)}</p>
  <h1>Your ballot</h1>
  ${d ? `<p class="subtitle">${esc(describe(d))}</p>` : ""}
</header>`;
  if (!d) {
    const main = `${head}
<p>Enter your address or ZIP code to see the contests and measures on your ballot. Only your district numbers are kept, in your browser.</p>
${lookupForm(null, { id: "find", heading: "Find your ballot", next: ballotHref(id) })}
<p class="small"><a class="inline-link" href="${electionHref(id)}">Browse everything on the ballot</a></p>
${howToVote(election)}`;
    return page("Your ballot", main, { tab: "home", back: [election.election.name, electionHref(id)], personal: true });
  }
  if (d.st !== election.election.state) {
    const main = `${head}
<section class="card stack-sm">
  <p>ThePillory has California's ballot so far. For elections in ${esc(STATE_NAME[d.st])}, find your state's election office at <a class="inline-link" href="${STATE_ELECTION_OFFICES}" target="_blank" rel="noopener">USA.gov ↗</a>.</p>
</section>
${lookupForm(d, { id: "find", heading: "Use a different address", next: ballotHref(id) })}`;
    return page("Your ballot", main, { tab: "home", back: [election.election.name, electionHref(id)], personal: true });
  }
  const cName = await loadSection("ballot county", () => countyName(env, request, d.co), null);
  const name = cName === FAILED ? null : cName;
  const b = ballotFor(election, d, name);
  const main = `${head}
${ballotSections(election, b, { ad: d.sl, countyLabel: name })}
<p class="hint">Built from your district numbers. Your official sample ballot, mailed by your county, is the final word on what's on your ballot.</p>
${lookupForm(d, { id: "find", heading: "Use a different address", next: ballotHref(id) })}
${howToVote(election, d.co)}
<p class="hint">${esc(NEUTRAL)}</p>`;
  return page("Your ballot", main, { tab: "home", back: [election.election.name, electionHref(id)], personal: true });
}

// ---------------------------------------------------------------------------
// /elections/<id>/contest/<contest>/

const PARTISAN = new Set(["statewide", "cd", "sldu", "sldl", "boe"]);

function statementBlock(cand, contest, coverage) {
  const s = cand.statement;
  if (!s) return `<p class="small secondary">${esc(coverage)}</p>`;
  return `
<details class="cand-statement">
  <summary>Candidate statement</summary>
  <div class="statement-body stack-xs">
    ${(s.header || []).map((h) => `<p class="small secondary">${esc(h)}</p>`).join("")}
    ${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
    <p class="hint">Written by the candidate, printed word for word in the ${esc(s.source)}${s.note ? `. ${esc(s.note)}` : ""} ${sourceLink(s.source_url, "Source")}</p>
  </div>
</details>`;
}

/** Where statements for this contest come from, said the same way for every candidate without one. */
function statementCoverage(contest, election) {
  if (contest.scope === "statewide") return "No candidate statement in the state Official Voter Information Guide.";
  const fromCounty = contest.candidates.some((c) => c.statement && /Pamphlet/.test(c.statement.source));
  const county = Object.values(election.counties || {})[0];
  if (contest.scope === "county" || fromCounty) return `No candidate statement in the ${county ? county.name : "county"} Voter Information Pamphlet.`;
  return "Candidate statements for this office are printed in each county's voter information pamphlet. ThePillory has them for counties where it's live.";
}

function candidateCard(cand, contest, election, holder, coverage) {
  const rows = [["Ballot designation", esc(cand.designation || "None given")]];
  if (PARTISAN.has(contest.scope)) rows.push(["Party preference", esc(cand.party || "None listed")]);
  if (contest.scope === "cd") rows.push(["FEC filing", cand.fec && safeUrl(cand.fec.url) ? sourceLink(cand.fec.url, cand.fec.id) : "Not matched by name"]);
  const hold = holder
    ? `<div class="stack-xs holds-office"><p class="small">Holds office now: <strong>${esc([holder.office, holder.district].filter(Boolean).join(", "))}</strong></p><p class="small cand-links"><a class="inline-link" href="/reps/${esc(holder.slug)}/#platform">Platform</a> · <a class="inline-link" href="/reps/${esc(holder.slug)}/#votes">Votes</a> · <a class="inline-link" href="/reps/${esc(holder.slug)}/#funding">Funding</a></p></div>`
    : "";
  return `
<article class="card stack-sm cand-card">
  <h3 class="cand-name">${esc(cand.name)}</h3>
  ${kv(rows)}
  ${hold}
  ${statementBlock(cand, contest, coverage)}
</article>`;
}

async function contestPage(env, election, contestId) {
  const id = election.election.id;
  const back = [election.election.name, electionHref(id)];
  const group = courtGroups(election.contests).find((g) => g.id === contestId);
  if (group) return courtPage(election, group);
  const contest = election.contests.find((c) => c.id === contestId && c.scope !== "judicial");
  if (!contest) return notFound("No contest at this address.", "home", back);
  const county = contest.county ? election.counties[contest.county] : null;
  const { candidates, note } = ballotOrder(contest, election, { countyName: county && county.name });
  const [holders, feed] = await Promise.all([
    loadSection("election officeholders", () => officeholders(env.DB, election.election.state), []),
    contest.results_path ? loadSection("election results", () => sosResults(election, contest.results_path), null) : null,
  ]);
  const coverage = statementCoverage(contest, election);
  const cards = candidates.map((c) => candidateCard(c, contest, election, holders === FAILED ? null : holderFor(c, holders), coverage)).join("");
  const closed = pollsClosed(election);
  const results = !closed
    ? `<p class="small secondary">Results appear here after the polls close at 8 p.m. on Election Day.</p>`
    : feed === FAILED
      ? sectionError("Results")
      : feed
        ? resultsBlock(feed, candidateResults(feed, candidates), election, { pathLink: election.election.results_page })
        : contest.results_url
          ? `<p class="small">Results: ${sourceLink(contest.results_url, `${county ? county.name : "County"} Elections, current results`)}</p>`
          : `<p class="small">Results: ${sourceLink(election.election.results_page, "Secretary of State results")}</p>`;
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc([contest.scope === "county" ? (county ? county.name : "Local") : scopeLabel(contest), fmtDate(election.election.date)].filter(Boolean).join(" · "))}</p>
  <h1>${esc(contestTitle(contest))}</h1>
  <p class="subtitle">Vote for ${esc(contest.vote_for || 1)} · ${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}</p>
</header>
${contest.scope === "county" ? `<p class="small secondary">On some ballots in ${esc(county ? county.name : "the county")}: this office is for part of the county. Candidates' names are as the county's list prints them.</p>` : ""}
<section class="stack-sm" aria-labelledby="h-cands">
  <h2 class="label" id="h-cands">Candidates, in ballot order</h2>
  <p class="hint">${esc(note)}</p>
  ${cards}
</section>
<section class="stack-sm" aria-labelledby="h-res"><h2 class="label" id="h-res">Results</h2>${results}</section>
<section class="stack-sm" aria-labelledby="h-src"><h2 class="label" id="h-src">Sources</h2>
  <div class="card stack-xs">
    <p class="small">${sourceLink(contest.source_url, contest.source)}</p>
    ${contest.scope === "statewide" ? `<p class="small">${sourceLink(election.election.guide, "Official Voter Information Guide")}</p>` : ""}
    <p class="small">${sourceLink(election.election.alphabet_source, "Randomized alphabet (ballot order)")}</p>
    ${county ? `<p class="small">${sourceLink(county.elections_page, `${county.name} Elections: candidates and measures`)}</p>` : ""}
  </div>
</section>
<p class="hint">${esc(NEUTRAL)} Officeholders are matched by name to the officials ThePillory follows.</p>`;
  return page(contestTitle(contest), main, { tab: "home", back, partial: holders === FAILED || feed === FAILED });
}

function courtPage(election, g) {
  const id = election.election.id;
  const cards = g.questions
    .map((q) => `
<article class="card stack-sm cand-card">
  <p class="label">${esc(q.office)}</p>
  <h3 class="cand-name">${esc(q.question)}</h3>
  <p class="small secondary">Yes or No</p>
</article>`)
    .join("");
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(fmtDate(election.election.date))}</p>
  <h1>${esc(g.name)}</h1>
  <p class="subtitle">${g.court === "supreme" ? "On every ballot in California" : `On ballots in ${esc(g.counties.join(", "))} counties`}</p>
</header>
<section class="stack-sm" aria-labelledby="h-q">
  <h2 class="label" id="h-q">On the ballot, as the certified list words it</h2>
  ${cards}
</section>
<section class="stack-sm" aria-labelledby="h-res"><h2 class="label" id="h-res">Results</h2>
  ${pollsClosed(election) ? `<p class="small">Results: ${sourceLink(election.election.results_page, "Secretary of State results")}</p>` : '<p class="small secondary">Results appear after the polls close at 8 p.m. on Election Day.</p>'}
</section>
<section class="stack-sm" aria-labelledby="h-src"><h2 class="label" id="h-src">Source</h2>
  <div class="card"><p class="small">${sourceLink(election.election.certified_list, "Certified List of Candidates (Secretary of State)")}</p></div>
</section>
<p class="hint">${esc(NEUTRAL)}</p>`;
  return page(g.name, main, { tab: "home", back: [election.election.name, electionHref(id)] });
}

// ---------------------------------------------------------------------------
// /elections/<id>/measure/<measure>/

// The campaign arguments, as the official guide prints them: the argument in
// favor and the opponents' rebuttal to it, then the argument against and the
// supporters' rebuttal to it. A rebuttal is written by the other side.
const ARG_PARTS = [
  { kind: "for", label: "Supporters' argument" },
  { kind: "rebuttal_against", label: "Opponents' rebuttal" },
  { kind: "against", label: "Opponents' argument" },
  { kind: "rebuttal_for", label: "Supporters' rebuttal" },
];
export const ARGUMENTS_NOTE = "Written by each campaign, printed word for word from the official voter guide. Not written or checked by ThePillory or any government agency.";

/** One argument or rebuttal, the same layout for every side: label, the guide's heading, the full text, who signed it. */
function argumentPart(part, a) {
  if (!a) {
    return `<article class="card stack-sm argument-card">
  <p class="label">${esc(part.label)}</p>
  <p class="small secondary">None printed in the official guide.</p>
</article>`;
  }
  const signers = a.signers.length
    ? `<div class="stack-xs"><p class="label">Signed by</p><ul class="plain-list signer-list">${a.signers.map((s) => `<li class="small"><strong>${esc(s.name)}</strong>${s.title ? `, ${esc(s.title)}` : ""}</li>`).join("")}</ul></div>`
    : "";
  return `<article class="card stack-sm argument-card">
  <p class="label">${esc(part.label)}</p>
  <h3 class="statement-title">${esc(a.heading)}</h3>
  ${a.none_submitted ? `<p class="small secondary">${esc(a.none_submitted)}</p>` : `<div class="statement-body stack-xs">${a.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`}
  ${signers}
</article>`;
}

/** Both exchanges in matching panels, in the guide's order, collapsed until opened. */
function argumentsSection(m, source) {
  const by = (kind) => m.arguments.find((a) => a.kind === kind) || null;
  const exchange = (title, parts) => `<div class="stack-sm argument-side">
  <h3 class="label">${esc(title)}</h3>
  ${parts.map((part) => argumentPart(part, by(part.kind))).join("")}
</div>`;
  const inner = `<p class="banner argument-note">${esc(ARGUMENTS_NOTE)}</p>
<div class="argument-sides">
  ${exchange("The argument for, and the opponents' rebuttal", ARG_PARTS.slice(0, 2))}
  ${exchange("The argument against, and the supporters' rebuttal", ARG_PARTS.slice(2))}
</div>
${source ? `<p class="small">${source}</p>` : ""}`;
  return fold("arguments", "Arguments from each campaign", inner);
}

async function measurePage(election, measureId) {
  const id = election.election.id;
  const back = [election.election.name, electionHref(id)];
  const m = election.measures.find((x) => x.id === measureId);
  if (!m) return notFound("No measure at this address.", "home", back);
  const statewide = m.scope === "statewide";
  const county = m.county ? election.counties[m.county] : null;
  const feed = statewide ? await loadSection("measure results", () => sosResults(election, m.results_path), null) : null;
  const r = feed && feed !== FAILED ? measureResult(feed, m.results_number) : null;
  const results = !pollsClosed(election)
    ? '<p class="small secondary">Results appear here after the polls close at 8 p.m. on Election Day.</p>'
    : feed === FAILED
      ? sectionError("Results")
      : r
        ? `<div class="results stack-sm"><p class="label">Results so far</p><ul class="plain-list results-list"><li class="result-row"><span class="result-name">Yes</span><span class="result-num">${r.yes == null ? "—" : r.yes.toLocaleString("en-US")} votes · ${esc(r.yesPercent)}%</span></li><li class="result-row"><span class="result-name">No</span><span class="result-num">${r.no == null ? "—" : r.no.toLocaleString("en-US")} votes · ${esc(r.noPercent)}%</span></li></ul><p class="hint">${esc(feed.Reporting || "")}${feed.ReportingTime ? ` · as of ${esc(feed.ReportingTime)}` : ""}. Counting continues after Election Day until each county certifies its results. ${sourceLink(election.election.results_page, "Secretary of State results")}</p></div>`
        : `<p class="small">Results: ${sourceLink(m.results_url || election.election.results_page, county ? `${county.name} Elections, current results` : "Secretary of State results")}</p>`;
  const list = (items) => (items.length > 1 ? `<ul class="plain-list bullet-list">${items.map((x) => `<li class="small">${esc(x)}</li>`).join("")}</ul>` : items.map((x) => `<p class="small">${esc(x)}</p>`).join(""));
  const official = statewide
    ? `
<section class="card stack-sm" aria-labelledby="h-ts">
  <h2 class="label" id="h-ts">Official title and summary · Prepared by the Attorney General</h2>
  <p class="measure-title">${esc(m.title)}</p>
  ${m.ag_summary && m.ag_summary.length ? list(m.ag_summary) : `<p class="small secondary">The summary couldn't be read from the guide. ${sourceLink(m.links.guide, "Read it in the official guide")}</p>`}
</section>
<section class="stack-sm" aria-labelledby="h-means"><h2 class="label" id="h-means">What your vote means</h2>
  <div class="vote-means">
    <div class="card stack-xs"><p class="vote-means-head">Yes</p><p class="small">${esc((m.yes_means || "").replace(/^A YES vote on this measure means:\s*/, "")) || "Not found in the guide."}</p></div>
    <div class="card stack-xs"><p class="vote-means-head">No</p><p class="small">${esc((m.no_means || "").replace(/^A NO vote on this measure means:\s*/, "")) || "Not found in the guide."}</p></div>
  </div>
  <p class="hint">As the official guide states it.</p>
</section>
<section class="card stack-sm" aria-labelledby="h-fiscal">
  <h2 class="label" id="h-fiscal">Fiscal effect · Legislative Analyst's estimate</h2>
  ${m.fiscal_effect && m.fiscal_effect.length ? list(m.fiscal_effect) : '<p class="small secondary">Not found in the guide.</p>'}
  <p class="hint">The summary of the Legislative Analyst's estimate of the net state and local government fiscal impact, from the official title and summary. ${sourceLink(m.links.analysis, "The full analysis by the Legislative Analyst")}</p>
</section>`
    : `
<section class="card stack-sm">
  <p class="label">The question on the ballot</p>
  <p class="measure-title">${esc(m.question || "Not found in the pamphlet; see the PDF.")}</p>
</section>
<section class="stack-sm" aria-labelledby="h-ia"><h2 class="label" id="h-ia">Impartial analysis by ${esc(m.impartial_analysis_by)}</h2>
  <div class="card statement-body stack-xs">${m.impartial_analysis.map((p) => `<p class="small">${esc(p)}</p>`).join("")}</div>
</section>
${m.tax_rate_statement && m.tax_rate_statement.length ? `<section class="stack-sm" aria-labelledby="h-trs"><h2 class="label" id="h-trs">Tax rate statement</h2>
  <details class="card cand-statement"><summary>Read the tax rate statement</summary><div class="statement-body stack-xs">${m.tax_rate_statement.map((p) => `<p class="small">${esc(p)}</p>`).join("")}</div></details>
</section>` : ""}`;
  const links = statewide
    ? [[m.links.guide, "This proposition in the Official Voter Information Guide"], [m.links.title_summary, "Official title and summary"], [m.links.analysis, "Analysis by the Legislative Analyst"], [m.links.arguments, "Arguments and rebuttals"], [m.links.text, "Text of the proposed law (PDF)"]]
    : [[m.links.pamphlet, `${county ? county.name : "County"} Voter Information Pamphlet (PDF), the official version`], [m.links.page, `${county ? county.name : "County"} Elections: candidates and measures`]];
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(statewide ? `Statewide · ${fmtDate(election.election.date)}` : `${m.jurisdiction || (county ? county.name : "Local")} · ${fmtDate(election.election.date)}`)}</p>
  <h1>${esc(statewide ? `Proposition ${m.number}` : m.title)}</h1>
  ${statewide ? "" : `<p class="small secondary">On ballots in ${esc(m.jurisdiction || "part of the county")}${county ? `, ${esc(county.name)}` : ""}.</p>`}
</header>
${official}
<section class="stack-sm" aria-labelledby="h-res"><h2 class="label" id="h-res">Results</h2>${results}</section>
${argumentsSection(m, statewide ? sourceLink(m.links.arguments, "Arguments and rebuttals in the official guide") : sourceLink(m.links.pamphlet, "Arguments in the county's Voter Information Pamphlet (PDF)"))}
<section class="stack-sm" aria-labelledby="h-src"><h2 class="label" id="h-src">Official sources</h2>
  <div class="card stack-xs">${links.filter(([u]) => safeUrl(u)).map(([u, l]) => `<p class="small">${sourceLink(u, l)}</p>`).join("")}</div>
  ${m.note ? `<p class="hint">${esc(m.note)}</p>` : ""}
</section>
<p class="hint">${esc(NEUTRAL)}</p>`;
  return page(statewide ? `Proposition ${m.number}` : m.title, main, { tab: "home", back, partial: feed === FAILED });
}

