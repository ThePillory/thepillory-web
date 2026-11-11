// The weekly email's pages (docs/email.md): the signup form at /email/, and the pages a
// subscriber's own links open: confirm, Change my place, unsubscribe. Every link from an email
// opens a page with a button rather than acting on the click, so a mail scanner that opens
// links can't confirm or unsubscribe anyone. Pure HTML; tested.
import { esc } from "./render.js";
import { turnstileReady, turnstileWidget } from "./turnstile.js";
import { describe } from "./districts.js";

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const TOKEN_RE = /^[a-f0-9]{48}$/;

const ERRORS = {
  email: "That doesn't look like an email address.",
  zip: "That ZIP code isn't one of the Census Bureau's ZIP code areas. Check it, or choose the National edition.",
  "zip-missing": "Enter your 5-digit ZIP code, or choose another option.",
  "address-missing": "Enter your street address, city and state, or choose another option.",
  address: "The Census Bureau couldn't find that address. Check the street, city and state, or use your ZIP code.",
  lookup: "The Census address lookup didn't answer. Try again in a minute, or use your ZIP code.",
  check: "The check didn't go through. Please try again.",
  limit: "That's enough sign-ups from here for today. Please try again tomorrow.",
  closed: "Sign-up isn't open yet.",
};
export const errorText = (code) => ERRORS[code] || null;

/** What each choice gets, in plain words. */
const LEVEL_WORDS = {
  national: "The National edition: the President's executive orders, bills that became law and Supreme Court decisions.",
  zip: "Adds your U.S. senators, the House members and state legislators for every district your ZIP touches, your Governor, and your county if ThePillory follows it.",
  exact: "The same, exactly for your address: one representative for each office. The address is used once, for the lookup, and never stored or logged; only your ZIP and district numbers are kept.",
};

/** The three choices, the current one checked. */
function choices({ level = "national", zip = "" } = {}) {
  const radio = (value, label, words, extra = "") => `<label class="choice">
    <input type="radio" name="level" value="${value}"${level === value ? " checked" : ""} />
    <span><strong>${esc(label)}</strong><br><span class="small secondary">${esc(words)}</span></span>
  </label>${extra}`;
  return `<fieldset class="bare stack-sm email-levels">
    <legend class="label">Want it personalized?</legend>
    ${radio("national", "No thanks, the National edition", LEVEL_WORDS.national)}
    ${radio("zip", "Use my ZIP code", LEVEL_WORDS.zip, `<label class="field"><span class="label">ZIP code</span><input class="input" name="zip" inputmode="numeric" autocomplete="postal-code" pattern="[0-9]{5}" maxlength="5" value="${esc(zip || "")}" /></label>`)}
    ${radio("address", "Use my street address", LEVEL_WORDS.exact, `<label class="field"><span class="label">Street address, city and state</span><input class="input" name="address" autocomplete="street-address" maxlength="200" /></label>`)}
  </fieldset>`;
}

const notStarted = (env) => String(env.EMAIL_SENDING || "off").toLowerCase() !== "on";

/** /email/: what it is, and the form. */
export function signupMain(env, { sent = false, error = null } = {}) {
  const head = `<header class="page-head">
  <h1>This week from your representatives</h1>
  <p class="subtitle">One email on Sunday afternoon: what the people who represent you did that week, from the public record, each line linked to its source.</p>
</header>`;
  if (sent) {
    return `${head}<section class="card stack-sm" id="check-email">
  <h2 class="h3">Check your email</h2>
  <p>We sent a link to confirm it's you. Nothing is sent until you click it.${notStarted(env) ? " The weekly email starts soon; if the link hasn't come, it's sent the day it starts." : ""}</p>
  <p class="small secondary">Already signed up? Use "Change my place" at the bottom of any weekly email.</p>
</section>`;
  }
  const ready = turnstileReady(env);
  const form = ready
    ? `<form class="stack email-form" method="post" action="/api/email">
    ${error ? `<p class="form-error" role="alert">${esc(errorText(error) || "Something went wrong. Please try again.")}</p>` : ""}
    <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required maxlength="254" /></label>
    ${choices()}
    ${turnstileWidget(env)}
    <button class="btn btn--primary" type="submit">Sign up</button>
  </form>`
    : `<p class="small secondary">Sign-up opens soon.</p>`;
  return `${head}
<section class="card stack" id="signup">${form}</section>
<section class="card stack-sm" id="what-you-get">
  <h2 class="h3">What's in it</h2>
  <ul class="simple-list">
    <li class="small">Final-passage votes, bills signed or vetoed, executive orders, Supreme Court decisions, and stock trade and financial disclosure reports filed, from the week ending Saturday night.</li>
    <li class="small">County meetings coming up in the next two weeks, where ThePillory follows the county, with the county's own instructions for commenting.</li>
    <li class="small">The weeks before an election, a link to preview your ballot.</li>
    <li class="small">Facts only, the same for everyone. No ads, no tracking, and a week with nothing new isn't sent.</li>
  </ul>
  <p class="small secondary">Your email is used only for this. Unsubscribing deletes it. ${notStarted(env) ? "The weekly email starts soon." : ""}</p>
</section>`;
}

