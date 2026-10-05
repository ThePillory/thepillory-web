// The executive branch on the site: the President, Vice President and Cabinet;
// California's Governor and statewide offices. What they do in office (executive
// orders, bills signed and vetoed, nominations) and each bill's final outcome.
// Facts with their sources; every list says where it comes from.
import { esc, safeUrl, fmtDate, linkRow, sourceLink } from "./render.js";
import { OUTCOME_LABEL } from "../../workers/sync/src/executive/parse.js";

export { OUTCOME_LABEL };
export const EXEC_CHAMBERS = ["us-executive", "ca-executive"];
export const isExecutive = (o) => !!o && EXEC_CHAMBERS.includes(o.chamber);
export const isPresident = (o) => o && o.chamber === "us-executive" && o.rank === 1;
export const isGovernor = (o) => o && o.chamber === "ca-executive" && o.rank === 1;

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const tolerant = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (missing(err)) return fallback;
    throw err;
  }
};

const PER_PAGE = 50;

// ---------------------------------------------------------------------------
// Data

/** The executive officials of one branch, in order (President or Governor first). */
export const executiveOfficials = (db, chamber) =>
  tolerant(async () => (await db.prepare("SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name").bind(chamber).all()).results, []);

export function ordersFor(db, officialId, { offset = 0 } = {}) {
  return tolerant(async () => {
    const { results } = await db
      .prepare(
        `SELECT * FROM executive_actions WHERE official_id = ? AND kind IN ('executive_order', 'proclamation')
         ORDER BY COALESCE(signed_on, published_on) DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(officialId, PER_PAGE + 1, offset)
      .all();
    const n = await db.prepare("SELECT kind, COUNT(*) AS n FROM executive_actions WHERE official_id = ? GROUP BY kind").bind(officialId).all();
    const counts = Object.fromEntries(n.results.map((r) => [r.kind, r.n]));
    return { rows: results.slice(0, PER_PAGE), more: results.length > PER_PAGE, counts };
  }, { rows: [], more: false, counts: {} });
}

/** Bills an official acted on: `show` is 'signed' (became law), 'vetoed', or 'all'. */
export function billsActedOn(db, officialId, { show = "all", offset = 0 } = {}) {
  const filter = { signed: "AND o.outcome IN ('signed', 'without_signature', 'became_law', 'over_veto')", vetoed: "AND o.outcome IN ('vetoed', 'pocket_vetoed', 'over_veto')" }[show] || "AND o.outcome != 'presented'";
  return tolerant(async () => {
    const { results } = await db
      .prepare(
        `SELECT o.*, b.bill_number, b.title, b.level FROM bill_outcomes o JOIN bills b ON b.id = o.bill_id
         WHERE o.actor_id = ? ${filter} ORDER BY o.action_date DESC, o.bill_id LIMIT ? OFFSET ?`
      )
      .bind(officialId, PER_PAGE + 1, offset)
      .all();
    const c = await db
      .prepare(
        `SELECT SUM(outcome = 'signed') AS signed, SUM(outcome IN ('vetoed', 'pocket_vetoed')) AS vetoed, SUM(outcome = 'over_veto') AS over_veto,
           SUM(outcome = 'without_signature') AS without_signature, SUM(outcome = 'became_law') AS became_law, SUM(outcome = 'presented') AS presented
         FROM bill_outcomes WHERE actor_id = ?`
      )
      .bind(officialId)
      .first();
    return { rows: results.slice(0, PER_PAGE), more: results.length > PER_PAGE, counts: c || {} };
  }, { rows: [], more: false, counts: {} });
}

export function nominationsFor(db, officialId, { status = "all", offset = 0 } = {}) {
  const filter = ["confirmed", "pending", "withdrawn", "returned", "failed"].includes(status) ? "AND status = ?" : "";
  return tolerant(async () => {
    const binds = [officialId, ...(filter ? [status] : []), PER_PAGE + 1, offset];
    const { results } = await db
      .prepare(`SELECT * FROM nominations WHERE official_id = ? ${filter} ORDER BY received_on DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...binds)
      .all();
    const n = await db.prepare("SELECT status, COUNT(*) AS n FROM nominations WHERE official_id = ? GROUP BY status").bind(officialId).all();
    return { rows: results.slice(0, PER_PAGE), more: results.length > PER_PAGE, counts: Object.fromEntries(n.results.map((r) => [r.status, r.n])) };
  }, { rows: [], more: false, counts: {} });
}

export const outcomeFor = (db, billId) =>
  tolerant(async () => {
    const o = await db.prepare("SELECT o.*, x.slug AS actor_slug FROM bill_outcomes o LEFT JOIN officials x ON x.id = o.actor_id AND x.active = 1 WHERE o.bill_id = ?").bind(billId).first();
    const checked = await db.prepare("SELECT checked_at FROM bill_outcome_checks WHERE bill_id = ?").bind(billId).first();
    return { outcome: o || null, checked: checked ? checked.checked_at : null };
  }, { outcome: null, checked: null });

