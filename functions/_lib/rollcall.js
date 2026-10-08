// A bill's roll calls (the "All votes" section of a bill page, and
// /laws/bills/<id>/rollcall/): every member's recorded position on one vote,
// 20 at a time, with the totals and their breakdown by party and by state.
// Every query reads one vote's positions through the (vote_id, official_id)
// key, at most a few hundred rows; nothing reads the whole positions table.
// Positions and parties are plain text, one style for every party.
import { esc, fmtDate, sourceLink } from "./render.js";
import { CHAMBER_NAME, TYPE_LABELS } from "./data.js";
import { voteBar } from "./charts.js";

export const ROLL_PER_PAGE = 20;
export const POSITIONS = ["Yes", "No", "Present", "Not voting"];

/** The filters in a roll-call address: ?vote=&q=&position=&party=&state=&offset=. */
export function rollCallFilters(url) {
  const p = url.searchParams;
  const clean = (s, max = 60) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
  return {
    vote: clean(p.get("vote"), 200) || null,
    q: clean(p.get("q")),
    position: POSITIONS.includes(p.get("position")) ? p.get("position") : "",
    party: clean(p.get("party")),
    state: /^[A-Z]{2}$/.test(p.get("state") || "") ? p.get("state") : "",
    offset: Math.max(0, parseInt(p.get("offset") || "0", 10) || 0),
  };
}

export function rollCallHref(billId, voteId, f = {}, offset = 0) {
  const q = new URLSearchParams({ vote: voteId });
  for (const k of ["q", "position", "party", "state"]) if (f[k]) q.set(k, f[k]);
  if (offset) q.set("offset", String(offset));
  return `/laws/bills/${encodeURIComponent(billId)}/rollcall/?${q}`;
}

/**
 * The vote to show: the one asked for (?vote=), else the latest final-passage
 * vote, else the latest vote of any kind. `votes` are newest first.
 */
export function pickVote(votes, voteId) {
  return (voteId && votes.find((v) => v.id === voteId)) || votes.find((v) => v.vote_type === "final_passage") || votes[0] || null;
}

/** One page of members' positions on a vote, by last name, with the filters applied. */
export async function rollCallRows(db, voteId, f) {
  const where = ["p.vote_id = ?"];
  const binds = [voteId];
  if (f.q) {
    where.push("o.name LIKE ? ESCAPE '\\'");
    binds.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (f.position) {
    where.push("p.position = ?");
    binds.push(f.position);
  }
  if (f.party) {
    where.push(f.party === "Not listed" ? "(o.party IS NULL OR o.party = '')" : "o.party = ?");
    if (f.party !== "Not listed") binds.push(f.party);
  }
  if (f.state) {
    where.push("o.state = ?");
    binds.push(f.state);
  }
  const sql = `FROM vote_positions p JOIN officials o ON o.id = p.official_id WHERE ${where.join(" AND ")}`;
  const { results } = await db
    .prepare(
      `SELECT o.name, o.slug, o.party, o.state, o.district, o.chamber, p.position, p.raw_position ${sql}
       ORDER BY COALESCE(o.last_name, o.name) COLLATE NOCASE, o.name COLLATE NOCASE LIMIT ? OFFSET ?`
    )
    .bind(...binds, ROLL_PER_PAGE + 1, f.offset || 0)
    .all();
  const count = await db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...binds).first();
  return { rows: results.slice(0, ROLL_PER_PAGE), more: results.length > ROLL_PER_PAGE, total: count ? count.n : results.length };
}

