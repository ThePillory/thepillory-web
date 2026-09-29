// /home/: the Home briefing.
//   This week: up to 3 upcoming meetings or hearings, with comment deadlines and flagged-item chips
//   Issues near you: up to 3 issues (the most space), tagged when they're on this week's agenda
//   Your reps' latest votes: the 3 most recent final-passage votes
// The County / State / Federal filter (?level=) applies to all three.
import { ISSUE_CARDS, ISSUES } from "../_lib/generated.js";
import { page, esc, fmtDate, sourceLink } from "../_lib/render.js";
import { recentFinalVotes } from "../_lib/data.js";
import { billHref } from "../_lib/votes.js";
import { listMeetings, summariesFor, approvedLinks, meetingCard, meetingHref, pacificNow, addDays, when, LEVEL_LABEL } from "../_lib/meetings.js";

const LEVELS = ["county", "state", "federal"];

function filterNav(level) {
  const opt = (value, label) => {
    const href = value ? `/home/?level=${value}` : "/home/";
    return `<a class="toggle" href="${href}"${(level || null) === value ? ' aria-current="true"' : ""}>${label}</a>`;
  };
  return `<nav class="segmented home-filter" aria-label="Show County, State, or Federal">${opt(null, "All")}${opt("county", "County")}${opt("state", "State")}${opt("federal", "Federal")}</nav>`;
}

function withLevel(href, level) {
  return level ? `${href}${href.includes("?") ? "&" : "?"}level=${level}` : href;
}

function voteItem(v) {
  const who = (v.positions || [])
    .map((p) => `<li class="position-row"><a class="inline-link" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a><span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></li>`)
    .join("");
  return `
<article class="card stack-sm home-vote">
  <p class="label">${esc(LEVEL_LABEL[v.level] || "")} · ${fmtDate(v.vote_date)}</p>
  ${v.bill_id && v.bill_number ? `<a class="inline-link vote-bill" href="${billHref(v.bill_id)}">${esc(v.bill_number)}</a>${v.bill_title ? `<p class="small">${esc(v.bill_title)}</p>` : ""}` : `<p class="vote-bill-text">${esc(v.subject || "")}</p>`}
  <p class="vote-question">${esc(v.question)} · Result: ${esc(v.result)}</p>
  <ul class="plain-list positions">${who}</ul>
  ${sourceLink(v.source_url, "Official record")}
</article>`;
}

function tagged(cardHtml, meeting) {
  // Add the "On this week's agenda" tag inside the issue card, under its label.
  const tag = `<span class="chip chip--agenda">On this week's agenda: ${esc(meeting.body)}, ${esc(when(meeting.starts_at).day)}</span>`;
  return cardHtml.replace(/(<p class="label">[\s\S]*?<\/p>)/, `$1\n  ${tag}`);
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
  const onAgenda = {};
  for (const l of links) {
    const m = meetings.find((x) => x.id === l.meeting_id);
    if (m && !onAgenda[l.issue_slug]) onAgenda[l.issue_slug] = m;
  }
  const slugs = Object.keys(ISSUES)
    .filter((s) => !level || ISSUES[s].level === level)
    .sort((a, b) => (onAgenda[b] ? 1 : 0) - (onAgenda[a] ? 1 : 0))
    .slice(0, 3);
  const issuesHtml = slugs.length
    ? slugs.map((s) => (onAgenda[s] ? tagged(ISSUE_CARDS[s], onAgenda[s]) : ISSUE_CARDS[s])).join("")
    : '<p class="secondary small empty-note">No issues at this level yet.</p>';

  // Your reps' latest votes
  const votesHtml = votes.rows.length
    ? votes.rows.map(voteItem).join("")
    : `<p class="secondary small empty-note">${
        level === "county"
          ? "Supervisors' votes will come from meeting minutes. That's coming next."
          : db
            ? "No final-passage votes loaded yet."
            : "Votes appear here once the data sync has run."
      }</p>`;

  const main = `
<header class="app-header">
  <a class="wordmark" href="/">The Pillory</a>
  <div class="header-meta"><strong>Calaveras County</strong><span>${esc(when(now).long || "")}</span></div>
</header>
<h1 class="visually-hidden">Home</h1>
${filterNav(level)}

<section class="stack home-section" aria-labelledby="h-week">
  <div class="section-head"><h2 class="label" id="h-week">This week</h2></div>
  <div class="stack-sm">${weekHtml}</div>
  <a class="inline-link" href="${withLevel("/meetings/", level === "federal" ? null : level)}">See all meetings →</a>
</section>

<section class="stack home-section home-issues" aria-labelledby="h-issues">
  <div class="section-head"><h2 class="label" id="h-issues">Issues near you</h2></div>
  <p class="banner">Sample issues, for layout only</p>
  ${issuesHtml}
  <a class="inline-link" href="/issues/">See all issues →</a>
</section>

<section class="stack home-section" aria-labelledby="h-votes">
  <div class="section-head"><h2 class="label" id="h-votes">Your reps' latest votes</h2></div>
  <p class="hint">Final-passage votes by officials who represent Calaveras County. Each links to the official record.</p>
  ${votesHtml}
  <a class="inline-link" href="${withLevel("/votes/", level === "county" ? null : level)}">See all votes →</a>
</section>

<p class="caught-up">You're caught up.</p>`;
  const res = page("Home", main, { tab: "home", root: true });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=120");
  return new Response(res.body, { status: res.status, headers });
}
