// Money from government to organizations, and outside contacts and travel,
// shown beside funding and lobbying as facts, never as cause or payoff (see
// docs/funding.md). Loaded weekly by tools/load_gov_money.py (migration 0031):
// earmarks on members' More tab and appropriations bill pages, privately paid
// travel and foreign agents' reported contacts on the More tab. Nothing here
// connects one fact to another in words: no "in return", "after", "because".
import { esc, safeUrl, fmtDate } from "./render.js";

export const HOW = "/about/methodology/#government-money";
const money = (n) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;
const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;
const out = (href, text) => (safeUrl(href) ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener">${text}</a>` : text);
const dates = (a, b) => (!a ? "" : a === b || !b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);

export const SUBCOMMITTEE = {
  agriculture: "Agriculture",
  cjs: "Commerce, Justice, Science",
  defense: "Defense",
  "energy-water": "Energy and Water",
  fsgg: "Financial Services and General Government",
  homeland: "Homeland Security",
  interior: "Interior and Environment",
  lhhs: "Labor, Health and Human Services, Education",
  legislative: "Legislative Branch",
  "milcon-va": "Military Construction and Veterans Affairs",
  sfops: "State and Foreign Operations",
  thud: "Transportation, Housing and Urban Development",
};
const subName = (s) => SUBCOMMITTEE[s] || s || "";
const STAGE = { enacted: "Enacted", house_committee: "In the House committee's bill" };

/** "Federal awards" for an organization by name: its contracts and grants from USAspending.gov. */
export function awardsLink(name) {
  const n = String(name || "").trim();
  if (n.length < 3) return "";
  return ` <a class="tap small awards-link" href="/awards/?name=${encodeURIComponent(n)}">Federal awards</a>`;
}

// ---------------------------------------------------------------------------
// An appropriations bill's fiscal year and subcommittee, from its title

const TITLE_SUBS = [
  ["agriculture", /agricultur/i],
  ["cjs", /commerce,? justice/i],
  ["defense", /^department of defense appropriations|^defense appropriations/i],
  ["energy-water", /energy and water/i],
  ["fsgg", /financial services and general government/i],
  ["homeland", /homeland security appropriations/i],
  ["interior", /interior,? environment/i],
  ["lhhs", /labor,? health and human services/i],
  ["legislative", /legislative branch appropriations/i],
  ["milcon-va", /military construction/i],
  ["sfops", /state,? foreign operations|national security, department of state/i],
  ["thud", /transportation,? (and )?housing and urban development/i],
];

/**
 * {fy, subcommittees, consolidated} for an appropriations act's title
 * ("…Appropriations Act, 2026"), or null. A single bill names its
 * subcommittee; a consolidated or minibus act may name several, or none.
 */
export function appropriationsOf(title) {
  const t = String(title || "");
  const m = /appropriations act,? (\d{4})\b/i.exec(t);
  if (!m) return null;
  const fy = Number(m[1]);
  const subs = TITLE_SUBS.filter(([, rx]) => rx.test(t)).map(([k]) => k);
  const consolidated = /consolidated|continuing|minibus|omnibus|further/i.test(t) || subs.length > 1;
  return { fy, subcommittees: subs, consolidated };
}

// ---------------------------------------------------------------------------
// Data

/** A member's earmarks, privately paid travel and reported foreign agents' contacts. Null before the tables exist. */
export async function memberGovMoney(db, officialId) {
  try {
    const [rows, requests, tables, travel, fara] = await Promise.all([
      db.prepare(`SELECT e.*, r.chamber AS as_chamber, (SELECT COUNT(*) FROM earmark_requesters x WHERE x.earmark_id = e.id) AS n_req
                  FROM earmark_requesters r JOIN earmarks e ON e.id = r.earmark_id
                  WHERE r.official_id = ? ORDER BY e.fy DESC, e.amount DESC LIMIT 400`).bind(officialId).all(),
      db.prepare(`SELECT q.*, e.amount AS enacted_amount, e.stage AS enacted_stage FROM earmark_requests q LEFT JOIN earmarks e ON e.id = q.enacted_id
                  WHERE q.official_id = ? ORDER BY q.fy DESC, q.amount_requested DESC LIMIT 400`).bind(officialId).all(),
      db.prepare("SELECT source_url, fy, stage, subcommittee, status, rows, note FROM earmark_tables ORDER BY fy DESC, subcommittee").all(),
      db.prepare("SELECT * FROM gift_travel WHERE official_id = ? ORDER BY start_date DESC LIMIT 200").bind(officialId).all(),
      db.prepare(`SELECT c.*, g.name AS registrant FROM fara_contacts c LEFT JOIN fara_registrants g ON g.registration_number = c.registration_number
                  WHERE c.official_id = ? ORDER BY c.contact_date DESC LIMIT 200`).bind(officialId).all(),
    ]);
    return { rows: rows.results, requests: requests.results, tables: tables.results, travel: travel.results, fara: fara.results };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** The earmarks in one fiscal year's tables for these subcommittees, largest first, 50 at a time. */
export async function billEarmarks(db, { fy, subcommittees, state = null, offset = 0, limit = 50 }) {
  try {
    const tables = (await db.prepare("SELECT source_url, fy, stage, subcommittee, status, rows, note FROM earmark_tables WHERE fy = ? ORDER BY subcommittee").bind(fy).all()).results
      .filter((t) => !subcommittees.length || subcommittees.includes(t.subcommittee) || (t.stage === "house_committee" && !t.subcommittee));
    if (!tables.length) return { tables, rows: [], total: null, more: false, states: [] };
    const where = [`fy = ?`];
    const args = [fy];
    if (subcommittees.length) {
      where.push(`subcommittee IN (${subcommittees.map(() => "?").join(",")})`);
      args.push(...subcommittees);
    }
    const base = where.join(" AND ");
    const [total, states, list] = await Promise.all([
      db.prepare(`SELECT stage, COUNT(*) AS n, SUM(amount) AS amount FROM earmarks WHERE ${base} GROUP BY stage`).bind(...args).all(),
      db.prepare(`SELECT state, COUNT(*) AS n FROM earmarks WHERE ${base} AND state IS NOT NULL GROUP BY state ORDER BY state`).bind(...args).all(),
      db.prepare(`SELECT e.*, (SELECT group_concat(name || '|' || chamber || '|' || IFNULL(official_id, ''), ';') FROM earmark_requesters r WHERE r.earmark_id = e.id) AS who
                  FROM earmarks e WHERE ${base}${state ? " AND state = ?" : ""} ORDER BY amount DESC, project LIMIT ? OFFSET ?`)
        .bind(...args, ...(state ? [state] : []), limit + 1, offset).all(),
    ]);
    return { tables, totals: total.results, states: states.results, rows: list.results.slice(0, limit), more: list.results.length > limit };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** Officials' slugs and names for requester links: {official_id: {slug, name}}. */
export async function officialNames(db, ids) {
  const u = [...new Set(ids.filter(Boolean))];
  const outMap = {};
  for (let i = 0; i < u.length; i += 90) {
    const part = u.slice(i, i + 90);
    for (const r of (await db.prepare(`SELECT id, slug, name FROM officials WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all()).results) outMap[r.id] = r;
  }
  return outMap;
}

// ---------------------------------------------------------------------------
// Member: earmarks

const EARMARKS_NOTE = `Earmarks are Community Project Funding (House) and Congressionally Directed Spending (Senate): money in an appropriations bill for a named project, requested by a member of Congress.`;

/** The tables a fiscal year's figures come from, as links. */
function tableLinks(tables) {
  return tables
    .map((t) => `${out(t.source_url, `FY${t.fy} ${esc(t.stage === "enacted" ? subName(t.subcommittee) : "House committee table")} ↗`)}${t.status === "link" ? " (not read: see the table)" : ""}`)
    .join(" · ");
}

export function earmarksSection(o, g) {
  if (!g) return '<p class="secondary small">Earmarks haven\'t been loaded yet.</p>';
  const house = o.chamber === "us-house";
  const fys = [...new Set([...g.rows.map((r) => r.fy), ...g.requests.map((q) => q.fy)])].sort((a, b) => b - a);
  const tablesFor = (fy) => g.tables.filter((t) => t.fy === fy);
  const enactedRead = (fy) => tablesFor(fy).some((t) => t.stage === "enacted" && t.status === "read");
  const committeeRead = (fy) => tablesFor(fy).some((t) => t.stage === "house_committee" && t.status === "read");
  if (!fys.length) {
    return `<p class="secondary small">No earmarks with ${esc(o.name)} as a requester in the tables ThePillory reads.</p>
<p class="hint">${EARMARKS_NOTE} <a class="tap" href="${HOW}">How this works</a></p>`;
  }
  const groups = fys.map((fy, i) => {
    const rows = g.rows.filter((r) => r.fy === fy);
    const reqs = g.requests.filter((q) => q.fy === fy);
    const tiedTo = new Map(reqs.filter((q) => q.enacted_id).map((q) => [q.enacted_id, q]));
    const items = [];
    for (const r of rows.slice(0, 40)) {
      const q = tiedTo.get(r.id);
      const meta = [
        `${STAGE[r.stage] || r.stage}, FY${r.fy} ${esc(subName(r.subcommittee))}`,
        q ? `requested ${money(q.amount_requested)}` : "",
        r.n_req > 1 ? `${plural(r.n_req - 1, "other requester")}` : "",
        r.state ? esc(r.state) : "",
      ].filter(Boolean).join(" · ");
      const who = r.recipient ? `${esc(r.recipient)}${awardsLink(r.recipient)}` : "";
      items.push(row(`${esc(r.project)}${who ? `<div class="small">${who}</div>` : ""}`, money(r.amount), meta));
    }
    const loose = reqs.filter((q) => !q.enacted_id || !rows.some((r) => r.id === q.enacted_id));
    const status = enactedRead(fy)
      ? `not matched to one row in the FY${fy} enacted tables`
      : committeeRead(fy)
        ? `not matched to one row in the House committee's FY${fy} table`
        : `the enacted tables for FY${fy} aren't loaded`;
    for (const q of loose.slice(0, 40)) {
      const who = q.recipient ? `${esc(q.recipient)}${awardsLink(q.recipient)}` : "";
      items.push(row(`${esc(q.project || q.recipient || "Project")}${who && q.project ? `<div class="small">${who}</div>` : ""}`, money(q.amount_requested),
        `Requested${q.subcommittee ? `, ${esc(subName(q.subcommittee))}` : ""} · ${status}${q.member_url ? ` · ${out(q.member_url, "The member's list ↗")}` : ""}`));
    }
    const enactedTotal = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const requestedTotal = reqs.reduce((s, q) => s + (q.amount_requested || 0), 0);
    const line = [
      rows.length ? `${plural(rows.length, "project")} in the tables, ${money(enactedTotal)}` : "",
      reqs.length ? `${plural(reqs.length, "request")}, ${money(requestedTotal)} requested` : "",
    ].filter(Boolean).join(" · ");
    const shown = Math.min(rows.length, 40) + Math.min(loose.length, 40);
    const all = rows.length + loose.length;
    return `<details class="weigh-details"${i === 0 ? " open" : ""}><summary>Fiscal year ${fy} · ${line}</summary>
  <ul class="plain-list money-list">${items.join("")}</ul>
  ${all > shown ? `<p class="small secondary">Showing ${shown} of ${all}. The full list is in the tables below.</p>` : ""}
  ${tablesFor(fy).length ? `<p class="hint">Tables: ${tableLinks(tablesFor(fy))}</p>` : ""}
</details>`;
  });
  return `<div class="stack-sm">
  ${groups.join("")}
  <p class="hint">${EARMARKS_NOTE} Amounts in the tables are as each table lists them: "Enacted" from the Senate Appropriations Committee's table for the enacted law, which lists both chambers' projects; "In the House committee's bill" from the House committee's table of its bills. ${house ? "Amounts requested are from the House Appropriations Committee's tables of members' requests; a request is tied to a table row only when the same member and the same recipient match exactly one row." : "Senators post their requests on their own websites, not in one table, so a senator's amounts here are the tables' amounts."} Where several members asked for the same project, the whole amount is shown for each of them. <a class="tap" href="${HOW}">How this works</a></p>
</div>`;
}

// ---------------------------------------------------------------------------
// Member: privately paid travel

export function travelSection(o, g) {
  if (!g) return '<p class="secondary small">Privately paid travel hasn\'t been loaded yet.</p>';
  const senate = o.chamber === "us-senate";
  const note = `Trips paid for by an outside organization rather than with public money, which members and their staff must disclose${senate ? " to the Secretary of the Senate" : " to the Clerk of the House, with the Ethics Committee's approval beforehand"}. Since 2023. Staff aren't named.${senate ? " The Senate's reports are scanned forms: the sponsor and destination are on each report." : ""} <a class="tap" href="${HOW}">How this works</a>`;
  if (!g.travel.length) return `<p class="secondary small">No privately paid trips disclosed for ${esc(o.name)} or their staff since 2023.</p><p class="hint">${note}</p>`;
  const items = g.travel.slice(0, 50).map((t) => {
    const title = t.sponsor ? esc(t.sponsor) : "Sponsor on the report";
    const meta = [t.traveler === "member" ? esc(o.name) : "A staff member", t.destination ? esc(t.destination) : "", dates(t.start_date, t.end_date)].filter(Boolean).join(" · ");
    return row(title, out(t.source_url, "Report ↗"), meta);
  });
  const mine = g.travel.filter((t) => t.traveler === "member").length;
  return `<div class="stack-sm">
  <p class="small">${plural(g.travel.length, "trip")} disclosed since 2023: ${mine} by ${esc(o.name)}, ${g.travel.length - mine} by staff.</p>
  <ul class="plain-list money-list">${items.join("")}</ul>
  ${g.travel.length > 50 ? `<p class="small secondary">Showing the 50 newest of ${g.travel.length}.</p>` : ""}
  <p class="hint">${note}</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Member: foreign agents' reported contacts

export function faraSection(o, g) {
  if (!g) return '<p class="secondary small">Foreign agents\' filings haven\'t been loaded yet.</p>';
  const note = `Registered foreign agents report their political activities to the Justice Department under the Foreign Agents Registration Act (FARA), including contacts with members of Congress and their offices. Read from statements filed since 2025 that have a text layer; scanned statements stay links. A reported contact is the agent's account of reaching out: it doesn't say what the member did or thought. Staff contacted aren't named. <a class="tap" href="/foreign-agents/">Foreign agents</a> · <a class="tap" href="${HOW}">How this works</a>`;
  if (!g.fara.length) return `<p class="secondary small">No contacts with ${esc(o.name)} or their office in the foreign agents' statements read so far.</p><p class="hint">${note}</p>`;
  const items = g.fara.slice(0, 50).map((c) => {
    const reg = `<a class="inline-link" href="/foreign-agents/${c.registration_number}/">${esc(c.registrant || `Registration ${c.registration_number}`)}</a>`;
    const meta = [c.principal ? `for ${esc(c.principal)}` : "", c.contact_kind === "member" ? `with ${esc(o.name)}` : "with the member's office", c.method ? esc(c.method) : "", fmtDate(c.contact_date)]
      .filter(Boolean).join(" · ");
    return row(reg, out(c.doc_url, "Statement ↗"), meta);
  });
  return `<div class="stack-sm">
  <ul class="plain-list money-list">${items.join("")}</ul>
  ${g.fara.length > 50 ? `<p class="small secondary">Showing the 50 newest of ${g.fara.length}.</p>` : ""}
  <p class="hint">${note}</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Bill pages: the earmarks in an appropriations act

const whoList = (who, names) =>
  String(who || "")
    .split(";")
    .filter(Boolean)
    .map((w) => {
      const [name, chamber, id] = w.split("|");
      const o = id && names[id];
      const label = `${esc(name)} (${chamber === "senate" ? "Senate" : "House"})`;
      return o ? `<a class="inline-link" href="/reps/${esc(o.slug)}/">${label}</a>` : label;
    })
    .join(", ");

export function earmarkRows(rows, names) {
  return rows
    .map((r) => {
      const who = r.recipient ? `<div class="small">${esc(r.recipient)}${awardsLink(r.recipient)}</div>` : "";
      const meta = [r.state ? esc(r.state) : "", esc(subName(r.subcommittee)), r.who ? `Requested by ${whoList(r.who, names)}` : ""].filter(Boolean).join(" · ");
      return row(`${esc(r.project)}${who}`, money(r.amount), meta);
    })
    .join("");
}

/** The fold on an appropriations bill's page. */
export function billEarmarksSection(b, ap, data, names) {
  if (!ap) return "";
  const subs = ap.subcommittees.length ? ap.subcommittees.map(subName).join("; ") : "every subcommittee";
  if (!data || !data.tables.length) {
    return `<p class="secondary small">No earmark tables for fiscal year ${ap.fy} are loaded yet.</p><p class="hint">${EARMARKS_NOTE} <a class="tap" href="${HOW}">How this works</a></p>`;
  }
  const n = (data.totals || []).reduce((s, t) => s + t.n, 0);
  const amt = (data.totals || []).reduce((s, t) => s + (t.amount || 0), 0);
  const stages = [...new Set((data.totals || []).map((t) => t.stage))];
  const what = stages.length === 1 && stages[0] === "house_committee" ? `in the House Appropriations Committee's FY${ap.fy} bills` : `in the enacted FY${ap.fy} appropriations`;
  const scope = ap.consolidated
    ? `<p class="small">This act's title covers ${ap.subcommittees.length ? esc(subs) : "several appropriations bills"}. The Appropriations Committees' tables list each fiscal year's projects by subcommittee; which divisions of this act carry which projects is set out in the act and its explanatory statement, so the projects below are the tables' list${ap.subcommittees.length ? " for those subcommittees" : " for the year"}, not a reading of this act's text.</p>`
    : `<p class="small">The projects below are from the committees' table for the FY${ap.fy} ${esc(subs)} appropriations${stages.includes("enacted") ? " as enacted" : ""}; a version of this bill that didn't become law may have listed different ones.</p>`;
  const links = `/laws/bills/${encodeURIComponent(b.id)}/earmarks/`;
  return `<div class="stack-sm">
  <p class="small"><strong>${plural(n, "project")}, ${money(amt)}</strong>, ${what} (${esc(subs)}), as the committees' tables list them.</p>
  ${scope}
  <ul class="plain-list money-list">${earmarkRows(data.rows.slice(0, 10), names)}</ul>
  ${n > 10 ? `<p><a class="tap" href="${links}">All ${plural(n, "project")}, by state</a></p>` : ""}
  <p class="hint">Tables: ${tableLinks(data.tables)}. ${EARMARKS_NOTE} Largest first. <a class="tap" href="${HOW}">How this works</a></p>
</div>`;
}
