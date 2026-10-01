// The two briefings:
//   calaverasBriefing   the full county briefing (the former Home): this week's
//                       meetings and hearings, issues, and the county's reps'
//                       latest votes. Served at /calaveras/, and at / for a
//                       visitor whose districts are in Calaveras County.
//   personalBriefing    for a visitor elsewhere: their federal (and in
//                       California, state) reps, those reps' latest votes,
//                       and Happening now.
// Both link back to the hub (/?hub=1).
import { EMPTY_REPORTS } from "./generated.js";
import { page, esc, fmtDate } from "./render.js";
import { recentFinalVotes, officialsWhere, homeDistricts } from "./data.js";
import { billHref } from "./votes.js";
import { listMeetings, summariesFor, meetingCard, pacificNow, addDays, when } from "./meetings.js";
import { repsWhere, describe, isCalaveras } from "./districts.js";
import { happeningNow, happeningSection, lookupForm } from "./hub.js";

const LEVELS = ["county", "state", "federal"];
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

function sectionHead(id, title, href, linkText) {
  return `<div class="section-head"><h2 class="label" id="${id}">${title}</h2>${href ? `<a class="section-link" href="${href}">${linkText}</a>` : ""}</div>`;
}

/** One row per official's position: name, bill · Final passage · result · date, and the position. */
export function voteRows(votes, max) {
  const rows = [];
  for (const v of votes) {
    for (const p of v.positions || []) {
      if (rows.length >= max) break;
      const facts = `${esc(v.bill_number || v.subject || "")} · Final passage · ${esc(v.result)} · ${fmtDate(v.vote_date)}`;
      // The bill page has the official record for every vote.
      const meta = v.bill_id ? `<a class="brief-vote-meta xsmall" href="${billHref(v.bill_id)}#votes">${facts}</a>` : `<span class="xsmall secondary">${facts}</span>`;
      rows.push(`
  <li class="brief-vote">
    <div class="brief-vote-main">
      <a class="brief-vote-name" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a>
      ${meta}
    </div>
    <span class="brief-vote-position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span>
  </li>`);
    }
  }
  return rows.join("");
}

function briefHead(title, sub, { hubLink = true, now } = {}) {
  return `
<header class="brief-head">
  <div class="stack-xs">
    <h1 class="brief-title">${esc(title)}</h1>
    <p class="small secondary">${sub}</p>
  </div>
  ${hubLink ? `<p class="small brief-links"><a class="inline-link" href="/?hub=1">ThePillory hub</a> · <a class="inline-link" href="/#find">Change location</a></p>` : ""}
  ${now ? `<p class="xsmall secondary">Your briefing · ${esc(now)}</p>` : ""}
</header>`;
}

const caughtUp = `
<div class="caught-up">
  <span class="caught-up-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg></span>
  <div class="stack-xs"><strong>You're caught up</strong><span class="small secondary">That's everything for this week.</span></div>
</div>`;

/**
 * The Calaveras County briefing. `visitor`: the visitor's own districts when
 * they're in the county (their state districts may differ from the county
 * seat's); otherwise the county's own districts from the sync.
 */
