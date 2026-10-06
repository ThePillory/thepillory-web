// /reps/            find your reps (address or ZIP), your reps once known, the
//                   governing bodies, and members of Congress by state (?state=CA)
// /reps/<slug>/     one official: Overview, Promises, Votes, Funding, Issues. The
//                   President adds Executive orders, Bills and Nominations (no
//                   Votes); the Governor adds Bills and Executive orders.
import { BODIES, LEVEL_NAME, EMPTY_REPORTS } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, kv, card, section, sourceLink, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { officialBySlug, officialsWhere, withVoteCounts, voteCounts, votesFor, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe, STATE_NAME } from "../_lib/districts.js";
import { lookupForm } from "../_lib/hub.js";
import { voteRow, voteFilter } from "../_lib/votes.js";
import { fundingFor, fundingTab } from "../_lib/funding.js";
import { executiveMoney, executiveFundingTab } from "../_lib/exec-funding.js";
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

async function profile(env, slug, url) {
  if (!env.DB) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  const db = env.DB;
  const o = await loadSection("official", () => officialBySlug(db, slug), undefined);
  if (o === undefined) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  if (o === FAILED) throw new Error(`official ${slug} couldn't load`);
  if (!o) return notFound("No current official at this address.", "reps", ["Reps", "/reps/"]);
  const all = url.searchParams.get("votes") === "all";
  const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const cycle = parseInt(url.searchParams.get("cycle") || "", 10) || currentCycle();
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const show = ["signed", "vetoed"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : "all";
  const status = url.searchParams.get("status") || "all";
  const exec = isExecutive(o);
  // Each tab loads on its own: one that can't load shows a short note there.
  const [countsLoaded, votes, funding, orders, bills, nominations] = await Promise.all([
    exec ? {} : loadSection("rep vote counts", () => voteCounts(db, o.id), {}),
    exec ? { rows: [], more: false } : loadSection("rep votes", () => votesFor(db, o.id, { all, limit: 50, offset: (pageNum - 1) * 50 }), { rows: [], more: false }),
    exec ? loadSection("rep funding", () => executiveMoney(db, o, cycle), null) : o.level === "federal" ? loadSection("rep funding", () => fundingFor(db, o, cycle), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep orders", () => ordersFor(db, o.id, { offset }), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep bills", () => billsActedOn(db, o.id, { show, offset }), null) : null,
    isPresident(o) ? loadSection("rep nominations", () => nominationsFor(db, o.id, { status, offset }), null) : null,
  ]);
  const partial = anyFailed(countsLoaded, votes, funding, orders, bills, nominations);
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

  // Reports and issues open with accounts; none exist yet.
  const issueHtml = EMPTY_REPORTS;

  const tab = (k, label, n) =>
    `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}${n != null ? `<span class="count">${n}</span>` : ""}</a>`;
  const main = `${head}
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs" role="tablist" aria-label="Sections">
    ${tab("overview", "Overview")}${
      isPresident(o)
        ? `${tab("orders", "Executive orders")}${tab("bills", "Bills")}${tab("nominations", "Nominations")}`
        : isGovernor(o) ? `${tab("bills", "Bills")}${tab("orders", "Executive orders")}` : ""
    }${tab("promises", "Promises")}${exec ? "" : tab("votes", "Votes", counts ? counts.total || 0 : null)}${tab("funding", "Funding")}${tab("issues", "Issues")}
  </nav>
  <div class="stack" role="tabpanel" id="overview" aria-labelledby="tab-overview">${overview}</div>
  <div class="stack" role="tabpanel" id="promises" aria-labelledby="tab-promises">
    <p class="secondary small">Promise tracking for real officials hasn't started. Promises will be added only with a source for each one.</p>
  </div>
  ${orders ? `<div class="stack" role="tabpanel" id="orders" aria-labelledby="tab-orders">${orders === FAILED ? sectionError("") : ordersTab(o, orders, base, offset)}</div>` : ""}
  ${bills ? `<div class="stack" role="tabpanel" id="bills" aria-labelledby="tab-bills">${bills === FAILED ? sectionError("") : billsTab(o, bills, base, show, offset)}</div>` : ""}
  ${nominations ? `<div class="stack" role="tabpanel" id="nominations" aria-labelledby="tab-nominations">${nominations === FAILED ? sectionError("") : nominationsTab(o, nominations, base, status, offset)}</div>` : ""}
  ${exec ? "" : `<div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">
    ${voteFilter(base, all, counts)}
    ${voteList}
  </div>`}
  <div class="stack" role="tabpanel" id="funding" aria-labelledby="tab-funding">${funding === FAILED ? sectionError("") : exec ? executiveFundingTab(o, funding, base) : fundingTab(o, funding, base)}</div>
  <div class="stack" role="tabpanel" id="issues" aria-labelledby="tab-issues">${issueHtml}</div>
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
    return edgeCached(context, REPS_CACHE_SECONDS, () => profile(context.env, parts[0], url));
  }
  return notFound("No page at this address.", "reps", ["Reps", "/reps/"]);
}, { tab: "reps" });