// ---------------------------------------------------------------------------
// Rendering

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pager = (base, tab, params, more, offset) =>
  more ? `<a class="btn btn--block" href="${esc(base)}?${new URLSearchParams({ ...params, offset: String(offset + PER_PAGE) })}#${tab}">Older</a>` : "";
const filterChips = (base, tab, key, current, options) =>
  `<div class="pill-filter" role="group" aria-label="Show">${options
    .map(([value, label]) => `<a class="toggle" href="${esc(base)}?${new URLSearchParams(value === "all" ? {} : { [key]: value })}#${tab}"${current === value ? ' aria-current="true"' : ""}>${esc(label)}</a>`)
    .join("")}</div>`;

/** Executive orders (and, for the Governor, proclamations), newest first. */
export function ordersTab(o, data, base, offset) {
  const federal = o.chamber === "us-executive";
  const intro = federal
    ? `<p class="small">Executive orders signed by ${esc(o.name)} in this term, as published in the Federal Register, newest first. Titles are exactly as published.</p>`
    : `<p class="small">Executive orders and proclamations posted by the Governor's Office under “Executive orders”, newest first. Titles are the Governor's Office's own headlines; each links to the post and, where linked, the signed document.</p>`;
  if (!data.rows.length) return `${intro}<p class="secondary small">None loaded yet. They appear after the data sync runs.</p>`;
  const rows = data.rows
    .map((a) => {
      const label = a.kind === "proclamation" ? "Proclamation" : "Executive order";
      const num = a.number ? (federal ? `Executive Order ${a.number}` : `Executive Order ${a.number}`) : label;
      const when = a.signed_on ? `Signed ${fmtDate(a.signed_on)}` : a.published_on ? `Posted ${fmtDate(a.published_on)}` : "";
      const doc = safeUrl(a.document_url) ? ` · <a class="inline-link" href="${esc(a.document_url)}" target="_blank" rel="noopener">${federal ? "PDF" : "Signed document"} ↗</a>` : "";
      return `<li class="exec-row stack-xs">
  <span class="label">${esc(num)}${a.citation ? ` · ${esc(a.citation)}` : ""}</span>
  <a class="exec-title" href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
  <span class="small secondary">${esc(when)}${doc}</span>
</li>`;
    })
    .join("");
  const counts = federal
    ? `<p class="small"><strong>${plural(data.counts.executive_order || 0, "executive order", "executive orders")}</strong> loaded.</p>`
    : `<p class="small"><strong>${plural(data.counts.executive_order || 0, "executive order", "executive orders")}</strong> and <strong>${plural(data.counts.proclamation || 0, "proclamation", "proclamations")}</strong> loaded.</p>`;
  return `${intro}${counts}<ul class="plain-list card exec-list">${rows}</ul>${pager(base, "orders", {}, data.more, offset)}
  <p class="hint">Source: ${federal ? '<a class="inline-link" href="https://www.federalregister.gov/presidential-documents/executive-orders" target="_blank" rel="noopener">Federal Register</a>' : '<a class="inline-link" href="https://www.gov.ca.gov/category/executive-orders/" target="_blank" rel="noopener">Office of the Governor</a>'}.</p>`;
}

/** Bills signed and vetoed. */
export function billsTab(o, data, base, show, offset) {
  const federal = o.chamber === "us-executive";
  const c = data.counts || {};
  const intro = `<p class="small">Bills ${federal ? "Congress sent to" : "the Legislature sent to"} ${esc(o.name)} and what happened, from ${
    federal ? "Congress.gov's record of each bill's actions" : "each bill's history on California Legislative Information (leginfo)"
  }. Each bill's page shows the recorded action and links to it.</p>`;
  const tally = `<ul class="plain-list money-list">
    ${[
      ["Signed into law", c.signed],
      ["Vetoed", c.vetoed],
      ["Became law over a veto", c.over_veto],
      ["Became law without a signature", c.without_signature],
      ["Became law (no signature recorded)", c.became_law],
      ["Awaiting action", c.presented],
    ]
      .filter(([, n]) => n)
      .map(([label, n]) => `<li class="money-row"><span>${esc(label)}</span><span class="money-amt">${n}</span></li>`)
      .join("")}
  </ul>`;
  const rows = data.rows
    .map((r) => `
<a class="list-row link-row" href="/laws/bills/${esc(r.bill_id)}/">
  <div><div class="list-title">${esc(r.bill_number)}: ${esc(r.title)}</div>
  <div class="list-meta">${esc(OUTCOME_LABEL[r.outcome] || r.outcome)} · ${fmtDate(r.action_date)}${r.law_number ? ` · ${esc(r.law_number)}` : ""}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`)
    .join("");
  const filters = filterChips(base, "bills", "show", show, [["all", "All"], ["signed", "Became law"], ["vetoed", "Vetoed"]]);
  if (!data.rows.length && !Object.values(c).some(Boolean)) return `${intro}<p class="secondary small">None loaded yet. They appear after the data sync runs.</p>`;
  return `${intro}${tally}${filters}${rows ? `<div class="card">${rows}</div>` : '<p class="secondary small">None in this group.</p>'}${pager(base, "bills", show === "all" ? {} : { show }, data.more, offset)}`;
}

