// /reps/            find your reps (address or ZIP), your reps once known, the
//                   governing bodies, and members of Congress by state (?state=CA)
// /reps/<slug>/     one official: Overview, Promises, Votes, Funding, Issues
import { BODIES, LEVEL_NAME, EMPTY_REPORTS } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, kv, card, section, sourceLink, fmtDate } from "../_lib/render.js";
import { safe, officialBySlug, officialsWhere, voteCounts, votesFor, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe, STATE_NAME } from "../_lib/districts.js";
import { lookupForm } from "../_lib/hub.js";
import { voteRow, voteFilter } from "../_lib/votes.js";
import { fundingFor, fundingTab } from "../_lib/funding.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";

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
    left: `Votes recorded: <strong>${o.vote_count || 0}</strong>`,
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
  const { results } = await db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM vote_positions p WHERE p.official_id = o.id) AS vote_count
       FROM officials o WHERE o.active = 1 AND o.state = ? AND o.chamber IN ('us-senate', 'us-house')
       ORDER BY o.chamber DESC, CAST(o.district_code AS INTEGER), o.name`
    )
    .bind(st)
    .all();
  return results;
}

async function list(env, url, request) {
  const d = districtsFromCookie(request);
  const st = STATE_NAME[String(url.searchParams.get("state") || "").toUpperCase()] ? String(url.searchParams.get("state")).toUpperCase() : null;
  const data = await safe(env, async (db) => ({
    mine: d ? await officialsWhere(db, repsWhere(d)) : [],
    state: st ? await stateOfficials(db, st) : [],
  }));
  if (!data) return notLoaded("Reps", "reps", true);

  const mine = d
    ? `
<section class="stack" id="yours">
  <h2 class="label">Your representatives</h2>
  <p class="small secondary">${esc(describe(d))}</p>
  ${data.mine.map(repCard).join("") || '<p class="secondary small">None loaded yet for your districts. They appear after the data sync runs.</p>'}
  ${d.st !== "CA" ? '<p class="hint">State and local coverage comes as communities launch.</p>' : ""}
</section>`
    : "";

  const browse = st
    ? `
<section class="stack" id="state-list">
  <h2 class="label">${esc(STATE_NAME[st])}: members of Congress</h2>
  ${data.state.map(repCard).join("") || '<p class="secondary small">None loaded yet.</p>'}
  ${st === "CA" ? '<a class="list-row link-row card" href="/bodies/state-legislature/"><div><div class="list-title">California State Legislature</div><div class="list-meta">All 120 members</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>' : ""}
</section>`
    : "";

  const main = `
<header class="page-head">
  <h1>Reps</h1>
  <p class="subtitle">Members of Congress, California legislators, and Calaveras County supervisors, with the record they keep.</p>
</header>
${lookupForm(d, { heading: d ? "Change your location" : "Find your representatives" })}
${mine}
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
  return page("Reps", main, { tab: "reps", root: true, personal: true });
}

async function profile(env, slug, url) {
  const data = await safe(env, async (db) => {
    const o = await officialBySlug(db, slug);
    if (!o) return { o: null };
    const all = url.searchParams.get("votes") === "all";
    const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const cycle = parseInt(url.searchParams.get("cycle") || "", 10) || currentCycle();
    const [counts, votes, funding] = await Promise.all([
      voteCounts(db, o.id),
      votesFor(db, o.id, { all, limit: 50, offset: (pageNum - 1) * 50 }),
      o.level === "federal" ? fundingFor(db, o, cycle) : null,
    ]);
    return { o, all, pageNum, counts, votes, funding };
  });
  if (!data) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  const { o, all, pageNum, counts, votes, funding } = data;
  if (!o) return notFound("No current official at this address.", "reps", ["Reps", "/reps/"]);

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
    ["District", o.district ? esc(o.district) : "Statewide"],
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
<section class="card stack">
  <h2 class="label">Record at a glance</h2>
  <div class="grid-2">
    <div class="stat"><div class="stat-num">${counts.final || 0}</div><div class="stat-label">Final-passage votes</div></div>
    <div class="stat"><div class="stat-num">${counts.total || 0}</div><div class="stat-label">All recorded votes</div></div>
  </div>
  <p class="hint">Counts of recorded votes only. ThePillory doesn't score or grade officials.</p>
</section>`;

  const base = `/reps/${o.slug}/`;
  const more = votes.more
    ? `<a class="btn btn--block" href="${base}?${all ? "votes=all&" : ""}page=${pageNum + 1}#votes">Older votes</a>`
    : "";
  const voteList = votes.rows.length
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
    ${tab("overview", "Overview")}${tab("promises", "Promises")}${tab("votes", "Votes", counts.total || 0)}${tab("funding", "Funding")}${tab("issues", "Issues")}
  </nav>
  <div class="stack" role="tabpanel" id="overview" aria-labelledby="tab-overview">${overview}</div>
  <div class="stack" role="tabpanel" id="promises" aria-labelledby="tab-promises">
    <p class="secondary small">Promise tracking for real officials hasn't started. Promises will be added only with a source for each one.</p>
  </div>
  <div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">
    ${voteFilter(base, all, counts)}
    ${voteList}
  </div>
  <div class="stack" role="tabpanel" id="funding" aria-labelledby="tab-funding">${fundingTab(o, funding, base)}</div>
  <div class="stack" role="tabpanel" id="issues" aria-labelledby="tab-issues">${issueHtml}</div>
</div>`;
  return page(o.name, main, { tab: "reps", back: ["Reps", "/reps/"] });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return list(context.env, url, context.request);
  if (parts.length === 1) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return profile(context.env, parts[0], url);
  }
  return notFound("No page at this address.", "reps", ["Reps", "/reps/"]);
}
