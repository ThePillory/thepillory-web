// /home/: the Home briefing.
//   This week: up to 3 upcoming meetings or hearings, with comment deadlines and flagged-item chips
//   Issues near you: up to 3 issues (the most space), tagged when they're on this week's agenda
//   Your reps' latest votes: one row per rep and final-passage vote, newest first (3 rows)
// The County / State / Federal filter (?level=) applies to all three.
import { ISSUE_CARDS, ISSUES } from "../_lib/generated.js";
import { page, esc, fmtDate, safeUrl } from "../_lib/render.js";
import { recentFinalVotes } from "../_lib/data.js";
import { billHref } from "../_lib/votes.js";
import { listMeetings, summariesFor, approvedLinks, meetingCard, pacificNow, addDays, when } from "../_lib/meetings.js";

const LEVELS = ["county", "state", "federal"];

function filterNav(level) {
  const opt = (value, label) => {
    const href = value ? `/home/?level=${value}` : "/home/";
    return `<a class="toggle" href="${href}"${(level || null) === value ? ' aria-current="true"' : ""}>${label}</a>`;
  };
  return `<nav class="pill-filter" aria-label="Scope">${opt(null, "All")}${opt("county", "County")}${opt("state", "State")}${opt("federal", "Federal")}</nav>`;
}

function withLevel(href, level) {
  return level ? `${href}${href.includes("?") ? "&" : "?"}level=${level}` : href;
}

function sectionHead(id, title, href, linkText) {
  return `<div class="section-head"><h2 class="label" id="${id}">${title}</h2><a class="section-link" href="${href}">${linkText}</a></div>`;
}

/** One row per official's position: name, bill · Final passage · result · date, and the position. */
function voteRows(votes, max) {
  const rows = [];
  for (const v of votes) {
    for (const p of v.positions || []) {
      if (rows.length >= max) break;
      const bill = v.bill_id && v.bill_number ? `<a href="${billHref(v.bill_id)}">${esc(v.bill_number)}</a>` : esc(v.subject || "");
      const src = safeUrl(v.source_url);
      rows.push(`
  <li class="brief-vote">
    <div class="brief-vote-main">
      <a class="brief-vote-name" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a>
      <span class="xsmall secondary">${bill} · Final passage · ${esc(v.result)} · ${fmtDate(v.vote_date)}${src ? ` · <a href="${esc(src)}" target="_blank" rel="noopener" title="${esc(v.question)}">Record ↗</a>` : ""}</span>
    </div>
    <span class="brief-vote-position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span>
  </li>`);
    }
  }
  return rows.join("");
}

function tagged(cardHtml) {
  // Add "On this week's agenda" to the issue card's chip row.
  return cardHtml.replace(/(<div class="chips">[\s\S]*?)(<\/div>)/, `$1<span class="chip chip--light">On this week's agenda</span>$2`);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const level = LEVELS.includes(url.searchParams.get("level")) ? url.searchParams.get("level") : null;
  const now = pacificNow();
  const weekEnd = `${addDays(now.slice(0, 10), 7)}T23:59`;

  let meetings = [];
  let summaries = {};
  let links = [];
  let votes = { rows: [], more: false };
  const db = env.DB;
  if (db) {
    try {
      meetings = (await listMeetings(db, { from: now, to: weekEnd, level: level === "federal" ? "none" : level, limit: 20 })).filter((m) => m.status !== "cancelled");
      summaries = await summariesFor(db, meetings.map((m) => m.id));
      links = await approvedLinks(db, meetings.map((m) => m.id));
      votes = level === "county" ? votes : await recentFinalVotes(db, { level, limit: 3 });
    } catch (err) {
      if (!/no such table/i.test(String(err && err.message))) throw err;
    }
  }

  // This week
  const week = meetings.slice(0, 3);
  const weekHtml = week.length
    ? week.map((m) => meetingCard(m, summaries[m.id])).join("")
    : `<p class="secondary small empty-note">${
        !db ? "Meetings appear here once the data sync has run." : level === "federal" ? "Congress's schedule isn't tracked here yet." : "Nothing scheduled in the next seven days."
      }</p>`;

  // Issues near you (tagged when an approved link puts them on this week's agenda)
  const onAgenda = new Set(links.filter((l) => meetings.some((x) => x.id === l.meeting_id)).map((l) => l.issue_slug));
  const slugs = Object.keys(ISSUES)
    .filter((s) => !level || ISSUES[s].level === level)
    .sort((a, b) => (onAgenda.has(b) ? 1 : 0) - (onAgenda.has(a) ? 1 : 0))
    .slice(0, 3);
  const issuesHtml = slugs.length
    ? slugs.map((s) => (onAgenda.has(s) ? tagged(ISSUE_CARDS[s]) : ISSUE_CARDS[s])).join("")
    : '<p class="secondary small empty-note">No issues at this level yet.</p>';

  // Your reps' latest votes
  const rows = voteRows(votes.rows, 3);
  const votesHtml = rows
    ? `<ul class="card plain-list brief-votes">${rows}</ul>`
    : `<p class="secondary small empty-note">${
        level === "county"
          ? "Supervisors' votes will come from meeting minutes. That's coming next."
          : db
            ? "No final-passage votes loaded yet."
            : "Votes appear here once the data sync has run."
      }</p>`;

  const main = `
<header class="brief-head">
  <div class="app-header">
    <a class="wordmark" href="/">The Pillory</a>
    <div class="header-meta"><strong>Calaveras County</strong></div>
  </div>
  <h1 class="visually-hidden">Home</h1>
  ${filterNav(level)}
  <p class="small secondary">Your briefing · ${esc(when(now).long || "")}</p>
</header>

<section class="brief-section" aria-labelledby="h-week">
  ${sectionHead("h-week", "This week", withLevel("/meetings/", level === "federal" ? null : level), "See all meetings")}
  ${weekHtml}
</section>

<section class="brief-section brief-section--issues" aria-labelledby="h-issues">
  ${sectionHead("h-issues", "Issues near you", "/issues/", "See all issues")}
  <p class="xsmall secondary">Examples, until residents can file real reports.</p>
  ${issuesHtml}
</section>

<section class="brief-section" aria-labelledby="h-votes">
  ${sectionHead("h-votes", "Your reps' latest votes", withLevel("/votes/", level === "county" ? null : level), "See all votes")}
  ${votesHtml}
</section>

<div class="caught-up">
  <span class="caught-up-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg></span>
  <div class="stack-xs"><strong>You're caught up</strong><span class="small secondary">That's everything for this week.</span></div>
</div>`;
  const res = page("Home", main, { tab: "home", root: true });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=120");
  return new Response(res.body, { status: res.status, headers });
}
