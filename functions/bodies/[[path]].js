// /bodies/<slug>/   a governing body: its members (from D1) plus sample meetings, laws, and issues.
import { BODIES, MEETINGS_BY_BODY, LAWS_BY_BODY, ISSUES_BY_BODY, ISSUE_CARDS, LEVEL_NAME } from "../_lib/generated.js";
import { page, notFound, esc, linkRow, section } from "../_lib/render.js";
import { safe, officialsForBody } from "../_lib/data.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  const b = parts.length === 1 ? BODIES.find((x) => x.slug === parts[0]) : null;
  if (!b) return notFound("No governing body at this address.", "reps", ["Reps", "/reps/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);

  const members = await safe(context.env, (db) => officialsForBody(db, b.slug));
  const memberRows = members && members.length
    ? members.map((o) => linkRow(`/reps/${o.slug}/`, o.name, [o.office, o.district].filter(Boolean).join(" · "))).join("")
    : `<p class="secondary small">${
        b.level === "county" ? "Supervisors are entered by hand and will appear once added." : "Not loaded yet."
      }</p>`;
  const meetings = (MEETINGS_BY_BODY[b.slug] || []).join("") || '<p class="secondary small">No upcoming meetings posted.</p>';
  const laws = (LAWS_BY_BODY[b.slug] || []).join("");
  const issues = (ISSUES_BY_BODY[b.slug] || []).map((s) => ISSUE_CARDS[s]).join("");

  const main = `
<header class="page-head">
  <p class="label">${LEVEL_NAME[b.level]} · Governing body</p>
  <h1>${esc(b.name)}</h1>
  <div class="secondary">${esc(b.about)}</div>
  <div class="chips">${b.chip}</div>
</header>
${section("Members", `<div>${memberRows}</div>`)}
${section("Meetings (sample)", `<div>${meetings}</div>`)}
${laws ? section("Sample laws", `<div>${laws}</div>`) : ""}
${issues ? section("Issues (sample)", issues, "stack") : ""}`;
  return page(b.name, main, { tab: "reps", back: ["Reps", "/reps/"] });
}
