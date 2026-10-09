// The Time Machine: a year bar on place, official and topic pages, and the
// facts for a past year. Who held each office comes from data/history/ (built
// by tools/build_history.py from official sources); votes, executive orders,
// nominations and campaign totals come from D1 (the sync's history steps).
// Every past view lists what isn't available for that year instead of leaving
// blanks. Party is plain text, the same for everyone; nothing here is scored.
import { esc, fmtDate } from "./render.js";
import { asset } from "./geo.js";
import { orderHref } from "./orders.js";
import { CABINET, cabinetPosition, holdersInYear } from "../../workers/sync/src/history/parse.js";

/** The earliest year the slider reaches: officeholder records and the federal budget tables start here. */
export const FIRST_YEAR = 1993;
export const thisYear = (now = new Date()) => now.getUTCFullYear();

/** The past year a page is asked for (?year=), or null for today. */
export function pickYear(url, now = new Date()) {
  const y = parseInt(url.searchParams.get("year") || "", 10);
  return Number.isFinite(y) && y >= FIRST_YEAR && y < thisYear(now) ? y : null;
}

/** The same address without ?year= (and without paging that belongs to a year). */
export function todayHref(url) {
  const u = new URL(url.toString());
  for (const k of ["year", "page", "offset"]) u.searchParams.delete(k);
  return `${u.pathname}${u.search}`;
}

/**
 * The year bar: a slider in a plain GET form. Without JavaScript, "Show" submits
 * it; with it (assets/app.js, [data-year-bar]), letting go of the slider does.
 */
export function yearBar(url, year, { min = FIRST_YEAR, now = new Date(), label = "See this page in another year" } = {}) {
  const max = thisYear(now);
  const value = year || max;
  const keep = [...new URL(url.toString()).searchParams.entries()].filter(([k]) => !["year", "page", "offset"].includes(k));
  return `<form class="year-bar card" method="get" action="${esc(new URL(url.toString()).pathname)}" data-year-bar>
  ${keep.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`).join("")}
  <label class="year-bar-label" for="year-range"><span class="label">Time Machine</span> <span class="small">${esc(label)}</span></label>
  <div class="year-bar-row">
    <input class="year-range" id="year-range" type="range" name="year" min="${min}" max="${max}" step="1" value="${value}" aria-valuetext="${value === max ? `${max}, today` : value}" />
    <output class="year-out" for="year-range">${value === max ? "Today" : value}</output>
  </div>
  <div class="year-bar-ends xsmall secondary"><span>${min}</span><span>Today</span></div>
  <button class="btn btn--block year-go" type="submit">Show this year</button>
</form>`;
}

/** Shown on every past-year view: which year, and one tap back to today. Sticks to the top while scrolling. */
export function pastBanner(year, url) {
  return `<div class="past-banner" role="status">
  <span><span class="label">Viewing</span> <strong>${year}</strong></span>
  <a class="btn btn--sm past-banner-back" href="${esc(todayHref(url))}">Back to today</a>
</div>`;
}

/** The list of what isn't available for this year. */
export function gapsSection(year, gaps) {
  if (!gaps.length) return "";
  return `<section class="card stack-xs gaps" aria-labelledby="h-gaps">
  <h2 class="label" id="h-gaps">Not available for ${year}</h2>
  <ul class="plain-list stack-xs">${gaps.map((g) => `<li class="small">${g}</li>`).join("")}</ul>
  <p class="hint">Sources and coverage: <a class="inline-link" href="/about/methodology/#time-machine">How the Time Machine works</a></p>
