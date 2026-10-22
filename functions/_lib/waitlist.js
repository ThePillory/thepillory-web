// "Bring ThePillory to your county": the waitlist form (county and email,
// Turnstile, POST /api/waitlist) and the live communities, on its own page,
// /waitlist/ (functions/waitlist/index.js). The home page and every state page
// link here with one line, "Coming to [State]: … Join the list ›".
import { icon } from "./icons.js";
import { esc } from "./render.js";
import { STATE_NAME } from "./districts.js";
import { turnstileReady, turnstileWidget } from "./turnstile.js";

export const WAITLIST_MESSAGES = {
  joined: "Thank you. We'll email you only when ThePillory launches in your county.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "That's enough sign-ups from this connection for today. Please try again tomorrow.",
  invalid: "Choose a state and county, and enter an email address.",
  closed: "The list isn't open yet.",
};

/** The waitlist page's address, for a state when given. */
export const waitlistHref = (st = null) => (st ? `/waitlist/?state=${st}` : "/waitlist/");

export function stateOptions(selected) {
  return Object.entries(STATE_NAME)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === selected ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
}

/** The live communities and the form. `counts`: waitlistCounts() or null. */
export function communities(env, counts, msg, error, st = "") {
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
        <select class="input" name="state" required><option value="">Choose a state</option>${stateOptions(st)}</select>
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
<section class="card stack-sm" id="join" aria-labelledby="h-join">
  <h2 class="label" id="h-join">Join the list</h2>
  <p class="small">Communities open one county at a time. Tell us where you are, and we'll let you know when yours opens.</p>
  ${msg ? `<p class="banner" role="status">${esc(msg)}</p>` : ""}
  ${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
  ${form}
  ${countLine}
</section>
<section class="stack-sm" id="communities" aria-labelledby="h-communities">
  <h2 class="label" id="h-communities">Live now</h2>
  <a class="card community-card icon-row" href="/calaveras/">
    <span class="icon-badge">${icon("community")}</span>
    <div class="stack-xs">
      <h3>Calaveras County, CA</h3>
      <p class="small secondary">Meetings, agenda watch, comment deadlines, and every recorded vote by the officials who represent the county.</p>
    </div>
    <span class="live-tag">Live</span>
  </a>
</section>`;
}
