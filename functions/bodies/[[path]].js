// /bodies/<slug>/   a governing body: its members, and (for the Board of Supervisors) its meetings, from D1.
// The U.S. Senate and House take ?state=XX (the links from a state's page): that
// state's members first, then "Your members" from saved districts only when
// they're in a different state, then Members by state.
import { BODIES, LEVEL_NAME } from "../_lib/generated.js";
import { page, notFound, esc, linkRow, section, guard } from "../_lib/render.js";
import { safe, officialsForBody, officialsWhere } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, STATE_NAME } from "../_lib/districts.js";
import { meetingCard, summariesFor, pacificNow, addDays } from "../_lib/meetings.js";

// Meetings upcoming and from the last 30 days, soonest first.
async function meetingsFor(db, slug) {
  try {
    const today = pacificNow().slice(0, 10);
    const { results } = await db
      .prepare(
        `SELECT * FROM meetings WHERE body_slug = ? AND starts_at >= ? AND starts_at <= ?
         ORDER BY starts_at LIMIT 12`
      )
      .bind(slug, `${addDays(today, -30)}T00:00`, `${addDays(today, 90)}T23:59`)
      .all();
    return { rows: results, summaries: await summariesFor(db, results.map((m) => m.id)) };
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return { rows: [], summaries: {} };
    throw err;
  }
}

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  const b = parts.length === 1 ? BODIES.find((x) => x.slug === parts[0]) : null;
  if (!b) return notFound("No governing body at this address.", "reps", ["Reps", "/reps/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);

  const county = b.level === "county";
  // Congress is too large to list here: the visitor's own members, then by state on /reps/.
  // The executive branches are listed in full.
  const executive = b.slug === "us-executive" || b.slug === "ca-executive";
  const federal = b.level === "federal" && !executive;
  const d = districtsFromCookie(context.request);
  const asked = String(url.searchParams.get("state") || "").toUpperCase();
  const st = federal && STATE_NAME[asked] ? asked : null;
  // Your own members only when they aren't the state already shown.
  const mine = federal && d && d.st !== st;
  const data = await safe(context.env, async (db) => ({
    stateMembers: st ? await officialsWhere(db, { sql: "o.active = 1 AND o.chamber = ? AND o.state = ?", binds: [b.slug, st] }) : null,
    members: federal
      ? mine ? (await officialsWhere(db, repsWhere(d))).filter((o) => o.body === b.slug) : []
      : await officialsForBody(db, b.slug),
    meetings: county ? await meetingsFor(db, b.slug) : null,
  }));
  const members = data ? data.members : null;
  const row = (o) => linkRow(`/reps/${o.slug}/`, o.name, [o.office, o.district].filter(Boolean).join(" · "));
  const stateSection = st
    ? section(`${STATE_NAME[st]}'s members`, `<div>${
        data && data.stateMembers && data.stateMembers.length
          ? data.stateMembers.map(row).join("")
          : `<p class="secondary small">${data ? `Coming soon for ${esc(STATE_NAME[st])}.` : "Not loaded yet. Members appear after the data sync runs."}</p>`
      }</div>`)
    : "";
  const memberRows = members && members.length
    ? members.map(row).join("")
    : `<p class="secondary small">${
        !data ? "Not loaded yet. Members appear after the data sync runs."
          : federal ? `<a class="inline-link" href="/#find">Find your representatives</a> to see yours here.`
          : county ? "Supervisors are entered by hand and will appear once added."
          : executive ? "Not loaded yet. These offices appear after the data sync runs." : "Not loaded yet."
      }</p>`;
  const byState = federal
    ? section(
        "Members by state",
        `<div class="chips">${Object.entries(STATE_NAME)
          .sort((x, y) => x[1].localeCompare(y[1]))
          .map(([code, name]) => `<a class="chip state-chip" href="/reps/?state=${code}#state-list">${esc(name)}</a>`)
          .join("")}</div>`,
        "card stack-sm"
      )
    : "";

  let meetings = "";
  if (county) {
    const m = data && data.meetings;
    meetings = `
<section class="stack-sm">
  <div class="section-head"><h2 class="label">Meetings</h2><a class="section-link" href="/meetings/?level=county">All meetings</a></div>
  ${
    m && m.rows.length
      ? m.rows.map((x) => meetingCard(x, m.summaries[x.id])).join("")
      : `<p class="secondary small">${data ? "No meetings in the last 30 days or the next 90 are loaded." : "Meetings appear here once the data sync has run."}</p>`
  }
</section>`;
  }

  const main = `
<header class="page-head">
  <p class="label">${LEVEL_NAME[b.level]} · Governing body</p>
  <h1>${esc(b.name)}</h1>
  <div class="secondary">${esc(b.about)}</div>
  <div class="chips">${b.chip}</div>
</header>
${stateSection}
${!federal || !st || mine ? section(federal ? "Your members" : "Members", `<div>${memberRows}</div>`) : ""}
${byState}
${meetings}
<p class="hint">${
    b.slug === "us-executive"
      ? "The President and Vice President from the congress-legislators project's executive data; the Cabinet as listed on whitehouse.gov. Each linked on its own page."
      : b.slug === "ca-executive"
        ? "Entered from each office's official website, linked on each officer's page."
        : "Members and meetings come from official sources, each linked on its own page."
  }</p>`;
  return page(b.name, main, { tab: "reps", back: ["Reps", "/reps/"], personal: federal });
}, { tab: "reps" });
