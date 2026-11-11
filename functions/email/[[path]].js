// The weekly email, "This week from your representatives" (docs/email.md):
//   /email/                          what it is, and the sign-up form (POST /api/email)
//   /email/confirm/?t=               confirm (a button: POST here)
//   /email/manage/?t=                Change my place: National, ZIP or address, anytime (POST here)
//   /email/unsubscribe/?t=           unsubscribe (a button; POST here, also the one-click
//                                    List-Unsubscribe POST from mail apps): deletes the row
//   /email/<week>/<edition key>/     an edition's web version (email_editions)
// Pages opened from a subscriber's own link are private and never cached or indexed.
import { page, guard, notFound } from "../_lib/render.js";
import { signupMain, confirmMain, manageMain, unsubscribeMain, webEditionMain } from "../_lib/email-pages.js";
import { byToken, confirm, changePlace, placeFromForm, unsubscribe } from "../_lib/email-store.js";

function privatePage(title, main, status = 200) {
  const res = page(title, main, { tab: "you", back: ["Weekly email", "/email/"], status });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status, headers });
}

const missingTable = (err) => /no such table/i.test(String(err && err.message));

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (context.params.path || []).filter(Boolean);
  const post = request.method === "POST";
  const origin = request.headers.get("Origin");
  if (post && origin && origin !== url.origin && parts[0] !== "unsubscribe") return new Response("Refused", { status: 403 });

  if (!parts.length) {
    if (post) return Response.redirect(`${url.origin}/email/`, 303);
    const res = page("This week from your representatives", signupMain(env, { sent: url.searchParams.get("sent") === "1", error: url.searchParams.get("error") }), { tab: "you", back: ["You", "/you/"] });
    const headers = new Headers(res.headers);
    if (url.search) headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }
  if (!env.DB) return notFound("The weekly email isn't set up yet.", "you", ["You", "/you/"]);

  try {
    const token = url.searchParams.get("t") || "";
    if (parts.length === 1 && parts[0] === "confirm") {
      const sub = await byToken(env.DB, token);
      if (post && sub) {
        await confirm(env.DB, sub.id);
        return privatePage("You're signed up", confirmMain({ ...sub, confirmed_at: "now" }, { done: true }));
      }
      return privatePage("Confirm your weekly email", confirmMain(sub), sub ? 200 : 404);
    }
    if (parts.length === 1 && parts[0] === "manage") {
      const sub = await byToken(env.DB, token);
      if (!sub) return privatePage("That link has expired", manageMain(null), 404);
      if (post) {
        const { place, error } = await placeFromForm(env, request, await request.formData());
        if (error) return privatePage("Change my place", manageMain(sub, { error }), 400);
        await changePlace(env.DB, sub.id, place);
        // Using one's own link also confirms the address.
        await confirm(env.DB, sub.id);
        return privatePage("Change my place", manageMain({ ...sub, ...place }, { saved: true }));
      }
      return privatePage("Change my place", manageMain(sub));
    }
    if (parts.length === 1 && parts[0] === "unsubscribe") {
      if (post) {
        await unsubscribe(env.DB, token);
        return privatePage("You're unsubscribed", unsubscribeMain(null, { done: true }));
      }
      const sub = await byToken(env.DB, token);
      return privatePage("Unsubscribe", unsubscribeMain(sub), sub ? 200 : 404);
    }
    if (parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) && /^[A-Za-z0-9_-]{1,80}$/.test(parts[1]) && !post) {
      const row = await env.DB.prepare("SELECT body FROM email_editions WHERE week = ? AND edition_key = ?").bind(parts[0], parts[1]).first();
      if (!row) return notFound("No edition at this address.", "you", ["Weekly email", "/email/"]);
      const edition = JSON.parse(row.body);
      const res = page(edition.subject, webEditionMain(edition), { tab: "you", back: ["Weekly email", "/email/"] });
      const headers = new Headers(res.headers);
      headers.set("X-Robots-Tag", "noindex");
      return new Response(res.body, { status: 200, headers });
    }
  } catch (err) {
    if (missingTable(err)) return notFound("The weekly email isn't set up yet.", "you", ["You", "/you/"]);
    throw err;
  }
  return notFound("No page at this address.", "you", ["Weekly email", "/email/"]);
}

export const onRequestGet = guard(handle, { tab: "you" });
export const onRequestPost = guard(handle, { tab: "you" });