export async function calaverasBriefing(env, url, visitor = null) {
  const level = LEVELS.includes(url.searchParams.get("level")) ? url.searchParams.get("level") : null;
  const base = url.pathname;
  const now = pacificNow();
  const weekEnd = `${addDays(now.slice(0, 10), 7)}T23:59`;

  let meetings = [];
  let summaries = {};
  let votes = { rows: [], more: false };
  const db = env.DB;
  if (db) {
    try {
      meetings = (await listMeetings(db, { from: now, to: weekEnd, level: level === "federal" ? "none" : level, limit: 20 })).filter((m) => m.status !== "cancelled");
      summaries = await summariesFor(db, meetings.map((m) => m.id));
      if (level !== "county") {
        const d = visitor && isCalaveras(visitor) ? visitor : await homeDistricts(db);
        const reps = await officialsWhere(db, repsWhere(d));
        votes = await recentFinalVotes(db, { level, limit: 3, officialIds: reps.map((o) => o.id) });
      }
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }

  const filterNav = () => {
    const opt = (value, label) =>
      `<a class="toggle" href="${value ? `${base}?level=${value}` : base}"${(level || null) === value ? ' aria-current="true"' : ""}>${label}</a>`;
    return `<nav class="pill-filter" aria-label="Scope">${opt(null, "All")}${opt("county", "County")}${opt("state", "State")}${opt("federal", "Federal")}</nav>`;
  };
  const withLevel = (href, l) => (l ? `${href}${href.includes("?") ? "&" : "?"}level=${l}` : href);

  const week = meetings.slice(0, 3);
  const weekHtml = week.length
    ? week.map((m) => meetingCard(m, summaries[m.id])).join("")
    : `<p class="secondary small empty-note">${
        !db ? "Meetings appear here once the data sync has run." : level === "federal" ? "Congress's schedule isn't tracked here yet." : "Nothing scheduled in the next seven days."
      }</p>`;
  const rows = voteRows(votes.rows, 3);
  const votesHtml = rows
    ? `<ul class="card plain-list brief-votes">${rows}</ul>`
    : `<p class="secondary small empty-note">${
        level === "county" ? "Supervisors' votes will come from meeting minutes. That's coming next." : db ? "No final-passage votes loaded yet." : "Votes appear here once the data sync has run."
      }</p>`;

  const main = `
${briefHead("Calaveras County", "Live · the county's meetings and the votes of the officials who represent it", { hubLink: base === "/", now: when(now).long || "" })}
<aside class="intro-banner" data-intro hidden aria-label="Welcome">
  <p><strong>New here?</strong> ThePillory keeps a public, sourced record of what the officials who represent Calaveras County do: their votes, the bills they vote on mapped to the Constitution, and what's on county meeting agendas.</p>
  <p><a class="inline-link" href="/about/how-it-works/">How it works</a></p>
  <button class="intro-dismiss" type="button" data-intro-dismiss aria-label="Dismiss this introduction">×</button>
</aside>
${filterNav()}

<section class="brief-section" aria-labelledby="h-week">
  ${sectionHead("h-week", "This week", withLevel("/meetings/", level === "federal" ? null : level), "See all meetings")}
  ${weekHtml}
</section>

<section class="brief-section" aria-labelledby="h-issues">
  ${sectionHead("h-issues", "Issues near you")}
  ${EMPTY_REPORTS}
</section>

<section class="brief-section" aria-labelledby="h-votes">
  ${sectionHead("h-votes", "Your reps' latest votes", withLevel("/votes/", level === "county" ? null : level), "See all votes")}
  ${votesHtml}
</section>
${caughtUp}`;
  return page("Calaveras County briefing", main, { tab: "home", root: base === "/", back: base === "/" ? null : ["Home", "/?hub=1"], personal: true });
}

/** The briefing for a visitor outside Calaveras County. */
export async function personalBriefing(env, url, d) {
  const which = url.searchParams.get("now") === "state" ? "state" : "federal";
  const db = env.DB;
  let reps = [];
  let votes = { rows: [] };
  let now = [];
  if (db) {
    try {
      reps = await officialsWhere(db, repsWhere(d));
      const ids = reps.map((o) => o.id);
      votes = await recentFinalVotes(db, { limit: 5, officialIds: ids });
      now = await happeningNow(db, which, { limit: 4, officialIds: ids });
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
  const inCA = d.st === "CA";
  const repRows = reps.length
    ? reps
        .map(
          (o) => `
<a class="list-row link-row" href="/reps/${esc(o.slug)}/">
  <div><div class="list-title">${esc(o.name)}</div><div class="list-meta">${esc([o.office, o.district].filter(Boolean).join(" · "))}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`
        )
        .join("")
    : `<p class="secondary small">${db ? "Not loaded yet. Members of Congress appear after the data sync runs." : "Reps appear here once the data sync has run."}</p>`;
  const coverage = inCA
    ? "State and federal coverage for your districts. County coverage comes as communities launch."
    : "Federal coverage for now. State and local coverage comes as communities launch.";
  const rows = voteRows(votes.rows, 5);
  const main = `
${briefHead("Your briefing", esc(describe(d)))}
<p class="panel-navy small">${esc(coverage)} <a class="inline-link" href="/?hub=1#communities">Bring ThePillory to your county</a></p>

<section class="brief-section" aria-labelledby="h-reps">
  ${sectionHead("h-reps", "Your representatives", "/reps/", "All reps")}
  <div class="card">${repRows}</div>
</section>

<section class="brief-section" aria-labelledby="h-votes">
  ${sectionHead("h-votes", "Your reps' latest votes", "/votes/", "See all votes")}
  ${rows ? `<ul class="card plain-list brief-votes">${rows}</ul>` : `<p class="secondary small empty-note">${db ? "No final-passage votes loaded yet for your reps." : "Votes appear here once the data sync has run."}</p>`}
</section>

${happeningSection(now, which, { hrefFor: (v) => (v === "federal" ? "/" : `/?now=${v}`), personal: true, loaded: !!db })}
${caughtUp}`;
  return page("Your briefing", main, { tab: "home", root: true, personal: true });
}
