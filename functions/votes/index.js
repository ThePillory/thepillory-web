// /votes/: final-passage votes, newest first. ?level=federal|state, ?page=N.
//   With the visitor's districts known (the pillory_districts cookie): votes
//   their reps cast, with each rep's position and the totals.
//   Otherwise: every final-passage vote with its totals, and a link to find
//   your reps.
import { page, notLoaded, esc, fmtDate, sourceLink, guard } from "../_lib/render.js";
import { safe, recentFinalVotes, officialsWhere, CHAMBER_NAME } from "../_lib/data.js";
import { billHref, tallyText } from "../_lib/votes.js";
import { districtsFromCookie, repsWhere, describe } from "../_lib/districts.js";

const PER_PAGE = 30;

async function allFinalVotes(db, { level, limit, offset }) {
  const { results } = await db
    .prepare(
      `SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.vote_type = 'final_passage' AND (? IS NULL OR v.level = ?)
       ORDER BY v.vote_date DESC, v.id DESC LIMIT ? OFFSET ?`
    )
    .bind(level, level, limit + 1, offset)
    .all();
  for (const r of results) r.positions = [];
  return { rows: results.slice(0, limit), more: results.length > limit };
}

export const onRequestGet = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const level = ["federal", "state"].includes(url.searchParams.get("level")) ? url.searchParams.get("level") : null;
  const pageNo = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const d = districtsFromCookie(request);
  const data = await safe(env, async (db) => {
    const opts = { level, limit: PER_PAGE, offset: (pageNo - 1) * PER_PAGE };
    if (!d) return allFinalVotes(db, opts);
    const reps = await officialsWhere(db, repsWhere(d));
    return recentFinalVotes(db, { ...opts, officialIds: reps.map((o) => o.id) });
  });
  if (!data) return notLoaded("Votes", "reps", false, ["Reps", "/reps/"]);
  const q = (p) => `/votes/?${new URLSearchParams({ ...(level ? { level } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;
  const opt = (value, label) => `<a class="toggle" href="/votes/${value ? `?level=${value}` : ""}"${level === value ? ' aria-current="true"' : ""}>${label}</a>`;
  const rows = data.rows
    .map((v) => {
      const tally = tallyText(v);
      const positions = v.positions.length
        ? `<ul class="plain-list positions">${v.positions
            .map((p) => `<li class="position-row"><a class="inline-link" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a><span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></li>`)
            .join("")}</ul>`
        : "";
      return `
<article class="card stack-sm">
  <p class="label">${esc(CHAMBER_NAME[v.chamber] || (v.level === "federal" ? "Federal" : "State"))} · ${fmtDate(v.vote_date)}</p>
  ${v.bill_id && v.bill_number ? `<a class="inline-link vote-bill" href="${billHref(v.bill_id)}">${esc(v.bill_number)}</a>${v.bill_title ? `<p class="small">${esc(v.bill_title)}</p>` : ""}` : `<p class="vote-bill-text">${esc(v.subject || "")}</p>`}
  <p class="vote-question">${esc(v.question)} · Result: ${esc(v.result)}</p>
  ${tally ? `<p class="tally small">${tally}</p>` : ""}
  ${positions}
  ${sourceLink(v.source_url, "Official record")}
</article>`;
    })
    .join("");
  const title = d ? "Your reps' votes" : "Votes";
  const main = `
<header class="page-head">
  <h1>${title}</h1>
  <p class="subtitle">${
    d
      ? `Final-passage votes by your reps (${esc(describe(d))}), newest first. Other votes are on each rep's page.`
      : "Final-passage votes in Congress and the California Legislature, newest first, with the totals."
  }</p>
</header>
${d ? "" : '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.</p>'}
<nav class="segmented" aria-label="Show Federal or State">${opt(null, "All")}${opt("state", "State")}${opt("federal", "Federal")}</nav>
<p class="hint">County supervisors' votes will come from meeting minutes. That's coming next.</p>
${rows || `<p class="secondary small">${d ? "No final-passage votes loaded yet for your reps." : "No final-passage votes loaded yet."}</p>`}
<nav class="pager">${pageNo > 1 ? `<a class="btn" href="${q(pageNo - 1)}">Newer</a>` : ""}${data.more ? `<a class="btn" href="${q(pageNo + 1)}">Older</a>` : ""}</nav>`;
  return page(title, main, { tab: "reps", back: ["Reps", "/reps/"], personal: true });
}, { tab: "reps" });
