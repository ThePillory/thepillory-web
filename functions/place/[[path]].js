// /place/<st>/<county>/   one county: who represents it (County / State /
// Federal; districts that cover only part of it say so), and
//   - a live community: the Live badge, "Open briefing", "Make this my place"
//     (saves the county's districts in the browser; never an address),
//     upcoming meetings, issues, recent votes by its reps, and Funding;
//   - anywhere else: "Bring ThePillory here" (the waitlist), recent votes by
//     its state and federal reps, and Funding.
// Then nearby counties. Data: data/geo/places/<st>.json and D1.
import { page, notFound, esc } from "../_lib/render.js";
import { EMPTY_REPORTS } from "../_lib/generated.js";
import { recentFinalVotes } from "../_lib/data.js";
import { voteRows } from "../_lib/briefing.js";
import { listMeetings, summariesFor, meetingCard, pacificNow, addDays } from "../_lib/meetings.js";
import { turnstileReady, turnstileWidget, turnstileScript } from "../_lib/turnstile.js";
import { LIVE, loadPlace, officialsFor, allIds, repRow, executiveRows, breadcrumb, districtLabel, districtHref, placeHref } from "../_lib/geo.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const WAITLIST_MESSAGES = {
  joined: "Thank you. We'll email you only when ThePillory launches in this county.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "That's enough sign-ups from this connection for today. Please try again tomorrow.",
  invalid: "Enter an email address.",
  closed: "The list isn't open yet.",
};

/** The district a county is entirely in, or else the first listed (the data can't say which covers more). */
const mainDistrict = (pairs) => ((pairs || []).find((p) => p[1]) || (pairs || [])[0] || [null])[0];

