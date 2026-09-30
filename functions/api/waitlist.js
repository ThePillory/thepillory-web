// POST /api/waitlist   "Bring The Pillory to your county" (the hub's Communities section)
//   form fields: state, county (5-digit FIPS), email, cf-turnstile-response
//
// Stores the county and email in D1 (table waitlist). The email is used only
// to announce that county's launch; it's never shown, and the hub shows only
// the totals. Protected like the other public forms: Turnstile, and at most
// SIGNUPS_PER_VISITOR a day per visitor (a daily-rotating hash, never the
// address; table waitlist_attempts). Answers with a redirect back to the hub.
import { verifyTurnstile, turnstileReady, visitorHash } from "../_lib/turnstile.js";

const SIGNUPS_PER_VISITOR = 5;
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

async function countyName(env, request, fips) {
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new URL("/data/counties.json", request.url));
  if (!res.ok) return null;
  const all = await res.json();
  return all[fips] || null; // [name, state]
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const back = (q) => Response.redirect(`${url.origin}/?hub=1&waitlist=${q}#communities`, 303);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  if (!env.DB || !turnstileReady(env)) return back("closed");

  const form = await request.formData();
  const state = String(form.get("state") || "").toUpperCase();
  const fips = String(form.get("county") || "");
  const email = String(form.get("email") || "").trim().toLowerCase();
  if (!/^\d{5}$/.test(fips) || !/^[A-Z]{2}$/.test(state) || email.length > 254 || !EMAIL.test(email)) return back("invalid");
  const county = await countyName(env, request, fips);
  if (!county || county[1] !== state) return back("invalid");

  if (!(await verifyTurnstile(env, form.get("cf-turnstile-response"), request.headers.get("CF-Connecting-IP")))) return back("turnstile");
  const db = env.DB;
  try {
    const visitor = await visitorHash(env, request);
    const tries = await db
      .prepare("SELECT COUNT(*) AS n FROM waitlist_attempts WHERE visitor = ? AND created_at > datetime('now', '-1 day')")
      .bind(visitor)
      .first();
    if (tries && tries.n >= SIGNUPS_PER_VISITOR) return back("limit");
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO waitlist (county_fips, county_name, email) VALUES (?, ?, ?)").bind(fips, `${county[0]}, ${state}`, email),
      db.prepare("INSERT INTO waitlist_attempts (visitor) VALUES (?)").bind(visitor),
    ]);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return back("closed");
    throw err;
  }
  return back("joined");
}

export function onRequestGet({ request }) {
  return Response.redirect(`${new URL(request.url).origin}/?hub=1#communities`, 302);
}
