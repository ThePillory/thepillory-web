// /meetings/                     calendar: upcoming meetings and hearings, then recent ones
// /meetings/<id>/                one meeting: details, how to weigh in, agenda watch, full agenda, after the meeting
// /meetings/<id>/calendar.ics    add to calendar
// Anything else under /meetings/ (the sample meeting pages) is static and passed through.
import { ISSUES } from "../_lib/generated.js";
import { page, notFound, esc, safeUrl, sourceLink } from "../_lib/render.js";
import {
  listMeetings,
  summariesFor,
  approvedLinks,
  meetingCard,
  meetingHref,
  pacificNow,
  addDays,
  when,
  flagChips,
  shortDeadline,
  participantsText,
  FLAG_LABELS,
  LEVEL_LABEL,
} from "../_lib/meetings.js";

const REAL_ID = /^(iqm2|os)-[a-z0-9-]+$/;
// The Board's standing rule for written comments, from its own page (used when an agenda's wording isn't available).
const BOS_RULE = {
  text: "Send written comments, no later than 4:00 pm on the day before the meeting.",
  source: "https://bos.calaverasgov.us/Board-Meetings",
};
const BOS_VIDEO = "https://youtube.com/@CalaverasCountyClerk/streams";

function withHeaders(res, cache = "public, max-age=300") {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", cache);
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Calendar

async function calendar(env, url) {
  const level = ["county", "state"].includes(url.searchParams.get("level")) ? url.searchParams.get("level") : null;
  const now = pacificNow();
  let upcoming = [];
  let recent = [];
  let summaries = {};
  if (env.DB) {
    upcoming = await listMeetings(env.DB, { from: now, to: `${addDays(now.slice(0, 10), 120)}T23:59`, level, limit: 80 });
    recent = await listMeetings(env.DB, { from: `${addDays(now.slice(0, 10), -45)}T00:00`, to: now, level, limit: 20, order: "DESC" });
    summaries = await summariesFor(env.DB, [...upcoming, ...recent].map((m) => m.id));
  }
  const byMonth = {};
  for (const m of upcoming) (byMonth[when(m.starts_at).month] ||= []).push(m);
  const months = Object.entries(byMonth)
    .map(([month, ms]) => `<section class="stack-sm"><h2 class="label">${esc(month)}</h2>${ms.map((m) => meetingCard(m, summaries[m.id])).join("")}</section>`)
    .join("");
  const opt = (value, label) =>
    `<a class="toggle" href="/meetings/${value ? `?level=${value}` : ""}"${level === value ? ' aria-current="true"' : ""}>${label}</a>`;
  const main = `
<header class="page-head">
  <h1>Meetings</h1>
  <p class="subtitle">Calaveras County Board of Supervisors and Planning Commission agendas, and state committee hearings with our legislators.</p>
</header>
<nav class="segmented" aria-label="Show County or State">${opt(null, "All")}${opt("county", "County")}${opt("state", "State")}</nav>
${months || `<p class="secondary small empty-note">${env.DB ? "No upcoming meetings loaded." : "Meetings appear here once the data sync has run."}</p>`}
${
  recent.length
    ? `<section class="stack-sm"><h2 class="label">Recent</h2>${recent.map((m) => meetingCard(m, summaries[m.id])).join("")}</section>`
    : ""
}
<p class="hint">From the county's official meeting portal and Open States. Each meeting links to its source.</p>`;
  return withHeaders(page("Meetings", main, { tab: "home", back: ["Home", "/home/"] }));
}

// ---------------------------------------------------------------------------
// One meeting

function ics(m) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const local = m.starts_at.replace(/[-:]/g, "") + "00";
  const endH = String(Math.min(23, parseInt(m.starts_at.slice(11, 13), 10) + 2)).padStart(2, "0");
  const end = `${m.starts_at.slice(0, 10).replace(/-/g, "")}T${endH}${m.starts_at.slice(14, 16)}00`;
  const escIcs = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Pillory//Meetings//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE",
    "TZID:America/Los_Angeles",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0800",
    "TZOFFSETTO:-0700",
    "TZNAME:PDT",
    "DTSTART:19700308T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0700",
    "TZOFFSETTO:-0800",
    "TZNAME:PST",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${m.id}@thepillory.co`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=America/Los_Angeles:${local}`,
    `DTEND;TZID=America/Los_Angeles:${end}`,
    `SUMMARY:${escIcs(`${m.body}: ${m.meeting_type || "Meeting"}`)}`,
    m.location ? `LOCATION:${escIcs(m.location)}` : null,
    `URL:https://thepillory.co${meetingHref(m.id)}`,
    `DESCRIPTION:${escIcs(`Agenda and how to comment: https://thepillory.co${meetingHref(m.id)}\nOfficial source: ${m.source_url}\nEnd time is an estimate.`)}`,
    m.status === "cancelled" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${m.id}.ics"`,
      "Cache-Control": "public, max-age=300",
    },
  });
}