</section>`;
}

// ---------------------------------------------------------------------------
// Static history data (data/history/)

export const loadFederalExecutive = (env, request) => asset(env, request, "/data/history/federal-executive.json");
export const loadCongress = (env, request, st) => (/^[a-z]{2}$/.test(st) ? asset(env, request, `/data/history/congress/${st}.json`) : null);
export const loadDistricts = (env, request, st) => (/^[a-z]{2}$/.test(st) ? asset(env, request, `/data/history/districts/${st}.json`) : null);
export const loadCalifornia = (env, request) => asset(env, request, "/data/history/california.json");
export const loadFinances = (env, request) => asset(env, request, "/data/history/finances.json");

const yearOf = (iso) => parseInt(String(iso || "").slice(0, 4), 10);

/** The President and Vice President terms that overlap a year. */
export function executiveIn(fe, year) {
  const terms = holdersInYear((fe && fe.terms) || [], year);
  return { presidents: terms.filter((t) => t.office === "President"), vps: terms.filter((t) => t.office === "Vice President") };
}

/** A county's districts in a year (data/history/districts/<st>.json), or null where the files don't cover that year. */
export function districtsIn(dist, fips, year) {
  const p = ((dist && dist.periods) || []).find((x) => x.from <= year && (x.to == null || year <= x.to));
  if (!p) return null;
  return { cd: p.cd[fips] || [], sldu: p.sldu ? p.sldu[fips] || [] : null, sldl: p.sldl ? p.sldl[fips] || [] : null, from: p.from, to: p.to, note: p.note, source: p.source };
}

/** One row per person: back-to-back terms in the same seat become one span. */
export function mergeTerms(terms) {
  const out = [];
  for (const t of [...terms].sort((a, b) => a.start.localeCompare(b.start))) {
    const prev = out.find((x) => (x.bioguide && x.bioguide === t.bioguide) || (!x.bioguide && x.name === t.name && x.office === t.office));
    if (prev) {
      if (t.start < prev.start) prev.start = t.start;
      if (t.end > prev.end) prev.end = t.end;
    } else out.push({ ...t });
  }
  return out;
}

/** Members of Congress for a state in a year: senators, and the House seats asked for (or all). */
export function congressIn(cong, year, houseDistricts = null) {
  const senate = mergeTerms(holdersInYear((cong && cong.senate) || [], year));
  const house = {};
  for (const [d, terms] of Object.entries((cong && cong.house) || {})) {
    if (houseDistricts && !houseDistricts.includes(d)) continue;
    const held = mergeTerms(holdersInYear(terms, year));
    if (held.length) house[d] = held;
  }
  return { senate, house };
}

/**
 * California's statewide officers and legislators in a year, from general-election
 * winners in the Statement of Vote: an office elected in November serves from the
 * following January. State Senate terms are four years, so a seat's holder is
 * the winner of the latest of the last two elections that included it.
 */
export function californiaIn(cal, year) {
  const elections = ((cal && cal.elections) || []).filter((e) => e.year < year).sort((a, b) => b.year - a.year);
  const governors = ((cal && cal.governors && cal.governors.list) || []).filter((g) => g.from <= year && (g.to == null || year <= g.to));
  const last = elections[0] || null;
  const statewide = [];
  if (last && year - last.year <= 4) {
    // Statewide offices are elected every four years, in the same election as the Governor.
    const gov = elections.find((e) => e.winners.some((w) => w.office === "governor") && year - e.year <= 4);
    if (gov) for (const w of gov.winners) if (!["sldu", "sldl", "cd", "boe"].includes(w.office)) statewide.push({ ...w, election: gov.year, source: gov.source });
  }
  const seat = (office, district) => {
    const span = office === "sldu" ? 4 : 2;
    for (const e of elections) {
      if (year - e.year > span) break;
      const w = e.winners.find((x) => x.office === office && String(x.district) === String(district));
      if (w) return { ...w, election: e.year, source: e.source };
    }
    return null;
  };
  return { governors, statewide, seat, covered: !!last && year - last.year <= 2, firstElection: ((cal && cal.elections) || []).reduce((m, e) => Math.min(m, e.year), 9999) };
}

/** The California Legislature's makeup in force during a year (from the election before it). */
export function legislatureIn(cal, year) {
  return ((cal && cal.legislature_makeup) || []).filter((m) => m.after_election < year && year - m.after_election <= 2).sort((a, b) => b.after_election - a.after_election)[0] || null;
}

// ---------------------------------------------------------------------------
// D1 (history steps in the sync)

const ph = (a) => a.map(() => "?").join(",");

/** Final-passage votes in a year with the positions of the given officials, newest first. */
export async function votesInYear(db, officialIds, year, { limit = 10, chambers = ["us-house", "us-senate"] } = {}) {
  if (!officialIds.length) return { rows: [], more: false };
  const { results } = await db
    .prepare(
      `SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.chamber IN (${ph(chambers)}) AND v.vote_date >= ? AND v.vote_date < ? AND v.vote_type = 'final_passage'
         AND (EXISTS (SELECT 1 FROM vote_positions p WHERE p.vote_id = v.id AND p.official_id IN (${ph(officialIds)}))
           OR EXISTS (SELECT 1 FROM state_positions sp JOIN officials so ON so.k = sp.member_k WHERE sp.vote_k = v.k AND so.id IN (${ph(officialIds)})))
       ORDER BY v.vote_date DESC, v.id DESC LIMIT ?`
    )
    .bind(...chambers, `${year}-01-01`, `${year + 1}-01-01`, ...officialIds, ...officialIds, limit + 1)
    .all();
  const rows = results.slice(0, limit);
  if (rows.length) {
    const { results: pos } = await db
      .prepare(
        `SELECT p.vote_id, p.official_id, p.position, p.raw_position, o.name, o.slug, o.active FROM all_positions p JOIN officials o ON o.id = p.official_id
         WHERE p.vote_id IN (${ph(rows)}) AND p.official_id IN (${ph(officialIds)}) ORDER BY o.name`
      )
      .bind(...rows.map((r) => r.id), ...officialIds)
      .all();
    for (const r of rows) r.positions = pos.filter((p) => p.vote_id === r.id);
  }
  return { rows, more: results.length > limit };
}

/** How many of one official's recorded votes fall in a year (final passage and all). */
export async function voteCountInYear(db, officialId, year) {
  return db
    .prepare(
      `SELECT SUM(total) AS total, SUM(final) AS final FROM (
         SELECT COUNT(*) AS total, SUM(v.vote_type = 'final_passage') AS final FROM vote_positions p JOIN votes v ON v.id = p.vote_id
         WHERE p.official_id = ? AND v.vote_date >= ? AND v.vote_date < ?
         UNION ALL
         SELECT COUNT(*), SUM(v.vote_type = 'final_passage') FROM officials o JOIN state_positions sp ON sp.member_k = o.k JOIN votes v ON v.k = sp.vote_k
         WHERE o.id = ? AND v.vote_date >= ? AND v.vote_date < ?)`
    )
    .bind(officialId, `${year}-01-01`, `${year + 1}-01-01`, officialId, `${year}-01-01`, `${year + 1}-01-01`)
    .first();
}

/** One official's votes in a year, newest first (all kinds, or final passage only). */
export async function officialVotesInYear(db, officialId, year, { all = false, limit = 30, offset = 0 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT v.*, p.position, p.raw_position, b.bill_number, b.title AS bill_title FROM all_positions p
       JOIN votes v ON v.id = p.vote_id LEFT JOIN bills b ON b.id = v.bill_id
       WHERE p.official_id = ? AND v.vote_date >= ? AND v.vote_date < ? AND (? = 1 OR v.vote_type = 'final_passage')
       ORDER BY v.vote_date DESC, v.id DESC LIMIT ? OFFSET ?`
    )
    .bind(officialId, `${year}-01-01`, `${year + 1}-01-01`, all ? 1 : 0, limit + 1, offset)
    .all();
  return { rows: results.slice(0, limit), more: results.length > limit };
}

