// POST /api/email   the weekly email's sign-up (the form on /email/)
//   form fields: email, level (national | zip | address), zip, address, cf-turnstile-response
//
// Protected like the other public forms: Turnstile, and at most SIGNUPS_PER_VISITOR a day per
// visitor (a daily-rotating hash, never the IP address; email_signup_attempts). Double opt-in: the row
// waits for its confirmation link (the sync Worker sends it within a minute). An address is
// used once, for the Census lookup, and never stored or logged (functions/_lib/email-store.js).
// Answers with a redirect back to /email/ (?sent=1, or ?error=<code>).
import { verifyTurnstile, turnstileReady, visitorHash } from "../_lib/turnstile.js";
import { placeFromForm, cleanEmail, signUp } from "../_lib/email-store.js";

const SIGNUPS_PER_VISITOR = 5;

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  const back = (q) => Response.redirect(`${url.origin}/email/?${q}#signup`, 303);
  if (!env.DB || !turnstileReady(env)) return back("error=closed");
  const form = await request.formData();
  const email = cleanEmail(form.get("email"));
  if (!email) return back("error=email");
  const ip = request.headers.get("CF-Connecting-IP");
  if (!(await verifyTurnstile(env, form.get("cf-turnstile-response"), ip))) return back("error=check");
  const visitor = await visitorHash(env, request);
  const tries = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_signup_attempts WHERE visitor = ? AND created_at > datetime('now', '-1 day')").bind(visitor).first();
  if (tries && tries.n >= SIGNUPS_PER_VISITOR) return back("error=limit");
  const { place, error } = await placeFromForm(env, request, form);
  if (error) return back(`error=${error}`);
  await signUp(env.DB, email, place);
  await env.DB.prepare("INSERT INTO email_signup_attempts (visitor) VALUES (?)").bind(visitor).run();
  // The same answer whether the address was new, waiting, or already signed up.
  return back("sent=1");
}
