// Executive orders on the site (/laws/orders/<id>/): the same layout for every
// President and Governor. Status, title, a two-sentence summary and the
// Constitution chips on top; then the authority the order claims, quoted from
// its text; then "In the courts"; everything else collapsed. Facts with sources:
// the order's own words, the Federal Register's notes, CourtListener's records.
import { esc, fmtDate, safeUrl, sourceLink } from "./render.js";
import { firstSentences, outLink } from "./summary.js";
import { METHOD_URL } from "./analysis.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

// 'fr:2025-02007' <-> 'fr-2025-02007'; 'ca-gov:12345' <-> 'ca-gov-12345' (no colon in addresses).
export const orderSlug = (id) => String(id || "").replace(":", "-");
export function orderIdFromSlug(slug) {
  const s = String(slug || "");
  if (/^fr-[\w-]+$/.test(s)) return `fr:${s.slice(3)}`;
  if (/^ca-gov-\d+$/.test(s)) return `ca-gov:${s.slice(7)}`;
  return null;
}
export const orderHref = (id) => `/laws/orders/${encodeURIComponent(orderSlug(id))}/`;

const federal = (a) => String(a.id).startsWith("fr:");
/** "Executive Order 14160", "Executive Order N-9-26", or "Executive order" when the source gives no number. */
export const orderLabel = (a) => (a.number ? `Executive Order ${a.number}` : a.kind === "proclamation" ? "Proclamation" : "Executive order");
/** Short form for list rows: "EO 14160". */
export const orderShort = (a) => (a.number ? `EO ${a.number}` : a.kind === "proclamation" ? "Procl." : "EO");

/** The order, who issued it, its text, and the court records found, or null. */
export async function orderById(db, id) {
  const a = await db
    .prepare(
      `SELECT a.*, o.name AS official_name, o.slug AS official_slug, o.office AS official_office, o.active AS official_active
       FROM executive_actions a LEFT JOIN officials o ON o.id = a.official_id WHERE a.id = ?`
    )
    .bind(id)
    .first();
  if (!a) return null;
  const tolerant = async (fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      if (missing(err)) return fallback;
      throw err;
    }
  };
  a.text = await tolerant(() => db.prepare("SELECT * FROM executive_action_texts WHERE action_id = ?").bind(id).first(), null);
  a.cases = await tolerant(async () => (await db.prepare("SELECT * FROM executive_action_cases WHERE action_id = ? ORDER BY date_filed DESC, case_name").bind(id).all()).results, []);
  a.courtCheck = await tolerant(() => db.prepare("SELECT * FROM executive_action_court_checks WHERE action_id = ?").bind(id).first(), null);
  return a;
}

/** The order's status line: when it was signed, and the Federal Register's note if it was revoked or amended. */
export function orderStatus(a) {
  const parts = [];
  const notes = String(a.notes || "");
  const revoked = /Revoked by:?\s*(EO \d+[^;]*)/i.exec(notes);
  if (revoked) parts.push(`Revoked by ${revoked[1].replace(/,\s*\w+ \d{1,2}, \d{4}\s*$/, "").trim()}`);
  parts.push(a.signed_on ? `Signed ${fmtDate(a.signed_on)}` : a.published_on ? `Posted ${fmtDate(a.published_on)}` : "");
  return parts.filter(Boolean);
}

/** The two-sentence summary: from the checked analysis (labeled AI-drafted), or null. */
export function orderSummary(an) {
  if (!an || !an.plain_summary) return null;
  return { text: firstSentences(an.plain_summary, 2), source: `From the constitutional analysis · <a href="${METHOD_URL}">AI-drafted, ${an.status === "reviewed" ? "reviewed by a person" : "auto-checked"}</a>` };
}

/** "Authority it claims": the order's own words. */
export function authoritySection(a) {
  const src = federal(a) ? "the Federal Register's text of the order" : "the signed order";
  let inner;
  if (a.text && a.text.authority) {
    inner = `<blockquote class="authority-quote">“${esc(a.text.authority)}”</blockquote>
  <p class="hint">Quoted word for word from ${src}${safeUrl(a.text.text_url) ? ` (<a class="inline-link" href="${esc(a.text.text_url)}" target="_blank" rel="noopener">source ↗</a>)` : ""}. This is the authority the order names for itself, not a finding that it has that authority.</p>`;
  } else if (a.text && a.text.status === "ok") {
    inner = `<p class="small">The order's text doesn't use the usual wording for the authority it relies on ("By the authority vested in me …"), so nothing is quoted here. Its full text is under Full text below.</p>`;
  } else if (a.text && a.text.status === "no_text") {
    inner = `<p class="small">The order's text couldn't be read: ${esc(a.text.note || "the source has no readable text")}. ${safeUrl(a.document_url) ? `<a class="inline-link" href="${esc(a.document_url)}" target="_blank" rel="noopener">The signed order ↗</a>` : ""}</p>`;
  } else {
    inner = '<p class="small secondary">Not read yet. The order\'s text is read by the next data sync, and the authority it claims is quoted here, word for word.</p>';
  }
  return `<section class="card stack-sm" id="authority">
  <h2 class="label">Authority it claims</h2>
  ${inner}
</section>`;
}

