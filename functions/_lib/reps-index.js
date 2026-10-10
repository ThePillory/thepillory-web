// The Reps tab (/reps/), the same layout for every state:
//   Your representatives  with saved districts, everyone who represents them
//                         (President to county); with only a state known, that
//                         state's statewide officials and the lookup; else the lookup
//   Search                any official, justice or candidate by name (people-search.js)
//   Browse                Federal / State / Courts, one compact line per person,
//                         by last name (or district), 25 at a time with "Load more"
// Quick mode keeps "Your representatives" and Search; Browse is one tap away.
// Lists are paged in SQL: no request reads every official.
import { esc, linkRow } from "./render.js";
import { STATE_NAME } from "./districts.js";
import { chamberIds, chamberName } from "../../workers/sync/src/states.js";

export const PER_PAGE = 25;
export const BROWSE = { federal: "Federal", state: "State", courts: "Courts" };

const ORDER = {
  name: "o.last_name COLLATE NOCASE, o.name COLLATE NOCASE",
  district: "o.state, CAST(o.district_code AS INTEGER), o.district_code, o.district, o.last_name COLLATE NOCASE",
};

/** One page of a chamber's current members: {rows, more}. `state` narrows Congress to one state. */
export async function chamberPage(db, { chamber, state = null, sort = "name", offset = 0 }) {
  const { results } = await db
    .prepare(
      `SELECT o.slug, o.name, o.office, o.district, o.party, o.state, o.chamber FROM officials o
       WHERE o.active = 1 AND o.chamber = ? AND (? IS NULL OR o.state = ?)
       ORDER BY ${ORDER[sort] || ORDER.name} LIMIT ? OFFSET ?`
    )
    .bind(chamber, state, state, PER_PAGE + 1, offset)
    .all();
  return { rows: results.slice(0, PER_PAGE), more: results.length > PER_PAGE };
}

/** One person, one compact line: name, then office or district, and party as plain text. */
export function personRow(o, { office = false } = {}) {
  const meta = [office ? o.office : null, o.district, o.party ? `Party: ${o.party}` : null].filter(Boolean).join(" · ");
  return linkRow(`/reps/${o.slug}/`, o.name, meta);
}

/** A row in "Your representatives": name, office, district. */
export const yourRow = (o) => linkRow(`/reps/${o.slug}/`, o.name, [o.office, o.district].filter(Boolean).join(" · "));

export const isGovernor = (o) => /^governor$/i.test(String(o.office || "")) || o.rank === 1;

/**
 * Everyone in "Your representatives", in order: the President and Vice
 * President, the U.S. Senators, the House member, the Governor, the state
 * legislators, then county officials. `reps`: officialsWhere(repsWhere(d)).
 */
export function yourList({ federalExec = [], reps = [], stateExec = [] }) {
  const pv = federalExec.filter((o) => o.rank === 1 || o.rank === 2).sort((a, b) => a.rank - b.rank);
  const gov = stateExec.find(isGovernor);
  const by = (pred) => reps.filter(pred);
  return [
    ...pv,
    ...by((o) => o.chamber === "us-senate"),
    ...by((o) => o.chamber === "us-house"),
    ...(gov ? [gov] : []),
    ...by((o) => !/^us-|county-board/.test(o.chamber) && /-(upper|senate|legislature)$/.test(o.chamber)),
    ...by((o) => !/^us-|county-board/.test(o.chamber) && /-(lower|assembly)$/.test(o.chamber)),
    ...by((o) => o.chamber === "county-board"),
  ];
}

/** The statewide list before an address: the President and Vice President, both senators, the Governor. */
export function statewideList({ federalExec = [], senators = [], stateExec = [] }) {
  return yourList({ federalExec, reps: senators, stateExec });
}

/** Where a browse link goes; only what's set is kept. */
export function repsHref({ browse, state, chamber, sort, offset } = {}) {
  const p = new URLSearchParams();
  if (browse) p.set("browse", browse);
  if (state) p.set("state", state);
  if (chamber) p.set("chamber", chamber);
  if (sort && sort !== "name") p.set("sort", sort);
  if (offset) p.set("offset", String(offset));
  const q = p.toString();
  return `/reps/${q ? `?${q}` : ""}`;
}

/** The chambers a State view lists, with each state's own names ("Assembly", "House of Delegates"). */
export function stateChambers(st) {
  const ids = chamberIds(st);
  const name = STATE_NAME[st] || st;
  return [
    ids.upper ? { id: ids.upper, name: chamberName(st, ids.upper.endsWith("-legislature") ? "legislature" : "upper", name) } : null,
    ids.lower ? { id: ids.lower, name: chamberName(st, "lower", name) } : null,
  ].filter(Boolean);
}

/** A state picker that submits on change (a button without JavaScript). */
export function statePicker({ browse, state, all = false, label = "State" }) {
  const options = Object.entries(STATE_NAME)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === state ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
  return `<form class="browse-filter" method="get" action="/reps/">
  <input type="hidden" name="browse" value="${esc(browse)}" />
  <label class="label" for="browse-state-${esc(browse)}">${esc(label)}</label>
  <div class="lookup-row">
    <select class="input" id="browse-state-${esc(browse)}" name="state" data-autosubmit>${all ? `<option value=""${state ? "" : " selected"}>All states</option>` : ""}${options}</select>
    <noscript><button class="btn" type="submit">Show</button></noscript>
  </div>
</form>`;
}

/** Name / District order for a legislature's list. */
export function sortSwitch(base, sort) {
  const opt = (k, label) => `<a class="toggle" href="${esc(repsHref({ ...base, sort: k }))}#${esc(base.anchor)}"${k === sort ? ' aria-current="true"' : ""}>${label}</a>`;
  return `<nav class="segmented sort-switch" aria-label="Order">${opt("name", "By last name")}${opt("district", "By district")}</nav>`;
}

/** A paged list: its rows, then "Load more" (app.js appends the next page in place). */
export function pagedList({ id, page, href, empty = "None loaded yet.", row = personRow }) {
  const more = page.more ? `<a class="btn btn--block load-more" href="${esc(href)}" data-load-more="${esc(id)}">Load more</a>` : "";
  return `<div class="card people-list" id="${esc(id)}">${page.rows.map((o) => row(o)).join("") || `<p class="secondary small">${esc(empty)}</p>`}</div>${more}`;
}