const STATUS_LABEL = { confirmed: "Confirmed", pending: "Pending", withdrawn: "Withdrawn", returned: "Returned to the President", failed: "Not confirmed" };

export function nominationsTab(o, data, base, status, offset) {
  const c = data.counts || {};
  const total = Object.values(c).reduce((s, n) => s + n, 0);
  const intro = `<p class="small">Civilian nominations ${esc(o.name)} sent to the Senate in this Congress, from Congress.gov, newest first. Each shows the nomination as received and its latest action. Military promotions aren't listed.</p>`;
  if (!total) return `${intro}<p class="secondary small">None loaded yet. They appear after the data sync runs.</p>`;
  const filters = filterChips(base, "nominations", "status", status, [["all", `All (${total})`], ["confirmed", `Confirmed (${c.confirmed || 0})`], ["pending", `Pending (${c.pending || 0})`], ["withdrawn", `Withdrawn (${c.withdrawn || 0})`]]);
  const rows = data.rows
    .map((n) => `<li class="exec-row stack-xs">
  <span class="label">${esc(n.id)}${n.organization ? ` · ${esc(n.organization)}` : ""}</span>
  <span>${esc(n.description)}</span>
  <span class="small secondary">${STATUS_LABEL[n.status] || "Pending"}${n.latest_action ? `: ${esc(n.latest_action)}` : ""}${n.latest_on ? ` (${fmtDate(n.latest_on)})` : ""} · <a class="inline-link" href="${esc(n.source_url)}" target="_blank" rel="noopener">Congress.gov ↗</a></span>
</li>`)
    .join("");
  return `${intro}${filters}${rows ? `<ul class="plain-list card exec-list">${rows}</ul>` : '<p class="secondary small">None in this group.</p>'}${pager(base, "nominations", status === "all" ? {} : { status }, data.more, offset)}`;
}

/** Funding for executive offices other than the President. */
export function executiveFundingNote(o) {
  if (o.chamber === "us-executive" && o.rank === 2) {
    return `<p class="secondary small">The Federal Election Commission has no separate campaign record for the Vice President's office in the data ThePillory uses. The ticket's campaign money is on the President's Funding tab.</p>`;
  }
  if (o.chamber === "us-executive") {
    return `<p class="secondary small">Cabinet members are appointed, not elected, so they have no campaign committees and no campaign funding to show.</p>`;
  }
  return null;
}

/** "Final action" on a bill page: signed, vetoed, or law without a signature. */
export function outcomeSection(b, { outcome: o, checked }) {
  const who = b.level === "federal" ? "the President" : "the Governor";
  const where = b.level === "federal" ? "Congress.gov's record of the bill's actions" : "the bill's history on California Legislative Information (leginfo)";
  if (!o) {
    return `<section class="card stack-sm" id="outcome">
  <h2 class="label">Final action</h2>
  <p class="small">${checked ? `No signature, veto or enactment by ${who} is recorded for this bill (checked ${fmtDate(String(checked).slice(0, 10))}).` : `Not checked yet. ${b.level === "federal" ? "The President's" : "The Governor's"} action on a bill appears here after the data sync looks it up.`}</p>
  <p class="hint">From ${where}.</p>
</section>`;
  }
  const actor = o.actor_name ? (o.actor_slug ? `<a class="inline-link" href="/reps/${esc(o.actor_slug)}/">${esc(o.actor_name)}</a>` : esc(o.actor_name)) : who;
  const line =
    o.outcome === "presented"
      ? `Presented to ${who} on ${fmtDate(o.action_date)}. No action recorded yet.`
      : `${esc(OUTCOME_LABEL[o.outcome])} · ${fmtDate(o.action_date)}`;
  return `<section class="card stack-sm" id="outcome">
  <h2 class="label">Final action</h2>
  <p class="outcome-line"><strong>${line}</strong></p>
  ${o.outcome === "presented" ? "" : `<p class="small">${o.outcome === "became_law" ? "Became law; the record doesn't show a signature." : `${b.level === "federal" ? "President" : "Governor"}: ${actor}.`}${o.law_number ? ` ${esc(o.law_number)}.` : ""}${o.presented_on && o.outcome !== "presented" ? ` Presented ${fmtDate(o.presented_on)}.` : ""}</p>`}
  <p class="small secondary">Recorded action: “${esc(o.action_text)}”</p>
  ${sourceLink(o.source_url, b.level === "federal" ? "Congress.gov actions" : "leginfo bill history")}
</section>`;
}

/** Rows for "Who represents you": the federal executive, and California's when relevant. */
export function executiveRows(officials, { cabinetLink = true } = {}) {
  const lead = officials.filter((o) => o.rank && o.rank < 10);
  const rest = officials.filter((o) => !o.rank || o.rank >= 10);
  const row = (o) => linkRow(`/reps/${o.slug}/`, o.name, o.office);
  return `${lead.map(row).join("")}${
    cabinetLink && rest.length ? linkRow("/bodies/us-executive/", "The Cabinet", `${rest.length} ${rest.length === 1 ? "member" : "members"}, as listed by the White House`) : rest.map(row).join("")
  }`;
}
