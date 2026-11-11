// The weekly email's subscribers in D1 (email_subscribers, migration 0048; docs/email.md).
// Three levels and nothing else: national (email only), zip (the ZIP; its districts are read
// from data/zip/ each week), exact (an address looked up once by the Census Geocoder, never
// stored or logged: only the ZIP the lookup matched and the district IDs). Unsubscribing
// deletes the row.
import { lookupAddress } from "../api/districts.js";
import { EMAIL_RE } from "./email-pages.js";

/** A link token: 24 random bytes as hex. */
export function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function zipExists(env, request, zip) {
  if (!env.ASSETS) return false;
  const res = await env.ASSETS.fetch(new URL(`/data/zip/${zip.slice(0, 3)}.json`, request.url));
  if (!res.ok) return false;
  const file = await res.json();
  return Array.isArray(file[zip]) && file[zip].length > 0;
}

/**
 * The place a form asks for: {place: {level, zip, st, cd, su, sl, co}} or {error: code}.
 * The address field, when given, goes to the Census Geocoder for this one lookup and is
 * dropped: it's never returned, stored or logged. `lookup` replaces the Census call in tests.
 */
export async function placeFromForm(env, request, form, { lookup = lookupAddress } = {}) {
  const level = String(form.get("level") || "national");
  const none = { st: null, cd: null, su: null, sl: null, co: null };
  if (level === "zip") {
    const zip = String(form.get("zip") || "").trim();
    if (!zip) return { error: "zip-missing" };
    if (!/^\d{5}$/.test(zip) || !(await zipExists(env, request, zip))) return { error: "zip" };
    return { place: { level: "zip", zip, ...none } };
  }
  if (level === "address") {
    const address = String(form.get("address") || "").trim().slice(0, 200);
    if (!address) return { error: "address-missing" };
    const r = await lookup(env, address, { withZip: true });
    if (!r || !r.found) return { error: r && /didn't answer/.test(r.error || "") ? "lookup" : "address" };
    const d = r.districts;
    return { place: { level: "exact", zip: r.zip || null, st: d.st, cd: d.cd || null, su: d.su || null, sl: d.sl || null, co: d.co || null } };
  }
  return { place: { level: "national", zip: null, ...none } };
}

export const cleanEmail = (e) => {
  const v = String(e || "").trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null;
};

export async function byToken(db, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ""))) return null;
  return db.prepare("SELECT * FROM email_subscribers WHERE token = ?").bind(token).first();
}

const PLACE = ["level", "zip", "st", "cd", "su", "sl", "co"];

/**
 * A sign-up. New: a row waiting for confirmation (the Worker sends the email within a minute).
 * Not yet confirmed: the place updated and the confirmation sent again. Already confirmed:
 * nothing changes here (anyone could type an address in); they change it from their own link.
 */
export async function signUp(db, email, place) {
  const old = await db.prepare("SELECT id, confirmed_at FROM email_subscribers WHERE email = ?").bind(email).first();
  if (old && old.confirmed_at) return { status: "already" };
  if (old) {
    await db
      .prepare(`UPDATE email_subscribers SET ${PLACE.map((k) => `${k} = ?`).join(", ")}, confirm_sent_at = NULL, updated_at = datetime('now') WHERE id = ?`)
      .bind(...PLACE.map((k) => place[k] ?? null), old.id)
      .run();
    return { status: "resent" };
  }
  await db
    .prepare(`INSERT INTO email_subscribers (email, ${PLACE.join(", ")}, token) VALUES (?, ${PLACE.map(() => "?").join(", ")}, ?)`)
    .bind(email, ...PLACE.map((k) => place[k] ?? null), newToken())
    .run();
  return { status: "new" };
}

/** Change my place: a confirmed subscriber's own link. */
export async function changePlace(db, id, place) {
  await db
    .prepare(`UPDATE email_subscribers SET ${PLACE.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...PLACE.map((k) => place[k] ?? null), id)
    .run();
}

export async function confirm(db, id) {
  await db.prepare("UPDATE email_subscribers SET confirmed_at = COALESCE(confirmed_at, datetime('now')), updated_at = datetime('now') WHERE id = ?").bind(id).run();
}

/** Unsubscribe: the row is deleted, and with it the address. */
export async function unsubscribe(db, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ""))) return false;
  const r = await db.prepare("DELETE FROM email_subscribers WHERE token = ?").bind(token).run();
  return Boolean(r && r.meta && r.meta.changes);
}
