// /votes/: final-passage votes, newest first. ?level=federal|state, ?page=N.
//   With the visitor's districts known (the pillory_districts cookie): votes
//   their reps cast, with each rep's position and the totals.
//   Otherwise: every final-passage vote with its totals, and a link to find
//   your reps.
import { voteScope } from "../_lib/data.js";
import { page, notLoaded, esc, fmtDate, guard } from "../_lib/render.js";
import { safe, recentFinalVotes, officialsWhere, CHAMBER_NAME } from "../_lib/data.js";
import { billHref } from "../_lib/votes.js";
import { compactRow } from "../_lib/summary.js";
import { firstClauses } from "../_lib/laws-list.js";
import { districtsFromCookie, repsWhere, describe, STATE_NAME } from "../_lib/districts.js";

const PER_PAGE = 30;

async function allFinalVotes(db, { level, limit, offset }) {
  const { results } = await db
    .prepare(
      `SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.vote_type = 'final_passage' AND (? IS NULL OR (${voteScope(level).sql}))
       ORDER BY v.vote_date DESC, v.id DESC LIMIT ? OFFSET ?`
    )
    .bind(level, ...voteScope(level).binds, limit + 1, offset)
    .all();
  for (const r of results) r.positions = [];
  return { rows: results.slice(0, limit), more: results.length > limit };
}

export const onRequestGet = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const asked = url.searchParams.get("level") || "";
  const level = ["federal", "state"].includes(asked) || (/^state:[A-Z]{2}$/.test(asked) && STATE_NAME[asked.slice(6)]) ? asked : null;
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
  const clauses = await firstClauses(env.DB, [...new Set(data.rows.map((v) => v.bill_id).filter(Boolean))]);
  const SHORT = { "us-house": "House", "us-senate": "Senate", "ca-assembly": "Assembly", "ca-senate": "State Senate" };
  // One line per vote: the bill, its title, the result, and (with districts) how your reps voted.
  const rows = data.rows
    .map((v) =>
      compactRow({
        href: v.bill_id ? `${billHref(v.bill_id)}#votes` : v.source_url,
        type: v.bill_number || "Vote",
        title: v.bill_title || v.subject || v.question,
        status: `${v.result} · ${SHORT[v.chamber] || CHAMBER_NAME[v.chamber] || ""}${v.yea != null && v.nay != null ? ` · Yes ${v.yea}, No ${v.nay}` : ""}`,
        meta: [fmtDate(v.vote_date), v.positions.length ? `Your reps: ${v.positions.map((p) => `${p.name} ${p.position}`).join(", ")}` : ""].filter(Boolean).join(" · "),
        clause: (v.bill_id && clauses.get(v.bill_id)) || null,
      })
    )
    .join("");
  const chip = (value, label) => `<a href="/votes/${value ? `?level=${value}` : ""}"${level === value ? ' aria-current="true"' : ""}>${label}</a>`;
  const title = d ? "Your reps' votes" : "Votes";
  const main = `
<header class="page-head">
  <h1>${title}</h1>
  <p class="subtitle">${
    d
      ? `Final-passage votes by your reps (${esc(describe(d))}), newest first. Other votes are on each rep's page.`
      : "Final-passage votes in Congress and the state legislatures loaded so far, newest first, with the totals."
  }</p>
</header>
${d ? "" : '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.</p>'}
<nav class="filter-chips" aria-label="Show">${chip(null, "All")}${chip("federal", "Congress")}${chip("state", "California")}${d && d.st !== "CA" ? chip(`state:${d.st}`, esc(STATE_NAME[d.st] || d.st)) : level && level.startsWith("state:") ? chip(level, esc(STATE_NAME[level.slice(6)])) : ""}</nav>
<section class="card compact-list" id="vote-list" data-more-list>${rows || `<p class="secondary small cr-empty">${d ? "No final-passage votes loaded yet for your reps." : "No final-passage votes loaded yet."}</p>`}</section>
${data.more ? `<a class="btn btn--block load-more" href="${q(pageNo + 1)}" data-load-more="vote-list">Load more</a>` : ""}
<p class="hint">Each line opens the bill's votes, which link to the official record. County supervisors' votes will come from meeting minutes. That's coming next.</p>`;
  return page(title, main, { tab: "reps", back: ["Reps", "/reps/"], personal: true });
}, { tab: "reps" });
