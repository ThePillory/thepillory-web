// Cloudflare Turnstile and per-visitor rate limits for the public forms
// ("Something wrong?" and "Request full analysis"). No accounts: a visitor is
// a one-way hash of their address that changes every day, kept only to count
// their actions (public_actions). Fails closed: without TURNSTILE_SECRET_KEY
// the forms say they aren't open yet and posts are refused.
//
// Pages settings (Settings → Variables and Secrets):
//   TURNSTILE_SITE_KEY    the widget's site key (public)
//   TURNSTILE_SECRET_KEY  its secret key (secret)
//   VISITOR_SALT          any long random string (secret); mixed into the visitor hash
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileReady(env) {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** The widget; include turnstileScript() once per page that has one. */
export function turnstileWidget(env) {
  return `<div class="cf-turnstile" data-sitekey="${String(env.TURNSTILE_SITE_KEY).replace(/[^\w-]/g, "")}" data-size="flexible"></div>`;
}

export const turnstileScript = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

/** true if Cloudflare accepts the token for this visitor. */
export async function verifyTurnstile(env, token, ip) {
  if (!turnstileReady(env) || !token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", String(token));
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch(env.TURNSTILE_VERIFY_URL || VERIFY_URL, { method: "POST", body });
    const data = await res.json();
    return data.success === true;
  } catch (_) {
    return false;
  }
}

/** The visitor's daily hash. */
export async function visitorHash(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${day}|${env.VISITOR_SALT || env.TURNSTILE_SECRET_KEY || ""}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** How many times this visitor did `kind` in the last 24 hours. */
export async function actionsToday(db, kind, visitor) {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM public_actions WHERE kind = ? AND visitor = ? AND created_at > datetime('now', '-1 day')")
    .bind(kind, visitor)
    .first();
  return r ? r.n : 0;
}

export function recordAction(db, kind, visitor) {
  return db.prepare("INSERT INTO public_actions (kind, visitor) VALUES (?, ?)").bind(kind, visitor);
}
