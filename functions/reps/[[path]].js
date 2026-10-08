// /reps/            find your reps (address or ZIP), your reps once known, the
//                   governing bodies, and members of Congress by state (?state=CA)
// /reps/<slug>/     one official, five tabs for everyone: About · Promises ·
//                   Votes · Funding · More. The President and Governor: Votes is
//                   bills signed and vetoed; More holds executive orders (and the
//                   President's nominations) and disclosures. The Cabinet: Votes
//                   and Funding say they don't apply, linking to Disclosures in
//                   More. Everyone else: More holds committees and Issues.
import { BODIES, LEVEL_NAME, EMPTY_REPORTS } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, kv, card, section, sourceLink, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { officialBySlug, officialsWhere, withVoteCounts, voteCounts, votesFor, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe, STATE_NAME } from "../_lib/districts.js";
import { lookupForm } from "../_lib/hub.js";
import { voteRow, voteFilter } from "../_lib/votes.js";
import { fundingFor, fundingTab } from "../_lib/funding.js";
import { executiveMoney, executiveFundingParts, stateOfficialMoney, stateForm700 } from "../_lib/exec-funding.js";
import { stateFundingTab } from "../_lib/state-funding.js";
import { promisesFor, ownWordsFor, platformTab } from "../_lib/promises.js";
import { pickYear, yearBar, thisYear, FIRST_YEAR } from "../_lib/history.js";
import { officialPastYear } from "../_lib/history-pages.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";
import {
  isExecutive, isPresident, isGovernor, executiveOfficials, ordersFor, billsActedOn, nominationsFor,
  ordersTab, billsTab, nominationsTab, executiveRows,
} from "../_lib/executive.js";

const BODY = Object.fromEntries(BODIES.map((b) => [b.slug, b]));

function who(o) {
  // Party is plain text, identical styling for every party.
  return [o.office, o.district, o.party ? `Party: ${o.party}` : null].filter(Boolean).join(" · ");
}

function repCard(o) {
  const body = BODY[o.body];
  return card({
    href: `/reps/${o.slug}/`,
    label: `${LEVEL_NAME[o.level]} · ${CHAMBER_NAME[o.chamber]}`,
    title: o.name,
    who: who(o),
    chips: body ? body.chip_span : "",
    left: o.vote_count == null ? "" : `Votes recorded: <strong>${o.vote_count}</strong>`,
    right: `Verified: <strong>${fmtDate(o.last_verified)}</strong>`,
    level: o.level,
  });
}

function stateChips(current) {
  return Object.entries(STATE_NAME)
    .sort((x, y) => x[1].localeCompare(y[1]))
    .map(([code, name]) => `<a class="chip state-chip${code === current ? " is-current" : ""}" href="/reps/?state=${code}#browse"${code === current ? ' aria-current="true"' : ""}>${esc(name)}</a>`)
    .join("");
}

async function stateOfficials(db, st) {
  return withVoteCounts(
    db,
    (c) => `SELECT o.*${c.select} FROM officials o ${c.join}
       WHERE o.active = 1 AND o.state = ? AND o.chamber IN ('us-senate', 'us-house')
       ORDER BY o.chamber DESC, CAST(o.district_code AS INTEGER), o.name`,
    [st]
  );
}