/** Positions on a vote counted by party and by state, and the filter choices. */
export async function rollCallBreakdown(db, voteId) {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(NULLIF(o.party, ''), 'Not listed') AS party, o.state, p.position, COUNT(*) AS n
       FROM vote_positions p JOIN officials o ON o.id = p.official_id WHERE p.vote_id = ?
       GROUP BY 1, 2, 3`
    )
    .bind(voteId)
    .all();
  const tally = (key) => {
    const m = new Map();
    for (const r of results) {
      const k = r[key] || "Not listed";
      if (!m.has(k)) m.set(k, { name: k, Yes: 0, No: 0, Present: 0, "Not voting": 0, total: 0 });
      const t = m.get(k);
      t[r.position] += r.n;
      t.total += r.n;
    }
    return [...m.values()];
  };
  const byParty = tally("party").sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const byState = tally("state").sort((a, b) => a.name.localeCompare(b.name));
  return { byParty, byState, loaded: results.reduce((s, r) => s + r.n, 0) };
}

/** Where a member sits: "CA-5", "CA · Senate", "Assembly District 8". */
export function seatOf(o) {
  if (o.chamber === "us-house") return o.district || o.state || "";
  if (o.chamber === "us-senate") return `${o.state || ""} · Senate`;
  return o.district || CHAMBER_NAME[o.chamber] || "";
}

export function rollCallRow(r) {
  return `<a class="roll-row" href="/reps/${esc(r.slug)}/">
  <span class="roll-name">${esc(r.name)}<span class="roll-meta">${esc([r.party || "Party not listed", seatOf(r)].filter(Boolean).join(" · "))}</span></span>
  <span class="position" title="Recorded as: ${esc(r.raw_position)}">${esc(r.position)}</span>
</a>`;
}

/** The picker: every recorded vote on the bill, newest first, with its kind, date and result. */
export function votePicker(votes, selected, action) {
  if (votes.length < 2) return "";
  return `<form class="vote-picker stack-xs" method="get" action="${esc(action)}">
  <label class="field"><span class="field-label">Recorded votes on this bill (${votes.length})</span>
  <select class="input" name="vote" data-autosubmit>${votes
    .map((v) => `<option value="${esc(v.id)}"${v.id === selected.id ? " selected" : ""}>${esc(`${TYPE_LABELS[v.vote_type] || "Other"} · ${CHAMBER_NAME[v.chamber] || ""} · ${fmtDate(v.vote_date).replace(/<[^>]+>/g, "")} · ${v.result}`)}</option>`)
    .join("")}</select></label>
  <noscript><button class="btn" type="submit">Show this vote</button></noscript>
</form>`;
}

const tableOf = (rows, head) => `<div class="table-scroll"><table class="tally-table"><thead><tr><th scope="col">${esc(head)}</th>${POSITIONS.map((p) => `<th scope="col">${esc(p)}</th>`).join("")}</tr></thead><tbody>${rows
  .map((r) => `<tr><th scope="row">${esc(r.name)}</th>${POSITIONS.map((p) => `<td>${r[p]}</td>`).join("")}</tr>`)
  .join("")}</tbody></table></div>`;

/** The totals as the source recorded them, then the loaded positions by party and by state. */
export function totalsSection(v, breakdown, { federal }) {
  const official = v.yea != null || v.nay != null;
  const counted = breakdown.loaded;
  return `<div class="stack-sm">
  ${voteBar(v)}
  ${official ? "" : `<p class="small secondary">The source gave no totals for this vote; the counts below are the ${counted} positions loaded.</p>`}
  ${breakdown.byParty.length ? `<p class="label">By party</p>${tableOf(breakdown.byParty, "Party")}` : ""}
  ${federal && breakdown.byState.length > 1 ? `<details class="weigh-details"><summary>By state (${breakdown.byState.length})</summary>${tableOf(breakdown.byState, "State")}</details>` : ""}
  ${official && counted && counted !== (v.yea || 0) + (v.nay || 0) + (v.present || 0) + (v.not_voting || 0) ? `<p class="hint">The breakdown counts the ${counted} members whose positions are loaded; the totals above are the official record's.</p>` : ""}
  <p class="hint">Party is as each member's record lists it. Counts are of recorded positions, nothing more.</p>
</div>`;
}

/** The search box and filters; without JavaScript they open the roll-call page. */
export function rollCallFilterForm(billId, v, f, { parties, states, federal }) {
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
  return `<form class="roll-filters" method="get" action="/laws/bills/${esc(encodeURIComponent(billId))}/rollcall/" data-rollcall="rollcall-list" role="search">
  <input type="hidden" name="vote" value="${esc(v.id)}">
  <label class="field roll-search"><span class="field-label">Find a member</span><input class="input" type="search" name="q" value="${esc(f.q)}" placeholder="Name" autocomplete="off"></label>
  <div class="roll-selects">
    <label class="field"><span class="field-label">Position</span><select class="input" name="position">${opt("", "Any", f.position)}${POSITIONS.map((p) => opt(p, p, f.position)).join("")}</select></label>
    <label class="field"><span class="field-label">Party</span><select class="input" name="party">${opt("", "Any", f.party)}${parties.map((p) => opt(p, p, f.party)).join("")}</select></label>
    ${federal ? `<label class="field"><span class="field-label">State</span><select class="input" name="state">${opt("", "Any", f.state)}${states.map((s) => opt(s, s, f.state)).join("")}</select></label>` : ""}
  </div>
  <noscript><button class="btn" type="submit">Filter</button></noscript>
</form>`;
}

/** The list and its "Load more" (app.js appends the next page in place). */
export function rollCallList(billId, v, f, page) {
  const more = page.more ? `<a class="btn btn--block load-more" href="${esc(rollCallHref(billId, v.id, f, (f.offset || 0) + ROLL_PER_PAGE))}" data-load-more="rollcall-list">Load more</a>` : "";
  const filtered = f.q || f.position || f.party || f.state;
  return `<p class="small secondary" data-rollcall-count>${page.total} ${page.total === 1 ? "member" : "members"}${filtered ? (page.total === 1 ? " matches" : " match") : ""}${page.total ? `, by last name${f.offset ? `, from number ${f.offset + 1}` : ""}` : ""}.</p>
  <div class="card roll-list" id="rollcall-list">${page.rows.map(rollCallRow).join("") || '<p class="small secondary cr-empty">No members match.</p>'}</div>
  <div data-rollcall-more>${more}</div>`;
}

/** The selected vote's heading: what was asked, the result, the date, and the official record. */
export function voteHeading(v) {
  return `<div class="stack-xs">
  <p class="label">${esc(CHAMBER_NAME[v.chamber] || "")} · ${fmtDate(v.vote_date)} · ${esc(TYPE_LABELS[v.vote_type] || "Other")}</p>
  <p class="vote-question">${esc(v.question)} · <strong>${esc(v.result)}</strong></p>
  ${sourceLink(v.source_url, "Official record")}
</div>`;
}
