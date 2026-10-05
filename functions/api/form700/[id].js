// /api/form700/<index ID>: opens a California Form 700 statement. The FPPC's
// search hands out PDF links that expire, so ThePillory keeps each statement's
// details (from the executive-funding sync) and asks the FPPC for a fresh link
// when a reader clicks, then redirects to it. If that fails, the reader lands
// on the FPPC's own search instead of a dead link.
import { fppcPdfUrl, FPPC_SEARCH } from "../../../workers/sync/src/funding/disclosure.js";

const go = (url) => new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });

export async function onRequestGet({ env, params }) {
  const base = (env.FPPC_SEARCH || FPPC_SEARCH).replace(/\/$/, "");
  const search = `${base}/`;
  const id = String(params.id || "");
  if (!/^[0-9A-Fa-f-]{36}$/.test(id) || !env.DB) return go(search);
  let row;
  try {
    row = await env.DB.prepare("SELECT detail FROM disclosures WHERE id = ? AND source = 'fppc'").bind(`fppc:${id}`).first();
  } catch (_) {
    return go(search);
  }
  if (!row || !row.detail) return go(search);
  try {
    const d = JSON.parse(row.detail);
    const res = await fetch(fppcPdfUrl(id, d.pdf, base), { headers: { Accept: "application/json", "User-Agent": "ThePillory (thepillory.co)" } });
    const data = await res.json();
    const url = String((data && data.PDFDownloadUrl) || "");
    // Only ever redirect to the FPPC's own site.
    if (res.ok && url.startsWith(`${base}/`)) return go(url);
  } catch (_) {}
  return go(search);
}