async function list(env, url, request) {
  const d = districtsFromCookie(request);
  const st = STATE_NAME[String(url.searchParams.get("state") || "").toUpperCase()] ? String(url.searchParams.get("state")).toUpperCase() : null;
  if (!env.DB) return notLoaded("Reps", "reps", true);
  const db = env.DB;
  // Each section loads on its own: one that can't load shows a short note.
  const [mine, state, federalExec, caExec] = await Promise.all([
    d ? loadSection("reps mine", () => officialsWhere(db, repsWhere(d)), []) : [],
    st ? loadSection("reps state", () => stateOfficials(db, st), []) : [],
    loadSection("reps executive", () => executiveOfficials(db, "us-executive"), []),
    loadSection("reps california executive", () => executiveOfficials(db, "ca-executive"), []),
  ]);
  const data = { mine, state, federalExec, caExec };
  const mineHtml = d
    ? mine === FAILED ? sectionError("Your representatives") : `
<section class="stack" id="yours">
  <h2 class="label">Your representatives</h2>
  <p class="small secondary">${esc(describe(d))}</p>
  ${data.mine.map(repCard).join("") || '<p class="secondary small">None loaded yet for your districts. They appear after the data sync runs.</p>'}
  ${d.st !== "CA" ? '<p class="hint">State and local coverage comes as communities launch.</p>' : ""}
</section>`
    : "";

  const browse = st
    ? state === FAILED ? sectionError(`${STATE_NAME[st]}: members of Congress`) : `
<section class="stack" id="state-list">
  <h2 class="label">${esc(STATE_NAME[st])}: members of Congress</h2>
  ${data.state.map(repCard).join("") || '<p class="secondary small">None loaded yet.</p>'}
  ${st === "CA" ? '<a class="list-row link-row card" href="/bodies/state-legislature/"><div><div class="list-title">California State Legislature</div><div class="list-meta">All 120 members</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>' : ""}
</section>`
    : "";

  const main = `
<header class="page-head">
  <h1>Reps</h1>
  <p class="subtitle">The President and Cabinet, members of Congress, California's Governor, statewide officers and legislators, and Calaveras County supervisors, with the record they keep.</p>
</header>
${lookupForm(d, { heading: d ? "Change your location" : "Find your representatives" })}
${mineHtml}
<section class="stack" id="executive">
  <h2 class="label">Executive branch</h2>
  <div class="card">${federalExec === FAILED ? sectionError("") : executiveRows(data.federalExec) || '<p class="secondary small">The President, Vice President and Cabinet appear after the data sync runs.</p>'}</div>
  <h3 class="label">California's statewide offices</h3>
  <div class="card">${caExec === FAILED ? sectionError("") : executiveRows(data.caExec, { cabinetLink: false }) || '<p class="secondary small">California\'s Governor and statewide officers appear after the data sync runs.</p>'}</div>
</section>
<section class="stack">
  <h2 class="label">Governing bodies</h2>
  ${BODIES.map((b) => b.card).join("")}
</section>
<section class="card stack-sm" id="browse">
  <h2 class="label">Browse members of Congress by state</h2>
  <div class="chips">${stateChips(st)}</div>
</section>
${browse}
<p class="hint">Every official here is loaded from an official source, linked on their page, with the date it was last checked.</p>`;
  return page("Reps", main, { tab: "reps", root: true, personal: !!d, partial: anyFailed(mine, state, federalExec, caExec) });
}

// The executive's "Record at a glance": what's loaded, counted, never scored.
function execGlance(o, orders, bills, nominations) {
  if (!orders && !bills) {
    return `<section class="card stack-sm">
  <h2 class="label">Record</h2>
  <p class="small">${esc(o.office)}${o.chamber === "ca-executive" ? ", elected statewide" : o.rank === 2 ? ", elected with the President" : ", a member of the President's Cabinet"}. ThePillory tracks the President's and the Governor's executive orders and bill actions; other executive offices have no separate record here yet.</p>
</section>`;
  }
  const b = (bills && bills.counts) || {};
  const stats = [
    [orders ? (orders.counts.executive_order || 0) : null, "Executive orders"],
    [bills ? (b.signed || 0) + (b.without_signature || 0) + (b.became_law || 0) : null, "Bills became law"],
    [bills ? b.vetoed || 0 : null, "Vetoes"],
    [nominations ? Object.values(nominations.counts).reduce((s, n) => s + n, 0) : null, "Civilian nominations"],
  ].filter(([n]) => n != null);
  return `<section class="card stack">
  <h2 class="label">Record at a glance</h2>
  <div class="grid-2">${stats.map(([n, label]) => `<div class="stat"><div class="stat-num">${n}</div><div class="stat-label">${label}</div></div>`).join("")}</div>
  <p class="hint">Counts of what's loaded from official records. ThePillory doesn't score or grade officials.</p>
</section>`;
}

