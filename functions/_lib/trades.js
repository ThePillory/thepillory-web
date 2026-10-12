// Stock trades by members of Congress (STOCK Act Periodic Transaction Reports;
// docs/trades.md). Facts as filed, side by side with the record, never as
// cause: no "conflict" labels, no scores, no ordering by anything but date.
// Amounts are ranges, as the law requires them to be reported. A report filed
// more than 45 days after a trade says so in plain text. The Ethics in
// Government Act forbids commercial use of these records: they stay free,
// with no export or API.
//
//   tradeSummary / memberTrades / memberReports   one member (the More tab, /reps/<slug>/trades/)
//   latestTrades                                  /trades/, newest first, filtered
//   tradeRow, summaryLine, tradesSection          the shared markup
import { esc, fmtDate, linkRow, sourceLink } from "./render.js";

export const TRADES_PER_PAGE = 25;
export const LATE_DAYS = 45;
export const SECTORS = [
  "Agriculture, Forestry and Fishing", "Mining", "Construction", "Manufacturing",
  "Transportation, Communications and Utilities", "Wholesale Trade", "Retail Trade",
  "Finance, Insurance and Real Estate", "Services", "Public Administration",
];
export const TRADES_METHOD = "/about/methodology/#trades";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const soft = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (missing(err)) return fallback;
    throw err;
  }
};
const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

/** "Filed 112 days after the trade" when it's more than 45; plain text, no warning. Pure. */
export function filedLate(t) {
  return t.days_to_file != null && t.days_to_file > LATE_DAYS ? `Filed ${t.days_to_file} days after the trade` : "";
}

/** One trade, one compact line, linking to the report. Pure. */
export function tradeRow(t, { member = false } = {}) {
  const asset = t.ticker && !String(t.asset_name || "").includes(`(${t.ticker})`) ? `${t.asset_name} (${t.ticker})` : t.asset_name;
  const meta = [
    t.transaction_date ? fmtDate(t.transaction_date) : "Date not given",
    member && t.member_name ? `${t.member_name}${t.state ? `, ${t.state}` : ""}` : "",
    t.owner && t.owner !== "Self" ? `Owner: ${t.owner}` : "",
    t.sector || "",
    t.held_in ? `Held in ${t.held_in}` : "",
    filedLate(t),
    t.transcribed_by ? `Transcribed by AI from a scanned report · Checked by ${t.transcribed_by}` : t.transcribed_at ? "Transcribed by AI from a scanned report, auto-checked" : "",
  ].filter(Boolean);
  return `<a class="compact-row trade-row" href="${esc(t.report_url)}" target="_blank" rel="noopener">
  <span class="cr-type">${esc(t.type)}</span>
  <span class="cr-main"><span class="cr-title">${esc(asset)}</span><span class="cr-meta">${esc(t.amount || "Value not given")} · ${meta.map(esc).join(" · ")}</span></span>
  <span class="chev" aria-hidden="true">↗</span>
</a>`;
}

/** "12 trades reported in 2026, totaling $X–$Y in ranges as filed." Pure. */
export function summaryLine(s) {
  if (!s || !s.trades) return "";
  const range = s.total_max == null
    ? `at least ${money(s.total_min)} in ranges as filed (${s.open_ended === 1 ? "one range is" : `${s.open_ended} ranges are`} open-ended)`
    : `${money(s.total_min)}–${money(s.total_max)} in ranges as filed`;
  return `${s.trades} ${s.trades === 1 ? "trade" : "trades"} reported in ${s.year}, totaling ${range}.`;
}

// ---------------------------------------------------------------------------
// Data

export const tradeSummary = (db, officialId) =>
  soft(async () => (await db.prepare("SELECT * FROM trade_summary WHERE official_id = ? ORDER BY year DESC").bind(officialId).all()).results, []);

/** One page of a member's trades, newest first: {rows, more}. */
export const memberTrades = (db, officialId, offset = 0) =>
  soft(async () => {
    const { results } = await db
      .prepare(
        `SELECT t.*, r.report_url, r.transcribed_by, r.transcribed_at FROM trades t JOIN trade_reports r ON r.id = t.report_id
         WHERE t.official_id = ? ORDER BY t.transaction_date DESC, t.report_id DESC, t.n LIMIT ? OFFSET ?`
      )
      .bind(officialId, TRADES_PER_PAGE + 1, offset)
      .all();
    return { rows: results.slice(0, TRADES_PER_PAGE), more: results.length > TRADES_PER_PAGE };
  }, { rows: [], more: false });

