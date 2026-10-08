// /meetings/                     calendar: upcoming meetings and hearings, then recent ones
// /meetings/<id>/                one meeting: details, how to weigh in, agenda watch, full agenda, after the meeting
// /meetings/<id>/calendar.ics    add to calendar
// Anything else under /meetings/ (old sample meeting pages) redirects to the calendar.
import { page, notFound, esc, safeUrl, sourceLink, guard } from "../_lib/render.js";
import { summaryHead, contentsBar, fold, statusChip } from "../_lib/summary.js";
import { tagsFor, topicChips, TOPIC, topicName, topicHref } from "../_lib/topics.js";

// County meetings are Calaveras County's (the live community): topic chips open its topic pages.
const COUNTY_PLACE = { st: "CA", slug: "calaveras" };
import {
  listMeetings,
  summariesFor,
  meetingCard,
  meetingHref,
  pacificNow,
  addDays,
  when,
  deadlineParts,
  flagSummary,
  participantsText,
  FLAG_LABELS,
  LEVEL_LABEL,
} from "../_lib/meetings.js";

const REAL_ID = /^(iqm2|tmm|os)-[a-z0-9-]+$/;
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
  return withHeaders(page("Meetings", main, { tab: "home", back: ["Home", "/"] }));
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
    "PRODID:-//ThePillory//Meetings//EN",
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

// How the full agenda groups items, in the order the design lists them.
const KIND_GROUPS = [
  ["consent", "Consent calendar"],
  ["regular", "Regular items"],
  ["public_hearing", "Public hearings"],
  ["closed_session", "Closed session"],
];
const KIND_TAG = { consent: "Consent item", regular: "Action item", public_hearing: "Public hearing", closed_session: "Closed session" };

function itemDocs(it) {
  const atts = JSON.parse(it.attachments || "[]");
  const parts = [];
  if (safeUrl(it.staff_report_url)) parts.push(`<a class="inline-link" href="${esc(it.staff_report_url)}" target="_blank" rel="noopener">Staff report ↗</a>`);
  if (atts.length) parts.push(`<span class="small secondary">${atts.length} attachment${atts.length === 1 ? "" : "s"}${safeUrl(it.item_url) ? ` · <a class="tap" href="${esc(it.item_url)}" target="_blank" rel="noopener">item page ↗</a>` : ""}</span>`);
  else if (safeUrl(it.item_url)) parts.push(`<a class="inline-link" href="${esc(it.item_url)}" target="_blank" rel="noopener">Item page ↗</a>`);
  return parts.length ? `<div class="item-docs">${parts.join(" ")}</div>` : "";
}

function listRow(left, right, href) {
  const inner = `<span>${left}</span>${right ? `<span class="secondary">${right}</span>` : ""}`;
  return href
    ? `<a class="list-card-row list-card-row--link" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="list-card-row">${inner}</div>`;
}

