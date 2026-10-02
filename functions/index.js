// /: Home, the hub, for every visitor (thepillory.co itself). First-time
// visitors get a short intro they can dismiss (remembered in the browser).
// A visitor whose districts are known (the pillory_districts cookie, set by the
// lookup) also gets a link to their briefing at /briefing/. The old ?hub=1 flag
// redirects here; /home/ redirects here.
//
// The hub, top to bottom:
//   headline; Find your representatives (address or ZIP; nothing stored);
//   Happening now (Congress / California: latest final-passage votes, ?now=state);
//   Take part (Calaveras comment deadlines, contacting your reps);
//   Communities (Calaveras, live; the county waitlist with real counts);
//   Understand (explainers).
import { page, esc } from "./_lib/render.js";
import { listMeetings, pacificNow, addDays, deadlineParts, meetingHref, when } from "./_lib/meetings.js";
import { districtsFromCookie, describe, STATE_NAME } from "./_lib/districts.js";
import { happeningNow, happeningSection, lookupForm, waitlistCounts } from "./_lib/hub.js";
import { turnstileReady, turnstileWidget, turnstileScript } from "./_lib/turnstile.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

const WAITLIST_MESSAGES = {
  joined: "Thank you. We'll email you only when ThePillory launches in your county.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "That's enough sign-ups from this connection for today. Please try again tomorrow.",
  invalid: "Choose a state and county, and enter an email address.",
  closed: "The list isn't open yet.",
};

