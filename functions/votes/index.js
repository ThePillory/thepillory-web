// /votes/: every final-passage vote by officials who represent Calaveras County,
// newest first, with each official's position. ?level=federal|state, ?page=N.
import { page, notLoaded, esc, fmtDate, sourceLink } from "../_lib/render.js";
import { safe, recentFinalVotes } from "../_lib/data.js";
import { billHref } from "../_lib/votes.js";

const PER_PAGE = 30;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const level = ["federal", "state"].includes(url.searchParams.get("level")) ? url.searchParams.get("level") : null;
  const pageNo = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const data = await safe(env, (db) => recentFinalVotes(db, { level, limit: PER_PAGE, offset: (pageNo - 1) * PER_PAGE }));
  if (!data) return notLoaded("Votes", "reps", false, ["Reps", "/reps/"]);
  const q = (p) => `/votes/?${new URLSearchParams({ ...(level ? { level } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;
  const opt = (value, label) => `<a class="toggle" href="/votes/${value ? `?level=${value}` : ""}"${level === value ? ' aria-current="true"' : ""}>${label}</a>`;
  const rows = data.rows
    .map(
      (v) => `
<article class="card stack-sm">
  <p class="label">${v.level === "federal" ? "Federal" : "State"} · ${fmtDate(v.vote_date)}</p>
  ${v.bill_id && v.bill_number ? `<a class="inline-link vote-bill" href="${billHref(v.bill_id)}">${esc(v.bill_number)}</a>${v.bill_title ? `<p class="small">${esc(v.bill_title)}</p>` : ""}` : `<p class="vote-bill-text">${esc(v.subject || "")}</p>`}
  <p class="vote-question">${esc(v.question)} · Result: ${esc(v.result)}</p>
  <ul class="plain-list positions">${v.positions
    .map((p) => `<li class="position-row"><a class="inline-link" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a><span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></li>`)
    .join("")}</ul>
  ${sourceLink(v.source_url, "Official record")}
</article>`
    )
    .join("");
  const main = `
<header class="page-head">
  <h1>Your reps' votes</h1>
  <p class="subtitle">Final-passage votes by officials who represent Calaveras County, newest first. Other votes are on each rep's page.</p>
</header>
<nav class="segmented" aria-label="Show Federal or State">${opt(null, "All")}${opt("state", "State")}${opt("federal", "Federal")}</nav>
<p class="hint">County supervisors' votes will come from meeting minutes. That's coming next.</p>
${rows || '<p class="secondary small">No final-passage votes loaded yet.</p>'}
<nav class="pager">${pageNo > 1 ? `<a class="btn" href="${q(pageNo - 1)}">Newer</a>` : ""}${data.more ? `<a class="btn" href="${q(pageNo + 1)}">Older</a>` : ""}</nav>`;
  return page("Your reps' votes", main, { tab: "reps", back: ["Reps", "/reps/"] });
}