async function meeting(env, id) {
  const db = env.DB;
  let m = null;
  try {
    m = db ? await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first() : null;
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) throw err;
  }
  if (!m) return notFound("No meeting at this address.", "home", ["Home", "/"]);
  const items = (await db.prepare("SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort").bind(id).all()).results;
  const summary = (await summariesFor(db, [id]))[id] || null;
  const byKey = new Map(((summary && summary.items) || []).map((s) => [s.item_key, s]));
  let itemTopics = new Map();
  if (m.level === "county" && items.length) {
    try {
      itemTopics = await tagsFor(db, "meeting_item", items.map((it) => `${id}/${it.item_key}`));
    } catch (err) {
      console.error(`meeting topics: ${err && err.message}`);
    }
  }
  const topicsOf = (it) => itemTopics.get(`${id}/${it.item_key}`) || [];
  const w = when(m.starts_at);
  const now = pacificNow();
  const past = m.starts_at < now;
  const src = safeUrl(m.source_url);
  const online = safeUrl(m.online_url);
  const state = m.level === "state";

  const status =
    m.status === "cancelled"
      ? '<p class="banner banner--error">This meeting was cancelled.</p>'
      : "";

  // How to weigh in
  let weighIn;
  if (state) {
    weighIn = `
<div class="weigh-row">
  <h3>Testify at the hearing</h3>
  <p class="small">State committee hearings take public testimony in person, and some take written positions ahead of time. ${src ? `<a href="${esc(src)}" target="_blank" rel="noopener">Committee hearing page ↗</a>` : ""}</p>
</div>`;
  } else {
    const d = deadlineParts(m);
    const email = m.comment_text && /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(m.comment_text);
    const quote = m.comment_text
      ? `<blockquote class="agenda-quote">${esc(m.comment_text)}</blockquote>${sourceLink(m.agenda_url, "Official agenda (PDF)")}`
      : m.body === "Board of Supervisors"
        ? `<blockquote class="agenda-quote">${esc(BOS_RULE.text)}</blockquote>${sourceLink(BOS_RULE.source, "Board of Supervisors: how to participate")}`
        : "";
    const written = [d ? `Due ${esc(d.label)}` : "", email ? `email <a href="mailto:${esc(email[0])}">${esc(email[0])}</a>` : ""].filter(Boolean).join(" · ");
    weighIn = `
<div class="weigh-row">
  <h3>Written comment</h3>
  <p class="small">${written || (quote ? "The agenda's instructions:" : `See the <a href="${esc(safeUrl(m.agenda_url) || src || "")}" target="_blank" rel="noopener">agenda</a> for how to comment.`)}</p>
  ${quote ? (written ? `<details class="weigh-details"><summary>The agenda's exact wording</summary>${quote}</details>` : quote) : ""}
</div>
<div class="weigh-row">
  <h3>Speak in person or online</h3>
  <p class="small">${esc(m.location || "Location: see the agenda")}${online ? ` · <a class="tap" href="${esc(online)}" target="_blank" rel="noopener">Join online ↗</a>` : ""}</p>
</div>`;
  }

  // Agenda watch: flagged items only
  const flagged = items
    .filter((it) => ((byKey.get(it.item_key) || {}).flags || []).length)
    .sort((a, b) => (byKey.get(a.item_key).rank || 99) - (byKey.get(b.item_key).rank || 99));
  const reviewed = summary && summary.status === "reviewed";
  const watchCards = flagged
    .map((it) => {
      const s = byKey.get(it.item_key);
      return `
  <article class="card watch-card">
    <div class="card-top"><span class="label">Item ${esc(it.number)} · ${s.flags.map((f) => esc(FLAG_LABELS[f] || f)).join(" · ")}</span><span class="card-top-note">${esc(KIND_TAG[it.section_kind] || it.section || "")}</span></div>
    <h3>${esc(it.title)}</h3>
    ${s.summary ? `<p class="small secondary">${esc(s.summary)}</p>` : ""}
    <a class="small inline-link" href="#item-${esc(it.item_key)}">In the full agenda</a>
  </article>`;
    })
    .join("");
  const watch = summary
    ? `
<section class="stack" id="agenda-watch" aria-labelledby="h-watch">
  <div class="section-head"><h2 class="label" id="h-watch">Agenda watch</h2><span class="small secondary">${flagged.length} of ${items.length} items, by public impact</span></div>
  ${watchCards || '<p class="small secondary">No items were flagged for budget, land use, fees, safety, or public access.</p>'}
  <p class="xsmall secondary">${
    reviewed
      ? `Summaries were drafted by AI from the official agenda and reviewed by ${esc(summary.reviewer)}.`
      : "Summaries are AI-drafted from the official agenda"
  } and flagged for budget, land use, fees, safety, and public access. Always check the source. <a class="tap" href="/about/methodology/#agenda-watch">How this is made</a></p>
</section>`
    : m.level === "county" && items.length
      ? `<section class="stack-sm" id="agenda-watch"><div class="section-head"><h2 class="label">Agenda watch</h2></div><p class="small secondary">Plain-language summaries of this agenda haven't been drafted yet.</p></section>`
      : "";

  // Full agenda: one expandable row per kind of item, then the official documents
  const groups = [];
  for (const it of items) {
    const known = KIND_GROUPS.find(([k]) => k === it.section_kind);
    const name = known ? known[1] : it.section || "Other items";
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, order: known ? KIND_GROUPS.indexOf(known) : -1, items: [] }));
    g.items.push(it);
  }
  groups.sort((a, b) => (a.order === -1 || b.order === -1 ? 0 : a.order - b.order));
  const groupRows = groups
    .map(
      (g) => `
  <details class="list-card-group">
    <summary class="list-card-row"><span>${esc(g.name)}</span><span class="secondary">${g.items.length} item${g.items.length === 1 ? "" : "s"}</span></summary>
    <ol class="plain-list agenda-items">
      ${g.items
        .map((it) => {
          const sm = byKey.get(it.item_key);
          return `<li class="agenda-item" id="item-${esc(it.item_key)}">
        <p><strong>${esc(it.number)}.</strong> ${esc(it.title)}</p>
        ${sm && sm.summary ? `<p class="small secondary"><span class="ai-label">AI summary:</span> ${esc(sm.summary)}</p>` : ""}
        ${topicChips(topicsOf(it), COUNTY_PLACE, { label: false })}
        ${itemDocs(it)}
      </li>`;
        })
        .join("")}
    </ol>
  </details>`
    )
    .join("");
  const posted = m.posted_at ? `posted ${esc(when(m.posted_at.slice(0, 16)).day)}` : "";
  const docRows = [
    safeUrl(m.agenda_url) ? listRow('<strong class="link-text">Official agenda (PDF) ↗</strong>', posted, m.agenda_url) : "",
    safeUrl(m.packet_url) ? listRow('<strong class="link-text">Agenda packet (PDF) ↗</strong>', "staff reports", m.packet_url) : "",
    src ? listRow(`<strong class="link-text">${state ? "Official hearing page" : "Meeting on the county portal"} ↗</strong>`, "source", src) : "",
  ].join("");
  const agendaNote = !items.length && m.level === "county"
    ? `<div class="list-card-row"><span class="small secondary">${m.agenda_url ? "The agenda's items haven't been read yet." : "The county hasn't posted the agenda yet. Agendas are posted at least 72 hours before a regular meeting."}</span></div>`
    : "";
  // Topics on this agenda: every topic its items are tagged with, most items first.
  const counts = new Map();
  for (const it of items) for (const t of topicsOf(it)) counts.set(t.topic, (counts.get(t.topic) || 0) + 1);
  const agendaTopics = [...counts.entries()].filter(([t]) => TOPIC[t]).sort((a, b) => b[1] - a[1]);
  const topicsRow = agendaTopics.length
    ? `<div class="list-card-row agenda-topics"><span class="label">Topics on this agenda</span><div class="chips chips--tight">${agendaTopics
        .map(([t, n]) => `<a class="chip chip--sm chip--topic" href="${topicHref(t, COUNTY_PLACE)}">${esc(topicName(t))} · ${n}</a>`)
        .join("")}</div><span class="hint">AI-tagged from each item's title and summary; a person can correct any tag. <a class="inline-link" href="/about/methodology/#topics">How topics work</a></span></div>`
    : "";
  const agenda = fold("agenda", state ? "Hearing details" : "Full agenda", `<div class="list-card">${topicsRow}${groupRows}${agendaNote}${docRows}</div>`, { meta: items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "" });

  // After the meeting
  const video = safeUrl(m.video_url);
  const after = !state
    ? fold("after", "After the meeting", `
  ${
    m.minutes_url || video
      ? `<ul class="plain-list weigh-list">
    ${m.minutes_url ? `<li>${sourceLink(m.minutes_url, "Minutes")}</li>` : '<li class="small secondary">Minutes: not published yet.</li>'}
    ${video ? `<li>${sourceLink(video, "Video")}</li>` : '<li class="small secondary">Video: not published yet.</li>'}
  </ul>
  <p class="small secondary">Each supervisor's vote on each item will be added from the minutes.</p>`
      : `<p>Minutes and video appear here once published. Each supervisor's vote will be added from the minutes.</p>
  ${m.body === "Board of Supervisors" ? sourceLink(BOS_VIDEO, "Live and past meetings: the County Clerk's YouTube channel") : ""}`
  }`, { meta: m.minutes_url || video ? "Published" : "Not yet", open: past && Boolean(m.minutes_url || video) })
    : "";

  const typeLabel = m.meeting_type || (state ? "Hearing" : "Meeting");
  // The summary: what's on the agenda, in counts, and what agenda watch flagged.
  const sumText = items.length
    ? `${items.length} item${items.length === 1 ? "" : "s"} on the agenda${summary ? `; agenda watch flagged ${flagged.length} for budget, land use, fees, safety or public access` : ""}.`
    : state
      ? "A committee hearing of the California Legislature."
      : m.agenda_url ? "The agenda is posted; its items haven't been read yet." : "The agenda isn't posted yet.";
  const meetingStatus = m.status === "cancelled" ? "Cancelled" : past ? "Took place" : "Upcoming";
  const head = summaryHead({
    kicker: `${esc(LEVEL_LABEL[m.level] || "")} · ${esc(typeLabel)}`,
    status: `${statusChip(meetingStatus)}<span class="meeting-when"><strong>${esc(w.long)}${w.time ? ` · ${esc(w.time)}` : ""}</strong></span>`,
    title: m.body,
    summary: { text: sumText, source: null },
    extra: `${
      m.location || online
        ? `<p class="small secondary">${esc(m.location || "")}${m.location && online ? " · " : ""}${online ? `Also online: <a class="tap" href="${esc(online)}" target="_blank" rel="noopener">meeting link ↗</a>` : ""}</p>`
        : ""
    }${state && participantsText(m) ? `<p class="small secondary">${esc(participantsText(m))}</p>` : ""}`,
  });
  const showWeigh = m.status !== "cancelled" && !past;
  const main = `