function aiBadge(summary) {
  if (summary.status === "reviewed") return `<span class="review-badge review-badge--reviewed">Reviewed by ${esc(summary.reviewer)}</span>`;
  return '<span class="review-badge review-badge--draft">AI-drafted from the official agenda</span>';
}

function issueLinksFor(links, key) {
  return links
    .filter((l) => l.item_key === key && ISSUES[l.issue_slug])
    .map((l) => `<a class="inline-link" href="${esc(ISSUES[l.issue_slug].url)}">Related issue: ${esc(ISSUES[l.issue_slug].short)}</a>`)
    .join("");
}

function itemDocs(it) {
  const atts = JSON.parse(it.attachments || "[]");
  const parts = [];
  if (safeUrl(it.staff_report_url)) parts.push(`<a class="inline-link" href="${esc(it.staff_report_url)}" target="_blank" rel="noopener">Staff report ↗</a>`);
  if (atts.length) parts.push(`<span class="small secondary">${atts.length} attachment${atts.length === 1 ? "" : "s"}${safeUrl(it.item_url) ? ` · <a href="${esc(it.item_url)}" target="_blank" rel="noopener">item page ↗</a>` : ""}</span>`);
  else if (safeUrl(it.item_url)) parts.push(`<a class="inline-link" href="${esc(it.item_url)}" target="_blank" rel="noopener">Item page ↗</a>`);
  return parts.length ? `<div class="item-docs">${parts.join(" ")}</div>` : "";
}