/** Reports that are links only: filed on paper, not read automatically, or (OGE) released only on request. */
export const memberReports = (db, officialId) =>
  soft(async () => (await db
    .prepare("SELECT id, filed_on, report_url, request_url, paper FROM trade_reports WHERE official_id = ? AND parsed = 0 ORDER BY filed_on DESC LIMIT 20")
    .bind(officialId)
    .all()).results, []);

/** The President's, Vice President's or a Cabinet member's position and agency, as OGE lists them. */
export const executivePost = (db, officialId) =>
  soft(async () => db
    .prepare("SELECT position, agency FROM disclosures WHERE official_id = ? AND source = 'oge' AND agency IS NOT NULL ORDER BY filed_on DESC LIMIT 1")
    .bind(officialId)
    .first(), null);

/** "Senate Committee on the Judiciary" → "Judiciary"; other names as listed ("Senate Special Committee on Aging" → "Special Committee on Aging"). Pure. */
export function committeeShortName(name) {
  const n = String(name || "").trim();
  const m = /^(?:(?:Senate|House|Joint)\s+)?Committee\s+on\s+(?:the\s+)?(.+)$/i.exec(n);
  return m ? m[1] : n.replace(/^(?:Senate|House)\s+/i, "");
}

/** Every current committee assignment, full committees first, each followed by its subcommittees. */
export function committeesList(committees) {
  const full = committees.filter((c) => !c.parent);
  const subs = (name) => committees.filter((c) => c.parent === name);
  const orphans = committees.filter((c) => c.parent && !full.some((f) => f.name === c.parent));
  const item = (c, sub = false) =>
    `<li class="list-row"><span class="list-title${sub ? " small" : ""}">${sub ? "Subcommittee: " : ""}${esc(c.name)}</span>${c.title ? `<span class="row-end small secondary">${esc(c.title)}</span>` : ""}</li>`;
  return `<div class="card"><ul class="plain-list">${[...full.flatMap((c) => [item(c), ...subs(c.name).map((x) => item(x, true))]), ...orphans.map((c) => item({ ...c, name: `${c.parent}: ${c.name}` }, true))].join("")}</ul></div>
  <p class="hint">Committee assignments as listed by congress-legislators. ${sourceLink(committees[0].source_url)}</p>`;
}

export const memberCommittees = (db, officialId) =>
  soft(async () => (await db
    .prepare("SELECT committee_id, name, parent, title, source_url FROM congress_committees WHERE official_id = ? ORDER BY COALESCE(parent, name), parent IS NOT NULL, name")
    .bind(officialId)
    .all()).results, []);

/** /trades/: newest first, by chamber, state, sector and member name; one page. */
export function tradeFilters(params) {
  const chamber = ["us-house", "us-senate", "us-executive"].includes(params.get("chamber")) ? params.get("chamber") : "";
  const state = /^[A-Z]{2}$/.test(params.get("state") || "") ? params.get("state") : "";
  const sector = SECTORS.includes(params.get("sector")) ? params.get("sector") : "";
  const q = String(params.get("q") || "").replace(/[%_]/g, "").trim().slice(0, 60);
  const offset = Math.max(0, parseInt(params.get("offset") || "0", 10) || 0);
  return { chamber, state, sector, q, offset };
}

export const tradesHref = (f, offset = 0) => {
  const p = new URLSearchParams();
  for (const k of ["chamber", "state", "sector", "q"]) if (f[k]) p.set(k, f[k]);
  if (offset) p.set("offset", String(offset));
  const s = p.toString();
  return `/trades/${s ? `?${s}` : ""}`;
};

export const latestTrades = (db, f) =>
  soft(async () => {
    const where = ["1 = 1"];
    const binds = [];
    if (f.chamber) (where.push("t.chamber = ?"), binds.push(f.chamber));
    if (f.state) (where.push("t.state = ?"), binds.push(f.state));
    if (f.sector) (where.push("t.sector = ?"), binds.push(f.sector));
    if (f.q) (where.push("lower(o.name) LIKE ?"), binds.push(`%${f.q.toLowerCase()}%`));
    const { results } = await db
      .prepare(
        `SELECT t.*, r.report_url, r.transcribed_by, r.transcribed_at, o.name AS member_name, o.slug AS member_slug FROM trades t
         JOIN trade_reports r ON r.id = t.report_id JOIN officials o ON o.id = t.official_id
         WHERE ${where.join(" AND ")} ORDER BY t.transaction_date DESC, t.report_id DESC, t.n LIMIT ? OFFSET ?`
      )
      .bind(...binds, TRADES_PER_PAGE + 1, f.offset)
      .all();
    return { rows: results.slice(0, TRADES_PER_PAGE), more: results.length > TRADES_PER_PAGE };
  }, { rows: [], more: false, missing: true });