${contentsBar([["summary", "Summary"], showWeigh ? ["weigh-in", "Weigh in"] : [null], summary ? ["agenda-watch", "Agenda watch"] : [null], ["agenda", state ? "Details" : "Agenda"], !state ? ["after", "After"] : [null]])}
${head}
${status}
<div class="meeting-actions">
  <a class="btn" href="${meetingHref(m.id)}calendar.ics">Add to calendar</a>
</div>
${
  showWeigh
    ? `<section class="panel-navy weigh-panel" id="weigh-in" aria-labelledby="h-weigh"><h2 class="label label--navy" id="h-weigh">How to weigh in</h2>${weighIn}</section>`
    : ""
}
${watch}
${agenda}
${after}
<p class="hint">From the ${state ? "Open States record of the Legislature's schedule" : "county's official meeting portal"}. Each document links to its source.</p>`;
  return withHeaders(page(`${m.body}: ${w.day}`, main, { tab: "home", back: ["Home", "/"] }));
}

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}/meetings/${url.search}`, 301);
    return calendar(context.env, url);
  }
  const id = decodeURIComponent(parts[0]);
  if (!REAL_ID.test(id)) return Response.redirect(`${url.origin}/meetings/`, 301); // old sample meeting pages
  if (parts.length === 2 && parts[1] === "calendar.ics") {
    const m = context.env.DB ? await context.env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first() : null;
    return m ? ics(m) : notFound("No meeting at this address.", "home", ["Home", "/"]);
  }
  if (parts.length > 1) return notFound("No page at this address.", "home", ["Meetings", "/meetings/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  return meeting(context.env, id);
}, { tab: "home" });
