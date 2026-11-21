// /agencies/ and /agencies/<slug>/ (docs/agencies.md; functions/_lib/agencies.js). The same for
// every visitor, so kept at the edge for five minutes. Reads only by key or the agency's index.
import { page, notFound, notLoaded, guard, edgeCached, loadSection, FAILED, sectionError } from "../_lib/render.js";
import { loadIndex, loadAgency, indexMain, agencyMain, PER_PAGE } from "../_lib/agencies.js";

const CACHE_SECONDS = 300;
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (context.params.path || []).filter(Boolean);
  if (!parts.length) return edgeCached(context, CACHE_SECONDS, () => index(context.env, url));
  if (parts.length === 1 && SLUG.test(parts[0])) return edgeCached(context, CACHE_SECONDS, () => agency(context.env, parts[0]));
  return notFound("No page at this address.", "laws", ["Agencies", "/agencies/"]);
}, { tab: "laws" });

async function index(env, url) {
  if (!env.DB) return notLoaded("Agencies", "laws", false, ["Laws", "/laws/"]);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  const data = await loadSection("agencies", () => loadIndex(env.DB, { q, offset: offset - (offset % PER_PAGE) }), null);
  const main = data === FAILED ? sectionError("Agencies") : indexMain(data);
  return page("Agencies", main, { tab: "laws", back: offset || q ? ["Agencies", "/agencies/"] : ["Laws", "/laws/"], partial: data === FAILED });
}

async function agency(env, id) {
  if (!env.DB) return notLoaded("Agencies", "laws", false, ["Agencies", "/agencies/"]);
  const data = await loadSection("agency", () => loadAgency(env.DB, id), null);
  if (data === FAILED) return page("Agency", sectionError("Agency"), { tab: "laws", back: ["Agencies", "/agencies/"], partial: true });
  if (!data) return notFound("No agency with this address is loaded. Agencies load weekly from the Federal Register.", "laws", ["Agencies", "/agencies/"]);
  return page(data.agency.name, agencyMain(data), { tab: "laws", back: [data.agency.parent_name || "Agencies", data.agency.parent_id ? `/agencies/${data.agency.parent_id}/` : "/agencies/"] });
}