/** Executive orders signed in a year (Federal Register, from 1994; the Governor's office for California). */
export async function ordersInYear(db, year, { chamber = "us-executive", limit = 12 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT a.*, o.name AS official_name, o.slug AS official_slug, o.active AS official_active FROM executive_actions a JOIN officials o ON o.id = a.official_id
       WHERE o.chamber = ? AND a.kind = 'executive_order' AND a.signed_on >= ? AND a.signed_on < ?
       ORDER BY a.signed_on DESC, a.id DESC LIMIT ?`
    )
    .bind(chamber, `${year}-01-01`, `${year + 1}-01-01`, limit + 1)
    .all();
  const n = await db
    .prepare(`SELECT COUNT(*) AS n FROM executive_actions a JOIN officials o ON o.id = a.official_id WHERE o.chamber = ? AND a.kind = 'executive_order' AND a.signed_on >= ? AND a.signed_on < ?`)
    .bind(chamber, `${year}-01-01`, `${year + 1}-01-01`)
    .first();
  return { rows: results.slice(0, limit), more: results.length > limit, count: n ? n.n : 0 };
}

/** One official's executive orders in a year. */
export async function officialOrdersInYear(db, officialId, year, limit = 30) {
  const { results } = await db
    .prepare(`SELECT * FROM executive_actions WHERE official_id = ? AND kind = 'executive_order' AND signed_on >= ? AND signed_on < ? ORDER BY signed_on DESC, id DESC LIMIT ?`)
    .bind(officialId, `${year}-01-01`, `${year + 1}-01-01`, limit + 1)
    .all();
  return { rows: results.slice(0, limit), more: results.length > limit };
}

/**
 * The Cabinet as Senate confirmations show it at the end of a year: for each
 * department, the latest confirmed nomination on or before December 31. The
 * records don't show departures or acting officials, and the page says so.
 */
export async function cabinetAsOf(db, year) {
  const { results } = await db
    .prepare(
      `SELECT id, congress, description, latest_on, received_on, source_url FROM nominations
       WHERE status = 'confirmed' AND latest_on < ? AND latest_on >= ? AND (description LIKE '%to be Secretary of%' OR description LIKE '%to be Attorney General%')
       ORDER BY latest_on DESC`
    )
    .bind(`${year + 1}-01-01`, `${year - 8}-01-01`)
    .all();
  const out = new Map();
  for (const r of results) {
    const pos = cabinetPosition(r.description);
    if (pos && !out.has(pos)) out.set(pos, { ...r, position: pos, name: String(r.description).split(",")[0].trim() });
  }
  return CABINET.map((p) => out.get(p) || { position: p, missing: true });
}

/** Campaign totals for the two-year period that includes a year (FEC). */
export async function fundingInCycle(db, officialIds, year) {
  if (!officialIds.length) return [];
  const cycle = year % 2 ? year + 1 : year;
  const { results } = await db
    .prepare(`SELECT f.*, o.name, o.slug, o.active FROM funding_cycles f JOIN officials o ON o.id = f.official_id WHERE f.official_id IN (${ph(officialIds)}) AND f.cycle = ? ORDER BY o.name`)
    .bind(...officialIds, cycle)
    .all();
  return results;
}

/** D1 officials (active or not) by id, for linking past officeholders to their pages. */
export async function officialsById(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    if (!part.length) continue;
    const { results } = await db.prepare(`SELECT id, slug, name, active FROM officials WHERE id IN (${ph(part)})`).bind(...part).all();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering helpers

const money = (n) => (n == null ? "Not reported" : `$${Math.round(n).toLocaleString("en-US")}`);
export const dollars = money;

/** "Jan 3, 2003 to Jan 3, 2005" for a term, with "(current)" never implied for past views. */
export const termText = (t) => `${fmtDate(t.start)} to ${t.end && yearOf(t.end) < 9000 ? fmtDate(t.end) : "present"}`;

/** A person who held an office: linked to their page when ThePillory has one. */
export function holderRow(t, { office, linked, year, note = "" }) {
  const name = esc(t.name);
  const party = t.party ? ` · Party: ${esc(t.party)}` : "";
  const meta = `${esc(office)}${party} · ${termText(t)}${note ? ` · ${esc(note)}` : ""}`;
  return linked
    ? `<a class="list-row link-row" href="/reps/${esc(linked.slug)}/?year=${year}"><div><div class="list-title">${name}</div><div class="list-meta">${meta}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`
    : `<div class="list-row"><div><div class="list-title">${name}</div><div class="list-meta">${meta}</div></div></div>`;
}

/** A row for a California officeholder elected in the Statement of Vote. */
export function electedRow(w, label) {
  return `<div class="list-row"><div><div class="list-title">${esc(w.name)}</div><div class="list-meta">${esc(label)}${w.party ? ` · Party: ${esc(w.party)}` : ""} · Elected November ${w.election} · <a class="inline-link" href="${esc(w.source)}" target="_blank" rel="noopener">Statement of Vote ↗</a></div></div></div>`;
}

/** Votes in a past year: one row per position, linked to the bill page. */
export function pastVoteRows(votes) {
  const rows = [];
  for (const v of votes) {
    for (const p of v.positions || []) {
      const facts = `${esc(v.bill_number || v.subject || "")} · ${esc(v.question)} · ${esc(v.result)} · ${fmtDate(v.vote_date)}`;
      const who = p.active ? `<a class="brief-vote-name" href="/reps/${esc(p.slug)}/">${esc(p.name)}</a>` : `<a class="brief-vote-name" href="/reps/${esc(p.slug)}/?year=${yearOf(v.vote_date)}">${esc(p.name)}</a>`;
      const meta = v.bill_id ? `<a class="brief-vote-meta xsmall" href="/laws/bills/${esc(v.bill_id)}/#votes">${facts}</a>` : `<a class="brief-vote-meta xsmall" href="${esc(v.source_url)}" target="_blank" rel="noopener">${facts} ↗</a>`;
      rows.push(`<li class="brief-vote"><div class="brief-vote-main">${who}${meta}</div><span class="brief-vote-position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></li>`);
    }
  }
  return rows.join("");
}

