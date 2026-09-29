// /reps/            all current officials for Calaveras County, grouped County / State / Federal
// /reps/<slug>/     one official: Overview, Promises, Votes, Issues
import { BODIES, ISSUE_CARDS, LEVEL_NAME } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, kv, card, section, sourceLink, fmtDate } from "../_lib/render.js";
import {
  safe, listOfficials, officialBySlug, voteCounts, votesFor, approvedIssuesForOfficial, LEVEL_ORDER, CHAMBER_NAME,
} from "../_lib/data.js";
import { voteRow, voteFilter } from "../_lib/votes.js";

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

async function list(env) {
  const officials = await safe(env, listOfficials);
  if (!officials) return notLoaded("Reps", "reps", true);
  const groups = LEVEL_ORDER.map((level) => {
    const bodies = BODIES.filter((b) => b.level === level).map((b) => b.card).join("");
    const reps = officials.filter((o) => o.level === level).map(repCard).join("");
    const empty = level === "county"
      ? '<p class="secondary small">County supervisors are entered by hand and will appear once added.</p>'
      : '<p class="secondary small">None loaded yet.</p>';
    return `
<section class="stack">
  <h2 class="label">${LEVEL_NAME[level]}</h2>
  ${bodies}${reps || empty}
</section>`;
  }).join("");
  const main = `
<header class="page-head">
  <h1>Reps</h1>
  <p class="subtitle">The officials who represent Calaveras County, and the record they keep.</p>
</header>
<p class="hint">Every official here is loaded from an official source, linked on their page, with the date it was last checked.</p>
${groups}`;
  return page("Reps", main, { tab: "reps", root: true });
}

async function profile(env, slug, url) {
  const data = await safe(env, async (db) => {
    const o = await officialBySlug(db, slug);
    if (!o) return { o: null };
    const all = url.searchParams.get("votes") === "all";
    const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const [counts, votes, issues] = await Promise.all([
      voteCounts(db, o.id),
      votesFor(db, o.id, { all, limit: 50, offset: (pageNum - 1) * 50 }),
      approvedIssuesForOfficial(db, o.id),
    ]);
    return { o, all, pageNum, counts, votes, issues };
  });
  if (!data) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  const { o, all, pageNum, counts, votes, issues } = data;
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
  <p class="hint">Counts of recorded votes only. The Pillory doesn't score or grade officials.</p>
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

  const issueHtml = issues.length
    ? issues.map((s) => ISSUE_CARDS[s]).filter(Boolean).join("")
    : '<p class="secondary small">No issues linked yet. Issues are linked to bills only after review.</p>';

  const tab = (k, label, n) =>
    `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}${n != null ? `<span class="count">${n}</span>` : ""}</a>`;
  const main = `${head}
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs" role="tablist" aria-label="Sections">
    ${tab("overview", "Overview")}${tab("promises", "Promises")}${tab("votes", "Votes", counts.total || 0)}${tab("issues", "Issues", issues.length)}
  </nav>
  <div class="stack" role="tabpanel" id="overview" aria-labelledby="tab-overview">${overview}</div>
  <div class="stack" role="tabpanel" id="promises" aria-labelledby="tab-promises">
    <p class="secondary small">Promise tracking for real officials hasn't started. Promises will be added only with a source for each one.</p>
  </div>
  <div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">
    ${voteFilter(base, all, counts)}
    ${voteList}
  </div>
  <div class="stack" role="tabpanel" id="issues" aria-labelledby="tab-issues">${issueHtml}</div>
</div>`;
  return page(o.name, main, { tab: "reps", back: ["Reps", "/reps/"] });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return list(context.env);
  if (parts.length === 1) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return profile(context.env, parts[0], url);
  }
  return notFound("No page at this address.", "reps", ["Reps", "/reps/"]);
}