function districtNotes(pairs, layer, place) {
  return (pairs || []).map(([id, full]) => ({ id, full: !!full, label: districtLabel(layer, id, place), href: districtHref(layer, id, place) }));
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const [st, slug, extra] = (params.path || []).filter(Boolean).map((s) => s.toLowerCase());
  if (!st) return Response.redirect(`${url.origin}/explore/`, 302);
  const place = await loadPlace(env, request, st);
  if (!place) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  if (!slug) return Response.redirect(`${url.origin}/explore/${st}/`, 302);
  const c = !extra && place.counties.find((x) => x.slug === slug || x.fips === slug);
  if (!c) return notFound("No county at this address.", "home", [place.name, `/explore/${st}/`]);
  if (c.slug !== slug) return Response.redirect(`${url.origin}${placeHref(place.st, c.slug)}`, 301);

  const live = LIVE[c.fips];
  const db = env.DB;
  let o = { senators: [], house: [], upper: [], lower: [], county: [] };
  let votes = { rows: [] };
  let meetings = [];
  let summaries = {};
  if (db) {
    try {
      o = await officialsFor(db, place.st, { cd: c.cd.map((p) => p[0]), sldu: c.sldu.map((p) => p[0]), sldl: c.sldl.map((p) => p[0]), county: c.fips });
      votes = await recentFinalVotes(db, { limit: 5, officialIds: allIds(o) });
      if (live) {
        const now = pacificNow();
        meetings = (await listMeetings(db, { from: now, to: `${addDays(now.slice(0, 10), 30)}T23:59`, level: "county", limit: 3 })).filter((m) => m.status !== "cancelled");
        summaries = await summariesFor(db, meetings.map((m) => m.id));
      }
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }

  // Who represents this county: every district that overlaps it.
  const group = (title, rows, empty) => `
<section class="stack-sm">
  <h3 class="label">${title}</h3>
  ${rows.length ? `<div class="card">${rows.join("")}</div>` : `<p class="small secondary">${empty}</p>`}
</section>`;
  const byDistrict = (layer, officials) =>
    districtNotes(c[layer], layer, place).map((d) => {
      const reps = officials.filter((x) => String(x.district_code) === d.id);
      const note = d.full ? "" : "covers part of this county";
      return reps.length
        ? reps.map((r) => repRow(r, note)).join("")
        : `<a class="list-row link-row" href="${d.href}"><div><div class="list-title">${esc(d.label)}</div><div class="list-meta">${note ? `${note} · ` : ""}representative not loaded yet</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`;
    });
  const countyRows = live ? o.county.map((r) => repRow(r)) : [];
  const stateRows = place.st === "CA"
    ? [...executiveRows(o.stateExecutive, { href: "/bodies/ca-executive/", label: "California's other statewide offices" }), ...byDistrict("sldu", o.upper), ...byDistrict("sldl", o.lower)]
    : [];
  const federalRows = [...executiveRows(o.executive, { href: "/bodies/us-executive/", label: "The Cabinet" }), ...o.senators.map((r) => repRow(r)), ...byDistrict("cd", o.house)];
  // One compact row per chamber: the district numbers, and whether they cover all or part of the county.
  const districtsLine = ["cd", "sldu", "sldl"]
    .filter((l) => c[l] && c[l].length)
    .map((l) => {
      const ds = districtNotes(c[l], l, place);
      const allPart = ds.every((d) => !d.full);
      const name = l === "cd" ? "Congressional" : place.st === "NE" ? "Legislative" : place.chambers[l];
      const short = (id) => (id === "0" ? "At large" : /^\d+$/.test(id) ? id : id.toUpperCase());
      return `<div class="stack-xs"><p class="small"><strong>${esc(name)} ${ds.length === 1 ? "district" : "districts"}</strong>${
        ds.length === 1 ? (ds[0].full ? " · the whole county" : " · covers part of this county") : allPart ? " · each covers part of this county" : ""
      }</p><ul class="plain-list district-grid">${ds
        .map((d) => `<li><a class="chip chip--tap" href="${d.href}" aria-label="${esc(d.label)}${d.full ? "" : ", covers part of this county"}">${esc(short(d.id))}${!allPart && ds.length > 1 && !d.full ? " (part)" : ""}</a></li>`)
        .join("")}</ul></div>`;
    })
    .join("");

  // Live: briefing and "Make this my place". Others: the waitlist.
  const split = ["cd", "sldu", "sldl"]
    .filter((l) => c[l] && c[l].length > 1 && !c[l].some((p) => p[1]))
    .map((l) => c[l].map(([id]) => districtLabel(l, id, place)).join(" and "));
  const pick = new URLSearchParams(Object.entries({ st: place.st, cd: mainDistrict(c.cd), su: mainDistrict(c.sldu), sl: mainDistrict(c.sldl), co: c.fips }).filter(([, v]) => v)).toString();
  const joined = url.searchParams.get("waitlist");
  const msg = joined === "joined" ? WAITLIST_MESSAGES.joined : "";
  const err = joined && joined !== "joined" ? WAITLIST_MESSAGES[joined] || "" : "";
  const action = live
    ? `
<section class="card stack-sm">
  <p><span class="live-tag">Live</span> ThePillory follows ${esc(c.name)}'s meetings and agendas, comment deadlines, and every recorded vote by the officials who represent it.</p>
  <a class="btn btn--primary btn--block" href="${live.briefing}">Open briefing</a>
  <form method="post" action="/api/districts">
    <input type="hidden" name="pick" value="${esc(pick)}" />
    <button class="btn btn--block" type="submit">Make this my place</button>
  </form>
  <p class="hint">Saves this county's districts in your browser only, never an address.${split.length ? ` ${esc(c.name)} is split between ${esc(split.join("; "))}, and this saves the first; for an exact match, <a class="tap" href="/#find">enter your address on the hub</a>.` : ""}</p>
</section>`
    : `
<section class="card stack-sm" id="waitlist">
  <h2>Bring ThePillory here</h2>
  <p class="small">Communities open one county at a time. Leave your email, and we'll let you know when ${esc(c.name)} opens. Until then, the votes of its state and federal representatives are below.</p>
  ${msg ? `<p class="banner" role="status">${esc(msg)}</p>` : ""}
  ${err ? `<p class="banner banner--error" role="alert">${esc(err)}</p>` : ""}
  ${
    turnstileReady(env)
      ? `<form class="stack-sm" method="post" action="/api/waitlist">
    <input type="hidden" name="state" value="${esc(place.st)}" />
    <input type="hidden" name="county" value="${esc(c.fips)}" />
    <input type="hidden" name="back" value="${esc(placeHref(place.st, c.slug))}" />
    <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required maxlength="254" /></label>
    <p class="hint">Used only to announce this county's launch. Never shown or shared.</p>
    ${turnstileWidget(env)}
    <button class="btn btn--primary" type="submit">Join the list</button>
  </form>${turnstileScript}`
      : '<p class="small secondary">The list isn\'t open yet.</p>'
  }
</section>`;

  const rows = voteRows(votes.rows, 5);
  const votesHtml = rows ? `<ul class="card plain-list brief-votes">${rows}</ul>` : `<p class="small secondary">${db ? "No final-passage votes loaded yet for these representatives." : "Votes appear here once the data sync has run."}</p>`;
  const federal = [...o.senators, ...o.house];
  const funding = federal.length
    ? `<div class="chips">${federal.map((r) => `<a class="chip chip--tap" href="/reps/${esc(r.slug)}/#funding">${esc(r.name)}</a>`).join("")}</div><p class="hint">Campaign funding for members of Congress, from the Federal Election Commission.</p>`
    : '<p class="small secondary">Funding appears once members of Congress are loaded.</p>';
  const nearby = c.neighbors
    .map((f) => place.counties.find((x) => x.fips === f))
    .filter(Boolean)
    .map((n) => `<a class="chip chip--tap" href="${placeHref(place.st, n.slug)}">${esc(n.name)}</a>`)
    .join("");

  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, `/explore/${st}/`], [c.name, null]])}
