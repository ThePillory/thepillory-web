// Pieces of the hub (/) and the briefings: Happening now, the district lookup
// form, and the waitlist counts. Everything shown is from D1 or an honest
// empty state.
import { esc, fmtDate } from "./render.js";
import { CHAMBER_NAME } from "./data.js";
import { billHref, tallyText } from "./votes.js";
import { isPublic, badge, provisionsFor } from "./analysis.js";
import { describe } from "./districts.js";

const TITLE_MAX = 160;

function shortTitle(t) {
  const s = String(t || "").trim();
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, "")}…` : s;
}

const missingTable = (err) => /no such table|no such column/i.test(String(err && err.message));

/**
 * Notable recent bills at one level ("federal" or "state"): each bill's latest
 * final-passage vote, newest first, leaving out bills the relevance check set
 * aside as ceremonial or routine. Each row carries the vote's totals, the
 * bill's public analysis (if any), and the positions of `officialIds`.
 */
export async function happeningNow(db, level, { limit = 4, officialIds = [] } = {}) {
  const skip = `AND NOT EXISTS (SELECT 1 FROM bill_relevance r WHERE r.bill_id = b.id AND r.verdict = 'skip' AND r.override IS NULL)`;
  const sql = (withSkip) => `
    SELECT v.*, b.bill_number, b.title AS bill_title, b.summary AS bill_summary
    FROM votes v JOIN bills b ON b.id = v.bill_id
    WHERE v.vote_type = 'final_passage' AND v.level = ? ${withSkip ? skip : ""}
      AND v.id = (SELECT v2.id FROM votes v2 WHERE v2.bill_id = v.bill_id AND v2.vote_type = 'final_passage'
                  ORDER BY v2.vote_date DESC, v2.id DESC LIMIT 1)
    ORDER BY v.vote_date DESC, v.id DESC LIMIT ?`;
  // From bill_list (built during the sync): each bill's latest final-passage
  // vote and whether the relevance check set it aside. Before the first build,
  // the same from the votes table.
  const fromList = `
    SELECT v.*, b.bill_number, b.title AS bill_title, b.summary AS bill_summary
    FROM bill_list l JOIN votes v ON v.id = l.final_vote_id JOIN bills b ON b.id = l.bill_id
    WHERE l.level = ? AND l.last_final IS NOT NULL AND l.routine = 0
    ORDER BY l.last_final DESC, v.id DESC LIMIT ?`;
  let rows;
  try {
    rows = (await db.prepare(fromList).bind(level, limit).all()).results;
  } catch (err) {
    if (!missingTable(err)) throw err;
    try {
      rows = (await db.prepare(sql(true)).bind(level, limit).all()).results;
    } catch (err2) {
      if (!missingTable(err2)) throw err2;
      rows = (await db.prepare(sql(false)).bind(level, limit).all()).results;
    }
  }
  if (!rows.length) return rows;

  // Public analyses for these bills (summary, first provision, review label).
  const byBill = new Map();
  try {
    const { results } = await db
      .prepare(`SELECT * FROM bill_analyses WHERE current = 1 AND bill_id IN (${rows.map(() => "?").join(",")})`)
      .bind(...rows.map((r) => r.bill_id))
      .all();
    for (const a of results) if (isPublic(a)) byBill.set(a.bill_id, a);
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  const firstClause = (a) => {
    try {
      return (JSON.parse(a.clauses || "[]")[0] || {}).id || null;
    } catch (_) {
      return null;
    }
  };
  const provisions = await provisionsFor(db, [...byBill.values()].map(firstClause)).catch((err) => {
    if (missingTable(err)) return new Map();
    throw err;
  });

  let positions = [];
  if (officialIds.length) {
    positions = (
      await db
        .prepare(
          `SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug FROM vote_positions p JOIN officials o ON o.id = p.official_id
           WHERE p.vote_id IN (${rows.map(() => "?").join(",")}) AND p.official_id IN (${officialIds.map(() => "?").join(",")})
           ORDER BY o.name`
        )
        .bind(...rows.map((r) => r.id), ...officialIds)
        .all()
    ).results;
  }
  for (const r of rows) {
    r.analysis = byBill.get(r.bill_id) || null;
    r.provision = r.analysis ? provisions.get(firstClause(r.analysis)) || null : null;
    r.positions = positions.filter((p) => p.vote_id === r.id);
  }
  return rows;
}

/** One Happening now card. `personal`: the visitor's reps are known. */
export function nowCard(v, { personal = false } = {}) {
  const a = v.analysis;
  const chip = v.provision
    ? `<a class="chip chip--parch" href="/laws/constitution/#${esc(v.provision.id)}">${esc(v.provision.label)}</a>`
    : '<span class="chip chip--quiet">Not yet mapped to the Constitution</span>';
  const summary = a
    ? `<p class="small">${esc(a.plain_summary)}</p>`
    : v.bill_summary
      ? `<p class="small">${esc(v.bill_summary)}</p>`
      : '<p class="small secondary">No plain-language summary yet. The official title is above.</p>';
  const tally = tallyText(v);
  const mine = v.positions.length
    ? `<ul class="plain-list now-positions">${v.positions
        .map((p) => `<li><a class="inline-link" href="/reps/${esc(p.slug)}/#votes">${esc(p.name)}</a><span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></li>`)
        .join("")}</ul>`
    : "";
  return `