/** "In the courts": opinions and dockets on CourtListener that mention the order, as recorded. */
export function courtsSection(a) {
  const check = a.courtCheck;
  const opinions = (a.cases || []).filter((c) => c.kind === "opinion");
  const dockets = (a.cases || []).filter((c) => c.kind === "docket");
  const caseLine = (c) => {
    const entries = (() => {
      try {
        return JSON.parse(c.entries || "[]");
      } catch {
        return [];
      }
    })();
    return `<div class="court-row">
  <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.case_name)} ↗</a>
  <span class="xsmall secondary">${[c.court, c.docket_number, c.date_filed ? `${c.kind === "opinion" ? "Decided" : "Filed"} ${fmtDate(c.date_filed)}` : ""].filter(Boolean).map(esc).join(" · ")}</span>
  ${entries
    .map((e) => `<span class="court-entry">${e.date ? `${fmtDate(e.date)}: ` : ""}<a class="inline-link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.description)}</a></span>`)
    .join("")}
</div>`;
  };
  let inner;
  if (!check) {
    inner = '<p class="small secondary">Not searched yet. Court records that mention this order are looked up on CourtListener by the data sync.</p>';
  } else if (!opinions.length && !dockets.length) {
    inner = `<p class="small">No court opinions or case filings on CourtListener mention ${esc(orderLabel(a))} (searched ${fmtDate(String(check.checked_at).slice(0, 10))}).</p>`;
  } else {
    inner = `${opinions.length ? `<div class="stack-sm"><p class="label">Rulings that mention it</p>${opinions.map(caseLine).join("")}${check.opinions > opinions.length ? `<p class="hint">Showing ${opinions.length} of ${check.opinions}, newest first.</p>` : ""}</div>` : ""}
  ${dockets.length ? `<div class="stack-sm"><p class="label">Cases with filings that mention it</p>${dockets.map(caseLine).join("")}${check.dockets > dockets.length ? `<p class="hint">Showing ${dockets.length} of ${check.dockets}, newest first.</p>` : ""}</div>` : ""}
  <p class="hint">Found by searching court records on CourtListener for “${esc(orderLabel(a))}” (searched ${fmtDate(String(check.checked_at).slice(0, 10))}). A case is listed because an opinion or filing in it mentions the order; that doesn't mean the order is what the case is about. Filings are described as the court docketed them. Injunctions and rulings appear here as the court's own entries; ThePillory doesn't summarize or call outcomes.</p>`;
  }
  return `<section class="card stack-sm" id="courts">
  <h2 class="label">In the courts</h2>
  ${inner}
</section>`;
}

/** The history: signed, published, and the Federal Register's notes, with sources. */
export function orderHistory(a) {
  const rows = [
    a.signed_on ? [a.signed_on, `Signed by ${a.official_name || (federal(a) ? "the President" : "the Governor")}`] : null,
    a.published_on ? [a.published_on, federal(a) ? `Published in the Federal Register${a.citation ? ` (${a.citation})` : ""}` : "Posted by the Governor's Office"] : null,
  ].filter(Boolean);
  rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return `<ol class="timeline">${rows.map(([d, t]) => `<li><span class="tl-date">${fmtDate(d)}</span><span>${esc(t)}</span></li>`).join("")}</ol>
  ${a.notes ? `<p class="small"><strong>Federal Register notes:</strong> ${esc(a.notes)}</p>` : ""}
  ${sourceLink(a.source_url, federal(a) ? "Federal Register" : "Governor's Office post")}`;
}

/** The full text, as read from the source, with links to the source and the signed document. */
export function orderFullText(a) {
  const links = `${outLink(a.source_url, federal(a) ? "On the Federal Register" : "The Governor's Office post")}${safeUrl(a.document_url) ? outLink(a.document_url, federal(a) ? "PDF" : "The signed order (PDF)") : ""}`;
  if (a.text && a.text.status === "ok" && a.text.text) {
    return `<div class="full-text" tabindex="0">${esc(a.text.text)}</div>
  <p class="hint">As read from ${federal(a) ? "the Federal Register's text" : "the signed PDF"}${a.text.fetched_at ? ` on ${fmtDate(String(a.text.fetched_at).slice(0, 10))}` : ""}. The official document is the record.</p>${links}`;
  }
  return `<p class="small secondary">${a.text && a.text.note ? esc(a.text.note) : "The order's text hasn't been read yet."}</p>${links}`;
}
