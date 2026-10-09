// The two briefings:
//   calaverasBriefing   the full county briefing: this week's meetings and
//                       hearings, issues, and the county's reps' latest votes.
//                       Served at /calaveras/, and at /briefing/ for a visitor
//                       whose districts are in Calaveras County.
//   personalBriefing    for a visitor elsewhere: their federal (and in
//                       California, state) reps, those reps' latest votes,
//                       and Happening now.
// Both link back to the hub (/).
import { coverageFor, votesLoaded } from "./coverage.js";
import { STATE_NAME } from "./districts.js";
import { EMPTY_REPORTS } from "./generated.js";
import { page, esc, fmtDate, loadSection, FAILED, anyFailed, sectionError } from "./render.js";
import { recentFinalVotes, officialsWhere, homeDistricts } from "./data.js";
import { billHref } from "./votes.js";
import { listMeetings, summariesFor, meetingCard, pacificNow, addDays, when } from "./meetings.js";
import { repsWhere, describe, isCalaveras } from "./districts.js";
import { happeningNow, happeningSection, lookupForm } from "./hub.js";

const LEVELS = ["county", "state", "federal"];

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
  ${hubLink ? `<p class="small brief-links"><a class="inline-link" href="/">ThePillory hub</a> · <a class="inline-link" href="/#find">Change location</a></p>` : ""}
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

  const db = env.DB;
  // Each section loads on its own: one that can't load shows a short note.
  const [meetingsLoaded, votes] = await Promise.all([
    db
      ? loadSection("briefing meetings", async () => {
          const meetings = (await listMeetings(db, { from: now, to: weekEnd, level: level === "federal" ? "none" : level, limit: 20 })).filter((m) => m.status !== "cancelled");
          return { meetings, summaries: await summariesFor(db, meetings.map((m) => m.id)) };
        }, { meetings: [], summaries: {} })
      : { meetings: [], summaries: {} },
    db && level !== "county"
      ? loadSection("briefing votes", async () => {
          const d = visitor && isCalaveras(visitor) ? visitor : await homeDistricts(db);
          const reps = await officialsWhere(db, repsWhere(d));
          return recentFinalVotes(db, { level, limit: 3, officialIds: reps.map((o) => o.id) });
        }, { rows: [], more: false })
      : { rows: [], more: false },
  ]);
  const { meetings, summaries } = meetingsLoaded === FAILED ? { meetings: [], summaries: {} } : meetingsLoaded;

  const filterNav = () => {
    const opt = (value, label) =>
      `<a class="toggle" href="${value ? `${base}?level=${value}` : base}"${(level || null) === value ? ' aria-current="true"' : ""}>${label}</a>`;
    return `<nav class="pill-filter" aria-label="Scope">${opt(null, "All")}${opt("county", "County")}${opt("state", "State")}${opt("federal", "Federal")}</nav>`;
  };
  const withLevel = (href, l) => (l ? `${href}${href.includes("?") ? "&" : "?"}level=${l}` : href);

  const week = meetings.slice(0, 3);
  const weekHtml = meetingsLoaded === FAILED ? sectionError("") : week.length
    ? week.map((m) => meetingCard(m, summaries[m.id])).join("")
    : `<p class="secondary small empty-note">${
        !db ? "Meetings appear here once the data sync has run." : level === "federal" ? "Congress's schedule isn't tracked here yet." : "Nothing scheduled in the next seven days."
      }</p>`;
  const rows = votes === FAILED ? "" : voteRows(votes.rows, 3);
  const votesHtml = votes === FAILED ? sectionError("") : rows
    ? `<ul class="card plain-list brief-votes">${rows}</ul>`
    : `<p class="secondary small empty-note">${
        level === "county" ? "Supervisors' votes will come from meeting minutes. That's coming next." : db ? "No final-passage votes loaded yet." : "Votes appear here once the data sync has run."
      }</p>`;

  const main = `
${briefHead("Calaveras County", "Live · the county's meetings and the votes of the officials who represent it", { hubLink: base === "/briefing/", now: when(now).long || "" })}
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
  return page("Calaveras County briefing", main, { tab: "home", back: ["Home", "/"], personal: true, partial: anyFailed(meetingsLoaded, votes) });
}

/** The briefing for a visitor outside Calaveras County. */
export async function personalBriefing(env, url, d) {
  const db = env.DB;
  // The visitor's state in Happening now, once its votes are loaded ("state" means California).
  const cov = d.st === "CA" ? null : await loadSection("briefing coverage", () => coverageFor(db, d.st), null);
  const stateLoaded = votesLoaded(d.st, cov === FAILED ? null : cov);
  const stateOption = stateLoaded ? { value: d.st === "CA" ? "state" : `state:${d.st}`, name: STATE_NAME[d.st] || d.st } : null;
  const which = stateOption && url.searchParams.get("now") === stateOption.value ? stateOption.value : "federal";
  const repsLoaded = db ? await loadSection("briefing reps", () => officialsWhere(db, repsWhere(d)), []) : [];
  const reps = repsLoaded === FAILED ? [] : repsLoaded;
  const ids = reps.map((o) => o.id);
  const [votes, now] = await Promise.all([
    db && ids.length ? loadSection("briefing votes", () => recentFinalVotes(db, { limit: 5, officialIds: ids }), { rows: [] }) : { rows: [] },
    db ? loadSection("briefing happening now", () => happeningNow(db, which, { limit: 4, officialIds: ids }), []) : [],
  ]);
  const inCA = d.st === "CA";
  const repRows = repsLoaded === FAILED ? sectionError("") : reps.length
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
  const coverage = inCA || stateLoaded
    ? "State and federal coverage for your districts. County coverage comes as communities launch."
    : `Your members of Congress and state legislators, with Congress's votes. ${STATE_NAME[d.st] || "Your state"}'s bills and votes are coming soon, loaded state by state. County coverage comes as communities launch.`;
  const rows = votes === FAILED ? "" : voteRows(votes.rows, 5);
  const main = `
${briefHead("Your briefing", esc(describe(d)))}
<p class="panel-navy small">${esc(coverage)} <a class="inline-link" href="/#communities">Bring ThePillory to your county</a></p>

<section class="brief-section" aria-labelledby="h-reps">
  ${sectionHead("h-reps", "Your representatives", "/reps/", "All reps")}
  <div class="card">${repRows}</div>
</section>

<section class="brief-section" aria-labelledby="h-votes">
  ${sectionHead("h-votes", "Your reps' latest votes", "/votes/", "See all votes")}
  ${votes === FAILED ? sectionError("") : rows ? `<ul class="card plain-list brief-votes">${rows}</ul>` : `<p class="secondary small empty-note">${db ? "No final-passage votes loaded yet for your reps." : "Votes appear here once the data sync has run."}</p>`}
</section>

${now === FAILED ? sectionError("Happening now") : happeningSection(now, which, { hrefFor: (v) => (v === "federal" ? "/briefing/" : `/briefing/?now=${v}`), personal: true, loaded: !!db, state: stateOption })}
${caughtUp}`;
  return page("Your briefing", main, { tab: "home", back: ["Home", "/"], personal: true, partial: anyFailed(repsLoaded, votes, now) });
}
