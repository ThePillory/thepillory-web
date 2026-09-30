// /bodies/<slug>/   a governing body: its members, and (for the Board of Supervisors) its meetings, from D1.
import { BODIES, LEVEL_NAME } from "../_lib/generated.js";
import { page, notFound, esc, linkRow, section } from "../_lib/render.js";
import { safe, officialsForBody } from "../_lib/data.js";
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

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  const b = parts.length === 1 ? BODIES.find((x) => x.slug === parts[0]) : null;
  if (!b) return notFound("No governing body at this address.", "reps", ["Reps", "/reps/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);

  const county = b.level === "county";
  const data = await safe(context.env, async (db) => ({
    members: await officialsForBody(db, b.slug),
    meetings: county ? await meetingsFor(db, b.slug) : null,
  }));
  const members = data ? data.members : null;
  const memberRows = members && members.length
    ? members.map((o) => linkRow(`/reps/${o.slug}/`, o.name, [o.office, o.district].filter(Boolean).join(" · "))).join("")
    : `<p class="secondary small">${
        !data ? "Not loaded yet. Members appear after the data sync runs." : county ? "Supervisors are entered by hand and will appear once added." : "Not loaded yet."
      }</p>`;

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
${section("Members", `<div>${memberRows}</div>`)}
${meetings}
<p class="hint">Members and meetings come from official sources, each linked on its own page.</p>`;
  return page(b.name, main, { tab: "reps", back: ["Reps", "/reps/"] });
}