<header class="page-head stack-xs">
  <h1>${esc(c.name)}${live ? ' <span class="live-tag">Live</span>' : ""}</h1>
  <p class="secondary">${esc(place.name)}</p>
</header>
${action}
<section class="stack" aria-labelledby="h-who">
  <h2 class="label" id="h-who">Who represents ${esc(c.name)}</h2>
  ${districtsLine ? `<div class="card stack-sm">${districtsLine}<p class="hint">District lines don't follow county lines, so a county can be split between districts.</p></div>` : ""}
  ${group("County", countyRows, live ? "The supervisors appear after the data sync runs." : "County officials aren't on ThePillory yet. County coverage opens when a community launches.")}
  ${group("State", stateRows, place.st === "CA" ? "State legislators appear after the data sync runs." : `${esc(place.name)}'s governor, statewide offices and state legislators aren't on ThePillory yet.`)}
  ${group("Federal", federalRows, "Members of Congress appear after the data sync runs.")}
</section>
${
  live
    ? `<section class="stack-sm" aria-labelledby="h-meet"><div class="section-head"><h2 class="label" id="h-meet">Upcoming meetings</h2><a class="section-link" href="/meetings/?level=county">All meetings</a></div>${
        meetings.length ? meetings.map((m) => meetingCard(m, summaries[m.id])).join("") : '<p class="small secondary">No county meetings in the next 30 days.</p>'
      }</section>
<section class="stack-sm" aria-labelledby="h-issues"><h2 class="label" id="h-issues">Issues</h2>${EMPTY_REPORTS}</section>`
    : ""
}
<section class="stack-sm" aria-labelledby="h-votes">
  <h2 class="label" id="h-votes">Recent votes by ${live ? "its" : "its state and federal"} representatives</h2>
  ${votesHtml}
</section>
<section class="stack-sm" aria-labelledby="h-funding">
  <h2 class="label" id="h-funding">Funding</h2>
  ${funding}
</section>
${nearby ? `<section class="stack-sm" aria-labelledby="h-near"><h2 class="label" id="h-near">Nearby counties</h2><div class="chips">${nearby}</div></section>` : ""}
<p class="hint">County boundaries and district overlaps: U.S. Census Bureau (2024 boundaries, 2020 census blocks).</p>`;
  return page(`${c.name}, ${place.name}`, main, { tab: "home", back: [place.name, `/explore/${st}/`] });
}