function takePart(deadlines, loaded) {
  const rows = deadlines.length
    ? deadlines
        .map(({ m, d }) => {
          const w = when(m.starts_at);
          return `
<a class="list-row link-row" href="${meetingHref(m.id)}#weigh-in">
  <div><div class="list-title">Written comments by ${esc(d.label)}</div><div class="list-meta">${esc(m.body)} · meets ${esc([w.day, w.time].filter(Boolean).join(", "))}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
        })
        .join("")
    : `<p class="small secondary">${
        loaded ? "No written-comment deadlines posted for the next 30 days. Public comment is also taken at each meeting." : "Comment deadlines appear here once the data sync has run."
      }</p>`;
  // TODO: federal agency comment periods (Regulations.gov). Not built yet.
  return `
<section class="brief-section" id="take-part" aria-labelledby="h-take-part">
  <div class="section-head"><h2 class="label" id="h-take-part">Take part</h2><a class="section-link" href="/meetings/?level=county">County meetings</a></div>
  <div class="card stack-sm">
    <p class="label">Calaveras County comment deadlines</p>
    <div>${rows}</div>
  </div>
  <div class="card">
    <a class="list-row link-row" href="/reps/">
      <div><div class="list-title">Contact your representatives</div><div class="list-meta">Each rep's page links to their official website and office.</div></div>
      <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
    </a>
  </div>
</section>`;
}

function stateOptions(selected) {
  return Object.entries(STATE_NAME)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === selected ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
}

function communities(env, counts, msg, error) {
  const ready = turnstileReady(env);
  const countLine = counts
    ? counts.people
      ? `<p class="small"><strong>${counts.people}</strong> ${counts.people === 1 ? "person is" : "people are"} waiting in <strong>${counts.counties}</strong> ${counts.counties === 1 ? "county" : "counties"}.</p>`
      : '<p class="small secondary">No one is on the list yet.</p>'
    : "";
  const form = ready
    ? `
  <form class="stack-sm waitlist-form" method="post" action="/api/waitlist" data-county-picker>
    <div class="field-row">
      <label class="field"><span class="label">State</span>
        <select class="input" name="state" required><option value="">Choose a state</option>${stateOptions("")}</select>
      </label>
      <label class="field"><span class="label">County</span>
        <select class="input" name="county" required><option value="">Choose a state first</option></select>
      </label>
    </div>
    <label class="field"><span class="label">Email</span>
      <input class="input" type="email" name="email" autocomplete="email" required maxlength="254" />
    </label>
    <p class="hint">Your email is used only to announce your county's launch. It's never shown or shared.</p>
    ${turnstileWidget(env)}
    <button class="btn btn--primary" type="submit">Join the list</button>
    <noscript><p class="small secondary">Choosing a county needs JavaScript.</p></noscript>
  </form>`
    : '<p class="small secondary">The list isn\'t open yet.</p>';
  return `
<section class="brief-section" id="communities" aria-labelledby="h-communities">
  <div class="section-head"><h2 class="label" id="h-communities">Communities</h2></div>
  <a class="card community-card stack-sm" href="/calaveras/">
    <div class="card-top"><span class="label">California</span><span class="live-tag">Live</span></div>
    <h3>Calaveras County</h3>
    <p class="small secondary">County meetings and agendas, comment deadlines, and every recorded vote by the officials who represent the county.</p>
    <span class="inline-link">Open the Calaveras briefing</span>
  </a>
  <div class="card stack-sm">
    <h3>Bring ThePillory to your county</h3>
    <p class="small">Communities open one county at a time. Tell us where you are, and we'll let you know when yours opens.</p>
    ${msg ? `<p class="banner" role="status">${esc(msg)}</p>` : ""}
    ${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
    ${form}
    ${countLine}
  </div>
</section>`;
}

const UNDERSTAND = [
  ["/laws/constitution/", "The Constitution", "The full text, and how every analysis starts from it."],
  ["/about/how-a-bill-becomes-law/", "How a bill becomes law", "From introduction to signature, in Congress and in California."],
  ["/about/how-to-read-a-vote/", "How to read a vote", "Final passage, cloture, motions and nominations."],
  ["/about/how-it-works/", "How ThePillory works", "Evidence first, protected identities, no party labels."],
];

function understand() {
  return `
<section class="brief-section" id="understand" aria-labelledby="h-understand">
  <div class="section-head"><h2 class="label" id="h-understand">Understand</h2></div>
  <div class="tile-grid">
    ${UNDERSTAND.map(([href, title, sub]) => `<a class="card tile" href="${href}"><h3>${esc(title)}</h3><p class="small secondary">${esc(sub)}</p></a>`).join("")}
  </div>
</section>`;
}

async function hub(env, url, d) {
  const which = url.searchParams.get("now") === "state" ? "state" : "federal";
  const db = env.DB;
  let now = [];
  let deadlines = [];
  let counts = null;
  if (db) {
    try {
      now = await happeningNow(db, which, { limit: 4 });
      const start = pacificNow();
      const meetings = await listMeetings(db, { from: start, to: `${addDays(start.slice(0, 10), 30)}T23:59`, level: "county", limit: 30 });
      deadlines = meetings
        .filter((m) => m.status !== "cancelled")
        .map((m) => ({ m, d: deadlineParts(m) }))
        .filter((x) => x.d && x.d.date >= start.slice(0, 10))
        .slice(0, 4);
      counts = await waitlistCounts(db);
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
  const joined = url.searchParams.get("waitlist");
  const msg = joined === "joined" ? WAITLIST_MESSAGES.joined : "";
  const error = joined && joined !== "joined" ? WAITLIST_MESSAGES[joined] || "" : "";
  const notFound = url.searchParams.get("lookup") === "notfound";

  const main = `
<header class="hub-head stack-sm">
  <h1 class="hub-title">Know what your government is doing. Then take part.</h1>
  <p class="hub-sub">Votes, bills, and meetings in plain language, measured against the Constitution. Built on evidence, open to every point of view.</p>
</header>
${d ? `<a class="card briefing-link" href="/briefing/"><span class="stack-xs"><span class="label">Your briefing</span><span class="small">${esc(describe(d))}</span></span><span class="chev" aria-hidden="true">›</span></a>` : ""}
<aside class="intro-banner" data-intro hidden aria-label="Welcome">
  <p><strong>New here?</strong> ThePillory keeps a public, sourced record of what your officials do: every recorded vote, the bills they vote on mapped to the Constitution, local meeting agendas, and the money around them. Facts and sources, no party labels.</p>
  <p><a class="inline-link" href="/about/how-it-works/">How it works</a> · <a class="inline-link" href="/about/principles/">Principles</a></p>
  <button class="intro-dismiss" type="button" data-intro-dismiss aria-label="Dismiss this introduction">×</button>
</aside>
${notFound ? '<p class="banner banner--error" role="alert">We couldn\'t find districts for that. Check the address, or try your ZIP code.</p>' : ""}
${lookupForm(d)}
${happeningSection(now, which, { hrefFor: (v) => (v === "federal" ? "/" : "/?now=state"), loaded: !!db })}
${takePart(deadlines, !!db)}
${communities(env, counts, msg, error)}
${understand()}
${turnstileReady(env) ? turnstileScript : ""}`;
  return page("Know what your government is doing", main, { tab: "home", root: true, personal: true });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  // The hub used to need ?hub=1 for visitors with saved districts; it's at / now.
  if (url.searchParams.has("hub")) {
    url.searchParams.delete("hub");
    return Response.redirect(`${url.origin}/${url.search}${url.hash}`, 301);
  }
  return hub(env, url, districtsFromCookie(request));
}
