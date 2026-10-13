// /corrections/   "Report an error": linked from every page's footer, with the
// beta line. A reader says what's wrong on a page and, if they can, where the
// correct fact is published. No name, email or address is asked for or kept.
// Protected like the other public forms: Turnstile, and at most
// REPORTS_PER_VISITOR a day per visitor (a daily-rotating hash, never the
// address; table correction_attempts). A person reads each report on
// /admin/corrections/ (migration 0038).
import { page, esc, guard } from "../_lib/render.js";
import { verifyTurnstile, turnstileReady, turnstileWidget, visitorHash } from "../_lib/turnstile.js";

const REPORTS_PER_VISITOR = 5;
const MAX_WHAT = 2000;
export const BETA_LINE = "ThePillory is in beta. Every fact links to its source.";

/** A path on this site (from ?page= or the page the reader came from), or "". Pure. */
export function sitePath(value, origin) {
  let v = String(value || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v, origin);
    if (u.origin !== origin) return "";
    v = u.pathname + u.search;
  } catch (_) {
    return "";
  }
  if (!v.startsWith("/") || v.startsWith("//") || v.length > 300 || v.startsWith("/corrections/")) return "";
  return v;
}

const NOTICES = {
  sent: ["", "Thank you. A person will read your report and check it against the source."],
  invalid: ["banner--error", "Say what's wrong (up to 2,000 characters). A source link, if you add one, needs to start with http."],
  turnstile: ["banner--error", "The check that you're a person didn't go through. Please try again."],
  limit: ["banner--error", "That's the most reports from one connection for today. Please try again tomorrow."],
  closed: ["banner--error", "Reports can't be sent right now. Please try again later."],
};

function form(env, { from, what = "", source = "" }) {
  if (!turnstileReady(env)) {
    return `<section class="card stack-sm"><p>The form opens soon.</p></section>`;
  }
  return `
<form class="card stack-sm" method="post" action="/corrections/">
  <label class="field"><span class="field-label">Page</span><input class="input" name="page" value="${esc(from)}" placeholder="/reps/…" maxlength="300" required></label>
  <label class="field"><span class="field-label">What's wrong</span><textarea class="input" name="what" rows="5" maxlength="${MAX_WHAT}" required>${esc(what)}</textarea></label>
  <label class="field"><span class="field-label">Where the correct fact is published (optional)</span><input class="input" name="source" type="url" value="${esc(source)}" placeholder="https://…" maxlength="500"></label>
  ${turnstileWidget(env)}
  <button class="btn btn--primary" type="submit">Send report</button>
</form>`;
}

function view(env, request, { notice = "", from = "" } = {}) {
  const n = NOTICES[notice];
  const main = `
<header class="page-head stack-xs"><h1>Report an error</h1><p class="subtitle">${esc(BETA_LINE)} If something here doesn't match its source, tell us.</p></header>
${n ? `<p class="banner ${n[0]}" role="${n[0] ? "alert" : "status"}">${esc(n[1])}</p>` : ""}
${notice === "sent" ? "" : form(env, { from })}
<section class="card stack-sm">
  <h2 class="label">What happens next</h2>
  <p class="small">A person reads every report and checks it against the original record. When a fact is wrong, it's corrected on the page itself, with its source. No name or email is asked for, so we can't reply to you.</p>
  <p class="small">For an AI-drafted analysis or a promise, the "Something wrong?" link on that page goes straight to its review.</p>
  <p class="small"><a class="inline-link" href="/about/methodology/">How ThePillory checks its facts</a></p>
</section>`;
  const res = page("Report an error", main, { back: ["About", "/about/"], personal: true });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers });
}

export const onRequestGet = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  const from = sitePath(url.searchParams.get("page"), url.origin) || sitePath(request.headers.get("Referer"), url.origin);
  return view(env, request, { notice: url.searchParams.get("notice") || "", from });
});

export const onRequestPost = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  const f = await request.formData();
  const from = sitePath(f.get("page"), url.origin);
  const back = (notice) => Response.redirect(`${url.origin}/corrections/?${new URLSearchParams({ notice, ...(from && notice !== "sent" ? { page: from } : {}) })}`, 303);
  if (!env.DB || !turnstileReady(env)) return back("closed");
  const what = String(f.get("what") || "").replace(/\r\n/g, "\n").trim();
  const source = String(f.get("source") || "").trim();
  if (!from || !what || what.length > MAX_WHAT || (source && (!/^https?:\/\/\S+$/i.test(source) || source.length > 500))) return back("invalid");
  if (!(await verifyTurnstile(env, f.get("cf-turnstile-response"), request.headers.get("CF-Connecting-IP")))) return back("turnstile");
  const db = env.DB;
  try {
    const visitor = await visitorHash(env, request);
    const tries = await db.prepare("SELECT COUNT(*) AS n FROM correction_attempts WHERE visitor = ? AND created_at > datetime('now', '-1 day')").bind(visitor).first();
    if (tries && tries.n >= REPORTS_PER_VISITOR) return back("limit");
    await db.batch([
      db.prepare("INSERT INTO corrections (page, what, source_url) VALUES (?, ?, ?)").bind(from, what, source || null),
      db.prepare("INSERT INTO correction_attempts (visitor) VALUES (?)").bind(visitor),
    ]);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return back("closed");
    throw err;
  }
  return back("sent");
});