// ---------------------------------------------------------------------------
// The member's "Stock trades" section (More tab)

const NOTE = `Periodic Transaction Reports members file under the STOCK Act, read from the House Clerk and the Senate's eFD site. Amounts are the ranges the law requires, exactly as filed. Owner is as filed (self, spouse, joint, dependent child). These records may not be used for commercial purposes. <a class="inline-link" href="${TRADES_METHOD}">How trades are recorded</a>`;
const OGE_NOTE = `Periodic Transaction Reports (OGE Form 278-T) filed with the Office of Government Ethics, under the same 45-day rule and amount ranges as Congress. Amounts are shown exactly as filed; owner only where the report states it. Some reports are released by OGE only on request. A report posted as a scan is read by two AI models and published only when the two readings agree row for row and match the report's own text; those lines say "Transcribed by AI", and "Checked by" once a person has compared them with the scan. These records may not be used for commercial purposes. <a class="inline-link" href="${TRADES_METHOD}">How trades are recorded</a>`;

export function tradesSection(o, { summary, page, reports, committees = [], post = null, offset = 0 }) {
  const exec = o.chamber === "us-executive";
  const note = exec ? OGE_NOTE : NOTE;
  const yearNow = new Date().getUTCFullYear();
  const now = summary.find((s) => s.year === yearNow);
  const lines = summary.filter((s) => s.trades).slice(0, 3).map(summaryLine);
  const id = "trade-list";
  const more = page.more ? `<a class="btn btn--block load-more" href="/reps/${esc(o.slug)}/trades/?offset=${offset + TRADES_PER_PAGE}" data-load-more="${id}">Load more</a>` : "";
  // One compact line after the list, never inside it: full committees only, for
  // reference, with every assignment (subcommittees too) on the About tab.
  const full = committees.filter((c) => !c.parent);
  const reference = full.length
    ? `<p class="small secondary trades-reference">Committee assignments, for reference: ${full.map((c) => esc(committeeShortName(c.name))).join("; ")}. <a class="inline-link" href="#congress-committees">All committee assignments</a></p>`
    : exec
      ? `<p class="small secondary trades-reference">Office, for reference: ${esc((post && post.position) || o.office)}${post && post.agency ? `, ${esc(post.agency)}` : ""}.</p>`
      : "";
  const reportLinks = reports.length
    ? `<p class="label">Reports not shown line by line</p><div class="card">${reports
        .map((r) => (!r.report_url && r.request_url
          ? linkRow(r.request_url, "Available from OGE on request", `Listed ${fmtDate(r.filed_on)} · Request it with OGE Form 201`)
          : linkRow(r.report_url, r.paper ? "Filed on paper: see the report" : "Not read automatically: see the report", `Filed ${fmtDate(r.filed_on)}`)))
        .join("")}</div>`
    : "";
  if (!page.rows.length && !reports.length) {
    return `<p class="small secondary">No stock trades by ${esc(o.name)} are on ThePillory yet. ${exec ? "Reports listed by the Office of Government Ethics load daily." : "Reports since 2023 load daily, newest first."}</p>${reference}<p class="hint">${note}</p>`;
  }
  return `
  ${lines.length ? `<div class="stack-xs">${lines.map((l) => `<p class="small">${esc(l)}</p>`).join("")}</div>` : ""}
  ${now && now.paper && !exec ? `<p class="small secondary">Also ${now.paper} ${now.paper === 1 ? "report" : "reports"} filed on paper in ${yearNow}, linked after the list.</p>` : ""}
  <p class="label">Trades, newest first</p>
  <div class="card compact-list" id="${id}">${page.rows.map((t) => tradeRow(t)).join("") || '<p class="secondary small cr-empty">No trades read from electronic reports.</p>'}</div>
  ${more}
  ${reference}
  ${reportLinks}
  <p class="hint">${note}</p>`;
}

/** Quick mode's one line: "Reported 12 stock trades this year", linking to the list. Pure. */
export function quickTradesLine(summary) {
  const yearNow = new Date().getUTCFullYear();
  const now = (summary || []).find((s) => s.year === yearNow);
  if (!now || !now.trades) return "";
  return `<a class="inline-link" href="#more-trades" data-mode-set="detailed">Reported ${now.trades} stock ${now.trades === 1 ? "trade" : "trades"} this year</a>`;
}