/** /email/confirm/?t=: one button. */
export function confirmMain(sub, { done = false } = {}) {
  if (!sub) return gone();
  if (done || sub.confirmed_at) {
    return `<header class="page-head"><h1>You're signed up</h1></header>
<section class="card stack-sm"><p>The weekly email comes on Sunday afternoon. ${esc(placeWords(sub))}</p>
<p><a class="inline-link" href="/email/manage/?t=${esc(sub.token)}">Change my place</a> · <a class="inline-link" href="/email/unsubscribe/?t=${esc(sub.token)}">Unsubscribe</a></p></section>`;
  }
  return `<header class="page-head"><h1>Confirm your weekly email</h1></header>
<section class="card stack-sm">
  <p>Confirm that you want "This week from your representatives" at ${esc(sub.email)}.</p>
  <form method="post" action="/email/confirm/?t=${esc(sub.token)}"><button class="btn btn--primary" type="submit">Confirm</button></form>
</section>`;
}

/** What a subscriber gets, in one sentence. */
export function placeWords(sub) {
  if (!sub || sub.level === "national") return "You get the National edition.";
  if (sub.level === "zip") return `It's based on ZIP ${sub.zip}.`;
  const d = describe({ st: sub.st, cd: sub.cd, su: sub.su, sl: sub.sl, co: sub.co });
  return `It's based on your address's districts: ${d}.`;
}

/** /email/manage/?t=: switch levels, including back to email only. */
export function manageMain(sub, { saved = false, error = null } = {}) {
  if (!sub) return gone();
  return `<header class="page-head"><h1>Change my place</h1><p class="subtitle">${esc(sub.email)}</p></header>
<section class="card stack">
  ${saved ? `<p class="form-ok" role="status">Saved. ${esc(placeWords(sub))}</p>` : `<p>${esc(placeWords(sub))}</p>`}
  ${error ? `<p class="form-error" role="alert">${esc(errorText(error) || "Something went wrong. Please try again.")}</p>` : ""}
  <form class="stack" method="post" action="/email/manage/?t=${esc(sub.token)}">
    ${choices({ level: sub.level === "exact" ? "address" : sub.level, zip: sub.level === "zip" ? sub.zip : "" })}
    <button class="btn btn--primary" type="submit">Save</button>
  </form>
</section>
<section class="card stack-sm"><p class="small"><a class="inline-link" href="/email/unsubscribe/?t=${esc(sub.token)}">Unsubscribe</a> (deletes your email address)</p></section>`;
}

/** /email/unsubscribe/?t=: one button; done says so. */
export function unsubscribeMain(sub, { done = false } = {}) {
  if (done) {
    return `<header class="page-head"><h1>You're unsubscribed</h1></header>
<section class="card stack-sm"><p>Your email address is deleted, and nothing more will be sent. <a class="inline-link" href="/email/">Sign up again</a> anytime.</p></section>`;
  }
  if (!sub) return gone();
  return `<header class="page-head"><h1>Unsubscribe</h1></header>
<section class="card stack-sm">
  <p>Stop the weekly email to ${esc(sub.email)} and delete the address?</p>
  <form method="post" action="/email/unsubscribe/?t=${esc(sub.token)}"><button class="btn btn--primary" type="submit">Unsubscribe</button></form>
  <p class="small secondary">Or <a class="inline-link" href="/email/manage/?t=${esc(sub.token)}">change your place</a> instead.</p>
</section>`;
}

function gone() {
  return `<header class="page-head"><h1>That link has expired</h1></header>
<section class="card stack-sm"><p>It may be from an email that was unsubscribed, or a sign-up that wasn't confirmed within 7 days. <a class="inline-link" href="/email/">Sign up</a></p></section>`;
}

/**
 * An edition's web version, in the site's own cards and rows (light and dark like every
 * page): everything in it, not only the first lines the email shows.
 */
export function webEditionMain(e) {
  const row = (i) => `<a class="list-row" href="${esc(i.href)}"><div><div class="list-title">${esc(i.text)}</div>${i.meta ? `<div class="list-meta">${esc(i.meta)}</div>` : ""}</div>${i.status ? `<span class="list-status">${esc(i.status)}</span>` : ""}</a>`;
  const section = (s) => {
    const parts = [];
    if (s.note) parts.push(`<p class="small secondary">${esc(s.note)}</p>`);
    if (s.coming) parts.push(`<p><a class="inline-link" href="${esc(s.coming.href)}">${esc(s.coming.text)}</a></p>`);
    if ((s.items || []).length) parts.push(`<div class="plain-list">${s.items.map(row).join("")}</div>`);
    for (const g of s.groups || []) {
      parts.push(`<p><a class="inline-link" href="${esc(g.href)}"><strong>${esc(g.name)}</strong></a><br><span class="small secondary">${esc(g.office)}</span></p>`);
      parts.push(g.items.length ? `<div class="plain-list">${g.items.map(row).join("")}</div>` : `<p class="small secondary">${esc(g.empty || "Nothing new this week")}</p>`);
    }
    if (s.quote) parts.push(`<div class="inset stack-sm"><p class="label">${esc(s.quote.label)}</p><p class="quote">“${esc(s.quote.text)}”</p></div>`);
    return `<section class="card stack-sm"><h2 class="h3">${esc(s.title)}</h2>${parts.join("")}</section>`;
  };
  return `<header class="page-head">
  <h1>${esc(e.title)}</h1>
  <p class="subtitle">${esc(e.when)} · ${esc(e.based.text)}</p>
</header>
${e.sections.map(section).join("\n")}
<section class="card stack-sm"><p class="small">This is the web version of ThePillory's weekly email. Every line links to its record and source. <a class="inline-link" href="/email/">Get it by email ›</a></p></section>`;
}

/** The link used across the site. */
export const EMAIL_LINK = "/email/";
