// The visitor's state, for the home page: a state they picked (the
// pillory_state cookie), else the state of their saved districts, else
// Cloudflare's guess from the connection (request.cf.regionCode, a US state or
// DC; Puerto Rico reports as its own country). Only the state is used: never a
// county or district (those come from an address or ZIP), and the guess is
// never stored or logged. Outside the US, or when the region is unknown: null,
// and the home page is the national hub.
import { STATE_NAME } from "./districts.js";

export const STATE_COOKIE = "pillory_state";

const valid = (st) => (/^[A-Z]{2}$/.test(String(st || "")) && STATE_NAME[st] ? st : null);

/** The state picked in this browser, if any. */
export function pickedState(request) {
  const m = new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([A-Za-z]{2})(?:;|$)`).exec(request.headers.get("Cookie") || "");
  return m ? valid(m[1].toUpperCase()) : null;
}

/** The state Cloudflare places the connection in, or null. Pure; tested. */
export function connectionState(cf) {
  if (!cf) return null;
  const country = String(cf.country || "").toUpperCase();
  if (country === "PR") return "PR";
  if (country !== "US") return null;
  return valid(String(cf.regionCode || "").toUpperCase());
}

/** { st, name, source: "picked" | "districts" | "connection" } or null. */
export function visitorState(request, d) {
  const picked = pickedState(request);
  const st = picked || (d && valid(d.st)) || connectionState(request.cf);
  if (!st) return null;
  return { st, name: STATE_NAME[st], source: picked ? "picked" : d && d.st === st ? "districts" : "connection" };
}

export function stateCookie(st) {
  return st
    ? `${STATE_COOKIE}=${st}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    : `${STATE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}