/** Executive orders as published: each links to its page, and to the Federal Register. */
export function orderRows(rows, { who = true } = {}) {
  return rows
    .map((a) => `<li class="exec-row stack-xs">
  <span class="label">${a.number ? `Executive Order ${esc(a.number)}` : "Executive order"}${a.citation ? ` · ${esc(a.citation)}` : ""}</span>
  <a class="inline-link" href="${orderHref(a.id)}">${esc(a.title)}</a>
  <span class="xsmall secondary">${a.signed_on ? `Signed ${fmtDate(a.signed_on)}` : ""}${who && a.official_name ? ` · ${esc(a.official_name)}` : ""} · <a class="inline-link" href="${esc(a.source_url)}" target="_blank" rel="noopener">Federal Register ↗</a></span>
</li>`)
    .join("");
}

/** Campaign totals for a two-year period, as the FEC reports them. */
export function fundingRows(rows) {
  return rows
    .map((f) => `<li class="list-row"><div><div class="list-title">${esc(f.name)}</div><div class="list-meta">${f.cycle - 1}–${f.cycle} · Raised ${money(f.receipts)} · Spent ${money(f.disbursements)}${f.cash_on_hand != null ? ` · Cash on hand at the end ${money(f.cash_on_hand)}` : ""}</div></div><span class="row-end"><a class="inline-link xsmall" href="${esc(f.source_url)}" target="_blank" rel="noopener">FEC ↗</a></span></li>`)
    .join("");
}

export { CABINET, yearOf };