<article class="card now-card stack-sm" data-level="${esc(v.level)}">
  <div class="card-top"><span class="label">${esc(CHAMBER_NAME[v.chamber] || "")} · Final passage</span><span class="card-top-note">${esc(v.result)} · ${fmtDate(v.vote_date)}</span></div>
  <h3><a class="now-title" href="${billHref(v.bill_id)}">${esc(v.bill_number)}: ${esc(shortTitle(v.bill_title))}</a></h3>
  ${summary}
  <div class="chips">${chip}${a ? badge(a) : ""}</div>
  ${tally ? `<p class="tally small">${tally}</p>` : ""}
  ${mine}
  <a class="inline-link" href="${billHref(v.bill_id)}#votes">${personal ? "All recorded votes on this bill" : "See how your rep voted"}</a>
</article>`;
}

/** The Congress / California toggle and cards. `which`: "federal" | "state". */
export function happeningSection(rows, which, { hrefFor, personal = false, loaded = true, id = "now" } = {}) {
  const opt = (value, label) =>
    `<a class="toggle" href="${esc(hrefFor(value))}#${id}"${which === value ? ' aria-current="true"' : ""}>${label}</a>`;
  const body = rows.length
    ? rows.map((v) => nowCard(v, { personal })).join("")
    : `<p class="secondary small empty-note">${loaded ? "No final-passage votes loaded yet." : "Votes appear here once the data sync has run."}</p>`;
  return `
<section class="brief-section" id="${id}" aria-labelledby="h-${id}">
  <div class="section-head"><h2 class="label" id="h-${id}">Happening now</h2><a class="section-link" href="/votes/?level=${which}">All votes</a></div>
  <nav class="segmented" aria-label="Congress or California">${opt("federal", "Congress")}${opt("state", "California")}</nav>
  <p class="hint">The latest bills to get a final vote in ${which === "federal" ? "the House or Senate" : "the State Assembly or Senate"}, newest first. Ceremonial measures are left out.</p>
  ${body}
</section>`;
}

/** The address or ZIP lookup. `d`: the visitor's districts, if known. */
export function lookupForm(d, { id = "find", heading = "Find your representatives" } = {}) {
  return `
<section class="card stack-sm lookup" id="${id}" aria-labelledby="h-${id}">
  <h2 class="label" id="h-${id}">${esc(heading)}</h2>
  ${d ? `<p class="small">Showing: <strong>${esc(describe(d))}</strong>. <button class="linkish" type="button" data-forget-districts>Forget this</button></p>` : ""}
  <form class="lookup-form" data-district-lookup action="/api/districts" method="post">
    <label class="visually-hidden" for="${id}-q">Street address or ZIP code</label>
    <div class="lookup-row">
      <input class="input" id="${id}-q" name="q" type="text" inputmode="text" autocomplete="street-address" placeholder="Street address or ZIP code" required />
      <button class="btn btn--primary" type="submit">Find</button>
    </div>
    <p class="hint">Used only to find your districts. Not stored.</p>
    <div class="lookup-result" data-lookup-result aria-live="polite"></div>
  </form>
  <noscript><p class="small secondary">The lookup needs JavaScript. You can also browse <a class="inline-link" href="/reps/">all reps by state</a>.</p></noscript>
</section>`;
}

export async function waitlistCounts(db) {
  try {
    const r = await db.prepare("SELECT COUNT(DISTINCT email) AS people, COUNT(DISTINCT county_fips) AS counties FROM waitlist").first();
    return { people: r ? r.people : 0, counties: r ? r.counties : 0 };
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}