// The California legislative committees an official sits on (Open States,
// refreshed weekly by the state-hearings step).
async function committeesFor(db, officialId) {
  const { results } = await db
    .prepare(
      `SELECT name, chamber, source_url FROM state_committees
       WHERE EXISTS (SELECT 1 FROM json_each(member_ids) WHERE value = ?) ORDER BY name`
    )
    .bind(officialId)
    .all();
  return results;
}

// Which kind of office: decides what the Votes, Funding and More tabs hold.
function roleOf(o) {
  if (isPresident(o)) return "president";
  if (isGovernor(o)) return "governor";
  if (o.chamber === "us-executive") return o.rank === 2 ? "vice-president" : "appointed";
  if (o.chamber === "ca-executive") return "statewide";
  return "legislator";
}

async function profile(env, slug, url, request) {
  if (!env.DB) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  const db = env.DB;
  const o = await loadSection("official", () => officialBySlug(db, slug), undefined);
  if (o === undefined) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  if (o === FAILED) throw new Error(`official ${slug} couldn't load`);
  // The Time Machine: ?year= shows the official in that year. Past officeholders
  // (no longer in office) have pages only for the years they served.
  const year = pickYear(url);
  if (!o || year) {
    const any = await db.prepare("SELECT * FROM officials WHERE slug = ?").bind(slug).first();
    if (!any) return notFound("No official at this address.", "reps", ["Reps", "/reps/"]);
    if (year) return officialPastYear(env, request, url, any, year);
    const last = Math.max(FIRST_YEAR, Math.min(thisYear() - 1, (parseInt(String(any.term_end || "").slice(0, 4), 10) || thisYear()) - 1));
    return Response.redirect(`${url.origin}/reps/${any.slug}/?year=${last}`, 302);
  }
  const all = url.searchParams.get("votes") === "all";
  const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const cycle = parseInt(url.searchParams.get("cycle") || "", 10) || currentCycle();
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const show = ["signed", "vetoed"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : "all";
  const status = url.searchParams.get("status") || "all";
  const exec = isExecutive(o);
  const stateLegislator = o.chamber === "ca-assembly" || o.chamber === "ca-senate";
  // Each tab loads on its own: one that can't load shows a short note there.
  const loaded = await Promise.all([
    exec ? {} : loadSection("rep vote counts", () => voteCounts(db, o.id), {}),
    exec ? { rows: [], more: false } : loadSection("rep votes", () => votesFor(db, o.id, { all, limit: 50, offset: (pageNum - 1) * 50 }), { rows: [], more: false }),
    exec ? loadSection("rep funding", () => executiveMoney(db, o, cycle), null)
      : o.level === "federal" ? loadSection("rep funding", () => fundingFor(db, o, cycle), null)
      : stateLegislator ? loadSection("rep funding", () => stateOfficialMoney(db, o, cycle), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep orders", () => ordersFor(db, o.id, { offset }), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep bills", () => billsActedOn(db, o.id, { show, offset }), null) : null,
    isPresident(o) ? loadSection("rep nominations", () => nominationsFor(db, o.id, { status, offset }), null) : null,
    o.level === "state" && !exec ? loadSection("rep committees", () => committeesFor(db, o.id), []) : [],
    loadSection("rep promises", () => promisesFor(db, o.id), null),
    loadSection("rep own words", () => ownWordsFor(db, o.id), null),
  ]);
  const [countsLoaded, votes, funding, orders, bills, nominations, committees, promises, ownWords] = loaded;
  const partial = anyFailed(countsLoaded, votes, funding, orders, bills, nominations, committees, promises, ownWords);
  const counts = countsLoaded === FAILED ? null : countsLoaded || {};
  const ok = (v) => (v === FAILED ? null : v);

  const body = BODY[o.body];
  const photo = safeUrl(o.photo_url);
  const head = `
<header class="page-head rep-head">
  ${photo ? `<img class="rep-photo" src="${esc(photo)}" alt="Official photo of ${esc(o.name)}" width="72" height="88" loading="lazy" onerror="this.remove()" />` : ""}
  <div class="stack-sm">
    <p class="label">${LEVEL_NAME[o.level]} · ${CHAMBER_NAME[o.chamber]}</p>
    <h1>${esc(o.name)}</h1>
    <p class="secondary">${esc(who(o))}</p>
    ${body ? `<div class="chips">${body.chip}</div>` : ""}
  </div>
</header>`;

  const term =
    o.term_start && o.term_end ? `${esc(o.term_start)} to ${esc(o.term_end)}`
      : o.term_start ? `Since ${esc(o.term_start)}` : null;
  const overview = `
${section("Office", kv([
    ["Office", esc(o.office)],
    ["District", exec ? null : o.district ? esc(o.district) : "Statewide"],
    ["Party", o.party ? esc(o.party) : null],
    ["Term", term],
    ["Body", body ? `<a class="inline-link" href="/bodies/${esc(body.slug)}/">${esc(body.name)}</a>` : null],
    ["Website", safeUrl(o.website) ? `<a class="inline-link" href="${esc(o.website)}" target="_blank" rel="noopener">Official site ↗</a>` : null],
  ]), "card stack-sm")}
${yearBar(url, null, { label: `See ${o.name} in an earlier year` })}
<section class="card stack-sm">
  <h2 class="label">Source</h2>
  <p class="small">Last verified ${fmtDate(o.last_verified)}.</p>
  ${sourceLink(o.source_url, "Official source")}
  ${o.photo_credit ? `<p class="hint">Photo: ${esc(o.photo_credit)}</p>` : ""}
</section>
${exec ? execGlance(o, ok(orders), ok(bills), ok(nominations)) : !counts ? sectionError("Record at a glance") : `<section class="card stack">
  <h2 class="label">Record at a glance</h2>
  <div class="grid-2">
    <div class="stat"><div class="stat-num">${counts.final || 0}</div><div class="stat-label">Final-passage votes</div></div>
    <div class="stat"><div class="stat-num">${counts.total || 0}</div><div class="stat-label">All recorded votes</div></div>
  </div>
  <p class="hint">Counts of recorded votes only. ThePillory doesn't score or grade officials.</p>
</section>`}`;

  const base = `/reps/${o.slug}/`;
  const more = votes !== FAILED && votes.more
    ? `<a class="btn btn--block" href="${base}?${all ? "votes=all&" : ""}page=${pageNum + 1}#votes">Older votes</a>`
    : "";
  const voteList = votes === FAILED ? sectionError("") : votes.rows.length
    ? `<ul class="plain-list vote-list card">${votes.rows.map(voteRow).join("")}</ul>${more}`
    : `<p class="secondary small">${
        o.level === "county"
          ? "County votes aren't loaded yet."
          : all ? "No recorded votes yet." : "No final-passage votes recorded yet. Try “All votes”."
      }</p>`;

  // Five tabs for every official: About · Promises · Votes · Funding · More.
  // What Votes, Funding and More hold depends on the office (roleOf).
  const role = roleOf(o);
  const money = exec && funding !== FAILED ? executiveFundingParts(o, funding, base) : null;
  const sub = (id, label, html) => `<section class="stack-sm" id="${id}" aria-labelledby="h-${id}"><h2 class="label" id="h-${id}">${label}</h2>${html}</section>`;
  const appointedNote = (what) =>
    `<section class="card stack-sm"><p class="small">${what}</p><p class="small"><a class="inline-link" href="#disclosures">See financial disclosures and ethics agreements under More</a></p></section>`;

  let votesHtml;
  if (role === "president" || role === "governor") {
    votesHtml = `<p class="small secondary">The ${role === "president" ? "President" : "Governor"} doesn't vote on bills. Instead, the bills that passed are signed or vetoed:</p>
  <div class="stack" id="bills">${bills === FAILED ? sectionError("") : billsTab(o, bills, base, show, offset)}</div>`;
  } else if (role === "appointed") {
    votesHtml = appointedNote(`${esc(o.office)} is an appointed office, so there are no votes to show: votes are recorded for members of Congress and the California Legislature.`);
  } else if (exec) {
    votesHtml = '<p class="secondary small">No votes are recorded for this office. ThePillory records votes in Congress and the California Legislature.</p>';
  } else {
    votesHtml = `${voteFilter(base, all, counts)}
    ${voteList}`;
  }

  let fundingHtml;
  if (funding === FAILED) fundingHtml = sectionError("");
  else if (role === "appointed") fundingHtml = appointedNote(`${esc(o.office)} is an appointed office, so there's no campaign money to show: appointed officials don't run campaigns.`);
  else if (exec) fundingHtml = money.funding || '<p class="secondary small">No campaign money to show for this office.</p>';
  else if (stateLegislator) fundingHtml = stateFundingTab(o, funding && funding.money, base);
  else fundingHtml = fundingTab(o, funding, base);

  // More: everything else, in sections.
  const moreParts = [];
  if (orders) moreParts.push(sub("orders", "Executive orders", orders === FAILED ? sectionError("") : ordersTab(o, orders, base, offset)));
  if (nominations) moreParts.push(sub("nominations", "Nominations", nominations === FAILED ? sectionError("") : nominationsTab(o, nominations, base, status, offset)));
  if (exec) moreParts.push(sub("more-disclosures", "Disclosures", funding === FAILED ? sectionError("") : money.disclosures));
  if (stateLegislator) moreParts.push(sub("more-disclosures", "Disclosures", funding === FAILED ? sectionError("") : funding ? stateForm700(funding) : ""));
  if (o.level === "state" && !exec) {
    moreParts.push(sub("committees", "Committees", committees === FAILED ? sectionError("") : committees.length
      ? `<div class="card"><ul class="plain-list">${committees.map((c) => `<li class="list-row"><span class="list-title">${esc(c.name)}</span><span class="row-end">${sourceLink(c.source_url)}</span></li>`).join("")}</ul></div><p class="hint">From Open States, refreshed weekly.</p>`
      : '<p class="secondary small">No committee assignments loaded for this legislator.</p>'));
  }
  // Reports and issues open with accounts; none exist yet.
  moreParts.push(sub("issues", "Issues", EMPTY_REPORTS));

  const tab = (k, label) => `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}</a>`;
  const main = `${head}
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs tabs--five" role="tablist" aria-label="Sections">
    ${tab("about", "About")}${tab("platform", "Platform")}${tab("votes", "Votes")}${tab("funding", "Funding")}${tab("more", "More")}
  </nav>
  <div class="stack" role="tabpanel" id="about" aria-labelledby="tab-about">${overview}</div>
  <div class="stack" role="tabpanel" id="platform" aria-labelledby="tab-platform">${promises === FAILED || ownWords === FAILED ? sectionError("") : platformTab(o, promises, ownWords)}</div>
  <div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">${votesHtml}</div>
  <div class="stack" role="tabpanel" id="funding" aria-labelledby="tab-funding">${fundingHtml}</div>
  <div class="stack" role="tabpanel" id="more" aria-labelledby="tab-more">${moreParts.join("")}</div>
</div>`;
  return page(o.name, main, { tab: "reps", back: ["Reps", "/reps/"], partial });
}

// A rep's page is the same for every visitor: kept at the edge for a few
// minutes. The Reps list is too, for visitors without saved districts.
const REPS_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) {
    if (districtsFromCookie(context.request)) return list(context.env, url, context.request);
    return edgeCached(context, REPS_CACHE_SECONDS, () => list(context.env, url, context.request));
  }
  if (parts.length === 1) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return edgeCached(context, REPS_CACHE_SECONDS, () => profile(context.env, parts[0], url, context.request));
  }
  return notFound("No page at this address.", "reps", ["Reps", "/reps/"]);
}, { tab: "reps" });