async function meeting(env, id) {
  const db = env.DB;
  let m = null;
  try {
    m = db ? await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first() : null;
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) throw err;
  }
  if (!m) return notFound("No meeting at this address.", "home", ["Meetings", "/meetings/"]);
  const items = (await db.prepare("SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort").bind(id).all()).results;
  const summary = (await summariesFor(db, [id]))[id] || null;
  const links = await approvedLinks(db, [id]);
  const byKey = new Map(((summary && summary.items) || []).map((s) => [s.item_key, s]));
  const w = when(m.starts_at);
  const now = pacificNow();
  const past = m.starts_at < now;
  const src = safeUrl(m.source_url);

  const status =
    m.status === "cancelled"
      ? '<p class="banner banner--error">This meeting was cancelled.</p>'
      : past
        ? '<p class="banner">This meeting has taken place. See "After the meeting" below.</p>'
        : "";

  // How to weigh in
  const deadline = shortDeadline(m);
  let weighIn;
  if (m.level === "state") {
    weighIn = `
<p>State committee hearings take public testimony in person, and some take written positions ahead of time. The committee's page has the details.</p>
${src ? `<a class="btn btn--primary" href="${esc(src)}" target="_blank" rel="noopener">Committee hearing page ↗</a>` : ""}`;
  } else {
    const fromAgenda = m.comment_text
      ? `<div class="stack-sm"><p class="label">From the official agenda</p><blockquote class="agenda-quote">${esc(m.comment_text)}</blockquote>${sourceLink(m.agenda_url, "Official agenda (PDF)")}</div>`
      : m.body === "Board of Supervisors"
        ? `<div class="stack-sm"><p class="label">The Board's standing rule</p><blockquote class="agenda-quote">${esc(BOS_RULE.text)}</blockquote>${sourceLink(BOS_RULE.source, "Board of Supervisors: how to participate")}</div>`
        : `<p class="small">The agenda says how to comment on this meeting.</p>${sourceLink(m.agenda_url || m.source_url, "Official agenda")}`;
    weighIn = `
${deadline ? `<p class="deadline deadline--lg">${esc(deadline)}</p>` : ""}
<ul class="plain-list weigh-list">
  <li><strong>In person:</strong> ${esc(m.location || "see the agenda")}</li>
  ${safeUrl(m.online_url) ? `<li><strong>Online:</strong> <a class="inline-link" href="${esc(m.online_url)}" target="_blank" rel="noopener">Join or register ↗</a></li>` : ""}
</ul>
${fromAgenda}`;
  }

  // Agenda watch (flagged items first)
  const flagged = items.filter((it) => (byKey.get(it.item_key) || {}).flags && byKey.get(it.item_key).flags.length);
  const watch = summary
    ? `
<section class="card stack" id="agenda-watch" aria-labelledby="h-watch">
  <div class="baseline-head"><h2 class="label" id="h-watch">Agenda watch</h2>${aiBadge(summary)}</div>
  <p class="small secondary">Plain-language summaries of the official agenda, with items flagged in five areas. Read the agenda for the exact wording.</p>
  ${
    flagged.length
      ? flagged
          .map((it) => {
            const s = byKey.get(it.item_key);
            const q = new URLSearchParams({ meeting: m.id, item: it.item_key });
            return `
  <article class="watch-item stack-sm">
    <p class="label">Item ${esc(it.number)} · ${esc(it.section || "")}</p>
    <h3>${esc(it.title)}</h3>
    ${s.summary ? `<p>${esc(s.summary)}</p>` : ""}
    <div class="chips">${s.flags.map((f) => `<span class="chip chip--flag">${esc(FLAG_LABELS[f] || f)}</span>`).join("")}</div>
    ${issueLinksFor(links, it.item_key)}
    <div class="watch-actions">
      <a class="btn" href="/join/?affected=${encodeURIComponent(`${m.id}:${it.item_key}`)}">I'm affected</a>
      <a class="btn btn--primary" href="/report/?${q}">File a report</a>
    </div>
  </article>`;
          })
          .join("")
      : '<p class="small">No items were flagged in the five areas.</p>'
  }
  <p class="small secondary">Areas: ${Object.values(FLAG_LABELS).map(esc).join(", ")}. <a href="/about/methodology/#agenda-watch">How this is made</a></p>
</section>`
    : m.level === "county" && items.length
      ? '<section class="card stack-sm"><h2 class="label">Agenda watch</h2><p class="small">Plain-language summaries of this agenda haven\'t been drafted yet.</p></section>'
      : "";

  // Full agenda by section
  const sections = [];
  for (const it of items) {
    let s = sections.find((x) => x.name === (it.section || ""));
    if (!s) sections.push((s = { name: it.section || "", kind: it.section_kind, items: [] }));
    s.items.push(it);
  }
  const agenda = items.length
    ? `
<section class="stack" id="agenda" aria-labelledby="h-agenda">
  <h2 class="label" id="h-agenda">Full agenda</h2>
  ${sections
    .map(
      (s) => `
  <div class="card stack-sm agenda-section">
    <h3>${esc(s.name || "Items")}</h3>
    <ol class="plain-list agenda-items">
      ${s.items
        .map((it) => {
          const sm = byKey.get(it.item_key);
          return `<li class="agenda-item" id="item-${esc(it.item_key)}">
        <p><strong>${esc(it.number)}.</strong> ${esc(it.title)}</p>
        ${sm && sm.summary ? `<p class="small secondary"><span class="ai-label">AI summary:</span> ${esc(sm.summary)}</p>` : ""}
        ${itemDocs(it)}
      </li>`;
        })
        .join("")}
    </ol>
  </div>`
    )
    .join("")}
</section>`
    : m.level === "county"
      ? `<section class="card stack-sm"><h2 class="label">Agenda</h2><p class="small">${m.agenda_url ? "The agenda's items haven't been read yet." : "The county hasn't posted the agenda yet. Agendas are posted at least 72 hours before a regular meeting."}</p></section>`
      : "";

  const docs = [
    m.agenda_url ? sourceLink(m.agenda_url, "Official agenda (PDF)") : "",
    m.packet_url ? sourceLink(m.packet_url, "Agenda packet with staff reports (PDF)") : "",
    src ? sourceLink(src, m.level === "state" ? "Official hearing page" : "Meeting on the county portal") : "",
  ]
    .filter(Boolean)
    .join("");

  const video = safeUrl(m.video_url) || (m.body === "Board of Supervisors" ? BOS_VIDEO : null);
  const after =
    m.level === "county"
      ? `
<section class="card stack-sm" id="after" aria-labelledby="h-after">
  <h2 class="label" id="h-after">After the meeting</h2>
  <ul class="plain-list weigh-list">
    <li>${m.minutes_url ? sourceLink(m.minutes_url, "Minutes") : '<span class="small secondary">Minutes: not published yet.</span>'}</li>
    <li>${video ? sourceLink(video, safeUrl(m.video_url) ? "Video" : "Video: the County Clerk's YouTube channel") : '<span class="small secondary">Video: not published yet.</span>'}</li>
  </ul>
  <p class="small secondary">How each supervisor voted on each item will be added from the minutes.</p>
</section>`
      : "";

  const main = `
<header class="page-head">
  <p class="label">${esc(LEVEL_LABEL[m.level] || "")} · ${esc(m.body)}</p>
  <h1>${esc(m.meeting_type || "Meeting")}</h1>
  <p class="meeting-when"><strong>${esc(w.long)}</strong>${w.time ? ` · ${esc(w.time)}` : ""}</p>
  ${m.location ? `<p class="secondary small">${esc(m.location)}</p>` : ""}
  ${m.level === "state" && participantsText(m) ? `<p class="secondary small">${esc(participantsText(m))}</p>` : ""}
  ${summary ? `<div class="chips">${flagChips(summary)}</div>` : ""}
</header>
${status}
<div class="meeting-actions">
  <a class="btn" href="${meetingHref(m.id)}calendar.ics">Add to calendar</a>
  <a class="btn" href="/join/?follow=${encodeURIComponent(m.id)}">Follow</a>
</div>
${
  m.status !== "cancelled" && !past
    ? `<section class="card stack-sm" id="weigh-in" aria-labelledby="h-weigh"><h2 class="label" id="h-weigh">How to weigh in</h2>${weighIn}</section>`
    : ""
}
${watch}
${agenda}
${docs ? `<section class="stack-sm"><h2 class="label">Official documents</h2><div class="stack-sm">${docs}</div></section>` : ""}
${after}
<p class="hint">${m.posted_at ? `Agenda published ${esc(when(m.posted_at.slice(0, 16)).long || "")}. ` : ""}From the ${m.level === "state" ? "Open States record of the Legislature's schedule" : "county's official meeting portal"}.</p>`;
  return withHeaders(page(`${m.body}: ${w.day}`, main, { tab: "home", back: ["Meetings", "/meetings/"] }));
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}/meetings/${url.search}`, 301);
    return calendar(context.env, url);
  }
  const id = decodeURIComponent(parts[0]);
  if (!REAL_ID.test(id)) return context.next(); // sample meeting pages (static)
  if (parts.length === 2 && parts[1] === "calendar.ics") {
    const m = context.env.DB ? await context.env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first() : null;
    return m ? ics(m) : notFound("No meeting at this address.", "home", ["Meetings", "/meetings/"]);
  }
  if (parts.length > 1) return notFound("No page at this address.", "home", ["Meetings", "/meetings/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  return meeting(context.env, id);
}
