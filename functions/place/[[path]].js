// /place/<st>/<county>/   one county: who represents it (County / State /
// Federal; districts that cover only part of it say so), and
//   - a live community: the Live badge, "Open briefing", "Make this my place"
//     (saves the county's districts in the browser; never an address),
//     upcoming meetings, issues, recent votes by its reps, and Funding;
//   - anywhere else: "Bring ThePillory here" (the waitlist), recent votes by
//     its state and federal reps, and Funding.
// Then nearby counties. Data: data/geo/places/<st>.json and D1.
import { page, notFound, esc, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { summaryHead, contentsBar, fold, statusChip } from "../_lib/summary.js";
import { EMPTY_REPORTS } from "../_lib/generated.js";
import { recentFinalVotes } from "../_lib/data.js";
import { voteRows } from "../_lib/briefing.js";
import { listMeetings, summariesFor, meetingCard, pacificNow, addDays } from "../_lib/meetings.js";
import { turnstileReady, turnstileWidget } from "../_lib/turnstile.js";
import { placeTopicsIndex, placeTopicPage } from "../_lib/topic-pages.js";
import { topicGrid, placeTopicsHref } from "../_lib/topics.js";
import { CURRENT, loadElection, onTheBallot, statewideRow, contestRow, measureRow, courtRow, courtGroups } from "../_lib/elections.js";
import { pickYear, yearBar } from "../_lib/history.js";
import { placePastYear, topicPastYear } from "../_lib/history-pages.js";
import { LIVE, loadPlace, officialsFor, allIds, repRow, executiveRows, breadcrumb, districtLabel, districtHref, placeHref } from "../_lib/geo.js";

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

// A county page is the same for every visitor: kept at the edge for a few minutes.
const PLACE_CACHE_SECONDS = 300;

export const onRequestGet = guard((context) => edgeCached(context, PLACE_CACHE_SECONDS, () => placePage(context)), { tab: "home" });

async function placePage({ request, env, params }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const [st, slug, extra, topic, more] = (params.path || []).filter(Boolean).map((s) => s.toLowerCase());
  if (!st) return Response.redirect(`${url.origin}/explore/`, 302);
  const place = await loadPlace(env, request, st);
  if (!place) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  if (!slug) return Response.redirect(`${url.origin}/explore/${st}/`, 302);
  const c = (!extra || (extra === "topics" && !more)) && place.counties.find((x) => x.slug === slug || x.fips === slug);
  if (!c) return notFound("No county at this address.", "home", [place.name, `/explore/${st}/`]);
  if (c.slug !== slug) return Response.redirect(`${url.origin}${placeHref(place.st, c.slug)}${extra ? `topics/${topic ? `${topic}/` : ""}` : ""}`, 301);
  // Topics for this county: /place/<st>/<county>/topics/ and /topics/<topic>/ (functions/_lib/topic-pages.js).
  // The Time Machine: ?year= shows the county (or one of its topics) as it was that year.
  const year = pickYear(url);
  if (extra === "topics") {
    if (topic && year) return topicPastYear(env, url, topic, year, { place, c });
    return topic ? placeTopicPage(env, place, c, topic, url) : placeTopicsIndex(place, c);
  }
  if (year) return placePastYear(env, request, url, place, c, year);

  const live = LIVE[c.fips];
  const db = env.DB;
  const emptyOfficials = { senators: [], house: [], upper: [], lower: [], county: [], executive: [], stateExecutive: [] };
  // Each section loads on its own: one that can't load shows a short note.
  const oLoaded = db
    ? await loadSection("place officials", () => officialsFor(db, place.st, { cd: c.cd.map((p) => p[0]), sldu: c.sldu.map((p) => p[0]), sldl: c.sldl.map((p) => p[0]), county: c.fips }), emptyOfficials)
    : emptyOfficials;
  const o = oLoaded === FAILED ? emptyOfficials : oLoaded;
  const now = pacificNow();
  const [votes, meetingsLoaded] = await Promise.all([
    db && oLoaded !== FAILED ? loadSection("place votes", () => recentFinalVotes(db, { limit: 5, officialIds: allIds(o) }), { rows: [] }) : { rows: [] },
    db && live
      ? loadSection("place meetings", async () => {
          const meetings = (await listMeetings(db, { from: now, to: `${addDays(now.slice(0, 10), 30)}T23:59`, level: "county", limit: 3 })).filter((m) => m.status !== "cancelled");
          return { meetings, summaries: await summariesFor(db, meetings.map((m) => m.id)) };
        }, { meetings: [], summaries: {} })
      : { meetings: [], summaries: {} },
  ]);
  const { meetings, summaries } = meetingsLoaded === FAILED ? { meetings: [], summaries: {} } : meetingsLoaded;
  const electionLoaded = await loadSection("place election", () => loadElection(env, request, CURRENT), null);
  const ballot = electionLoaded && electionLoaded !== FAILED && electionLoaded.election.state === place.st ? countyBallot(electionLoaded, c, place) : "";

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
  </form>`
      : '<p class="small secondary">The list isn\'t open yet.</p>'
  }
</section>`;

  const rows = votes === FAILED ? "" : voteRows(votes.rows, 5);
  const votesHtml = votes === FAILED ? sectionError("") : rows ? `<ul class="card plain-list brief-votes">${rows}</ul>` : `<p class="small secondary">${db ? "No final-passage votes loaded yet for these representatives." : "Votes appear here once the data sync has run."}</p>`;
  const federal = [...o.senators, ...o.house];
  const funding = federal.length
    ? `<div class="chips">${federal.map((r) => `<a class="chip chip--tap" href="/reps/${esc(r.slug)}/#funding">${esc(r.name)}</a>`).join("")}</div><p class="hint">Campaign funding for members of Congress, from the Federal Election Commission.</p>`
    : '<p class="small secondary">Funding appears once members of Congress are loaded.</p>';
  const nearby = c.neighbors
    .map((f) => place.counties.find((x) => x.fips === f))
    .filter(Boolean)
    .map((n) => `<a class="chip chip--tap" href="${placeHref(place.st, n.slug)}">${esc(n.name)}</a>`)
    .join("");

  // Summary first: who the county is represented by, in counts; everything else opens on tap.
  const n = (l) => (c[l] || []).length;
  const officialCount = countyRows.length + stateRows.length + federalRows.length;
  const sumText = [
    n("cd") ? `${c.name} is in ${n("cd")} congressional district${n("cd") === 1 ? "" : "s"}` : `${c.name}`,
    n("sldu") || n("sldl") ? `${n("sldu") + n("sldl")} state legislative district${n("sldu") + n("sldl") === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ") + ".";
  const head = summaryHead({
    kicker: `County · ${esc(place.name)}`,
    status: live ? '<span class="live-tag">Live</span>' : statusChip("Not live yet"),
    title: c.name,
    summary: { text: `${sumText}${live ? " ThePillory follows its county meetings and agendas." : ""}`, source: "District overlaps from the U.S. Census Bureau." },
    extra: districtsLine ? `<div class="stack-sm">${districtsLine}</div>` : "",
  });
  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, `/explore/${st}/`], [c.name, null]])}
${contentsBar([["summary", "Summary"], ballot ? ["elections", "Ballot"] : [null], ["who", "Who represents"], live ? ["meetings", "Meetings"] : [null], ["topics", "Topics"], ["votes", "Votes"], ["funding", "Funding"], nearby ? ["nearby", "Nearby"] : [null]])}
${head}
${action}
${electionLoaded === FAILED ? sectionError("On the ballot") : ballot}
${fold("who", `Who represents ${c.name}`, `${oLoaded === FAILED ? sectionError("") : ""}
  ${group("County", countyRows, live ? "The supervisors appear after the data sync runs." : "County officials aren't on ThePillory yet. County coverage opens when a community launches.")}
  ${group("State", stateRows, place.st === "CA" ? "State legislators appear after the data sync runs." : `${esc(place.name)}'s governor, statewide offices and state legislators aren't on ThePillory yet.`)}
  ${group("Federal", federalRows, "Members of Congress appear after the data sync runs.")}
  <p class="hint">District lines don't follow county lines, so a county can be split between districts.</p>`, { meta: officialCount ? `${officialCount} listed` : "" })}
${
  live
    ? fold("meetings", "Upcoming meetings", `${
        meetingsLoaded === FAILED ? sectionError("") : meetings.length ? meetings.map((m) => meetingCard(m, summaries[m.id])).join("") : '<p class="small secondary">No county meetings in the next 30 days.</p>'
      }<a class="out-link" href="/meetings/?level=county">All meetings</a>
  <div class="stack-sm"><p class="label">Issues</p>${EMPTY_REPORTS}</div>`, { meta: meetingsLoaded === FAILED ? "" : `${meetings.length} in 30 days` })
    : ""
}
${fold("topics", "Topics", `<p class="small secondary">One subject at a time for ${esc(c.name)}: bills and how its representatives voted, ${live ? "county meeting items, " : ""}executive actions, officials' own words, and campaign money, side by side.</p>
  ${topicGrid({ st: place.st, slug: c.slug })}
  <a class="out-link" href="${placeTopicsHref({ st: place.st, slug: c.slug })}">All topics</a>`)}
${fold("votes", `Recent votes by ${live ? "its" : "its state and federal"} representatives`, votesHtml)}
${fold("funding", "Funding", funding)}
${nearby ? fold("nearby", "Nearby counties", `<div class="chips">${nearby}</div>`) : ""}
${yearBar(url, null, { label: `See who represented ${c.name} in an earlier year` })}
<p class="hint">County boundaries and district overlaps: U.S. Census Bureau (2024 boundaries, 2020 census blocks).</p>`;
  return page(`${c.name}, ${place.name}`, main, { tab: "home", back: [place.name, `/explore/${st}/`], partial: anyFailed(oLoaded, votes, meetingsLoaded, electionLoaded) });
}

/** What's on the ballot in a county: statewide, every district that overlaps it, its Court of Appeal, and local contests where ThePillory has them. */
function countyBallot(election, c, place) {
  const id = election.election.id;
  const rows = [statewideRow(election)];
  for (const layer of ["cd", "sldu", "sldl"]) {
    for (const [d, full] of c[layer] || []) {
      const contest = election.contests.find((x) => x.scope === layer && x.district === String(d));
      if (contest) rows.push(contestRow(id, contest, full ? "" : "covers part of this county"));
    }
  }
  const local = (election.counties || {})[c.fips];
  const boe = local && election.contests.find((x) => x.scope === "boe" && x.district === local.boe);
  if (boe) rows.push(contestRow(id, boe));
  const short = c.name.replace(/ County$/, "");
  rows.push(...courtGroups(election.contests).filter((g) => g.court === "supreme" || g.counties.includes(short)).map((g) => courtRow(id, g)));
  if (local) {
    rows.push(...election.contests.filter((x) => x.scope === "county" && x.county === c.fips).map((x) => contestRow(id, x, "on some ballots in the county")));
    rows.push(...election.measures.filter((m) => m.scope === "county" && m.county === c.fips).map((m) => measureRow(id, m, "on some ballots in the county")));
  }
  const intro = local
    ? ""
    : `Statewide, district and court contests. ${c.name}'s local contests are on its elections office's website and sample ballot.`;
  return onTheBallot(election, { rows, intro, today: pacificNow().slice(0, 10), folded: true });
}
