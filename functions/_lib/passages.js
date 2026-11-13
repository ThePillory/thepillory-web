// What is on record for a bill passed without a recorded vote (docs/data-sync.md, "Passage without a
// recorded vote"): the passage itself in one plain line, and, each in its own labeled section and
// never combined into a "position": the recorded votes taken on the bill and on the rule that brought
// it to the floor, committee votes stated in a committee report, cosponsors, discharge petition
// signatures and related bills. Loaded by key (one bill's rows), never from whole tables.
import { esc, fmtDate, safeUrl, sourceLink } from "./render.js";
import { CHAMBER_NAME } from "./data.js";
import { passageLine, METHOD_SHORT, NOT_RECORDED, relationWords } from "../../workers/sync/src/passages/parse.js";

export { passageLine, NOT_RECORDED };
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const soft = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (missing(err)) return fallback;
    throw err;
  }
};
const ph = (n) => Array.from({ length: n }, () => "?").join(",");
const billHref = (id) => `/laws/bills/${encodeURIComponent(id)}/`;
const ruleLabel = (id) => {
  const m = /^us-(\d+)-hres-(\d+)$/.exec(id || "");
  return m ? `H.Res. ${m[2]}` : id;
};

/**
 * One bill's record beyond its own votes: {passages, ruleVotes, committee, cosponsors, petitions, related}.
 * `repIds`: the visitor's officials, for their positions on the rule votes.
 */
export async function onRecordFor(db, billId, repIds = []) {
  if (!db) return null;
  const all = async (sql, binds) => soft(async () => (await db.prepare(sql).bind(...binds).all()).results || [], []);
  const [passages, rules, committee, cosponsors, related, petitions] = await Promise.all([
    all("SELECT * FROM bill_passages WHERE bill_id = ? ORDER BY action_date, chamber", [billId]),
    all("SELECT rule_id FROM bill_rules WHERE bill_id = ? ORDER BY rule_id", [billId]),
    all("SELECT * FROM committee_votes WHERE bill_id = ? ORDER BY vote_date, report", [billId]),
    all(
      `SELECT c.*, o.slug, o.id AS official_id, o.name AS official_name FROM bill_cosponsors c
       LEFT JOIN officials o ON o.bioguide_id = c.bioguide_id AND o.level = 'federal'
       WHERE c.bill_id = ? ORDER BY c.signed_on, c.name`,
      [billId]
    ),
    all("SELECT * FROM bill_related WHERE bill_id = ? ORDER BY relationship, related_id", [billId]),
    all("SELECT * FROM discharge_petitions WHERE bill_id = ? ORDER BY number", [billId]),
  ]);
  // The rules' recorded votes (each rule's own votes, by its key) and the visitor's officials' positions:
  // the rules the bill's actions name, and the rule a discharge petition would discharge.
  const ruleIds = [...new Set([...rules.map((r) => r.rule_id), ...petitions.map((p) => p.rule_id).filter((r) => r && r !== billId)])];
  const ruleVotes = ruleIds.length ? await all(`SELECT * FROM votes WHERE bill_id IN (${ph(ruleIds.length)}) ORDER BY vote_date, id`, ruleIds) : [];
  for (const v of ruleVotes) v.positions = [];
  if (ruleVotes.length && repIds.length) {
    const pos = await all(
      `SELECT p.vote_id, p.position, p.raw_position, o.slug, o.name FROM all_positions p JOIN officials o ON o.id = p.official_id
       WHERE p.vote_id IN (${ph(ruleVotes.length)}) AND p.official_id IN (${ph(repIds.length)})`,
      [...ruleVotes.map((v) => v.id), ...repIds]
    );
    for (const v of ruleVotes) v.positions = pos.filter((p) => p.vote_id === v.id);
  }
  for (const p of petitions) {
    p.signatures = await all(
      `SELECT s.*, o.slug, o.name AS official_name FROM discharge_signatures s LEFT JOIN officials o ON o.id = s.official_id
       WHERE s.petition_id = ? ORDER BY s.signed_on, s.name`,
      [p.id]
    );
  }
  // Which related bills have a page here (a key lookup each).
  const relIds = related.map((r) => r.related_id);
  const have = new Set(relIds.length ? (await all(`SELECT id FROM bills WHERE id IN (${ph(relIds.length)})`, relIds)).map((r) => r.id) : []);
  return { passages, ruleVotes, committee, cosponsors, related, petitions, have };
}

/** The passage line(s) under the bill's status: one per chamber that passed it without a recorded vote. */
export function passageLines(rec) {
  const ps = (rec && rec.passages) || [];
  if (!ps.length) return "";
  return `<div class="stack-xs passage-lines">${ps.map((p) => `<p class="small">${esc(passageLine(p, fmtDate))} ${sourceLink(p.source_url, "Congress.gov")}</p>`).join("")}</div>`;
}

/** What a recorded vote was a vote on, in plain words, before its exact question. Pure. */
export function voteOn(v, { rule = null } = {}) {
  const q = String(v.question || "");
  if (rule) {
    if (/discharge/i.test(q)) return `Discharging the Rules Committee from the rule for this bill (${ruleLabel(rule)})`;
    if (/previous question/i.test(q)) return `Ending debate on the rule for this bill (${ruleLabel(rule)})`;
    if (/agreeing to the resolution/i.test(q)) return `Adopting the rule for this bill (${ruleLabel(rule)})`;
    return `On the rule for this bill (${ruleLabel(rule)})`;
  }
  if (/recommit/i.test(q)) return "Sending the bill back to committee (motion to recommit)";
  if (/motion to table|to lay on the table/i.test(q)) return "Setting a motion aside (motion to table)";
  if (/cloture/i.test(q)) return "Ending debate (cloture)";
  if (/amendment/i.test(q)) return "An amendment";
  if (/motion to proceed/i.test(q)) return "Taking up the bill (motion to proceed)";
  if (/suspend the rules/i.test(q)) return "Passing the bill under suspension of the rules";
  if (/discharge/i.test(q)) return "Discharging the committee (bringing the bill to the floor)";
  return "A recorded vote on this bill";
}

const tally = (v) => [v.yea != null ? `${v.yea} yes` : "", v.nay != null ? `${v.nay} no` : "", v.present ? `${v.present} present` : "", v.not_voting ? `${v.not_voting} not voting` : ""].filter(Boolean).join(", ");

/**
 * "Recorded votes on this bill": every recorded vote other than final passage, on the bill itself and on the
 * rule that brought it to the floor, each labeled with what it was a vote on and its exact question, linked
 * to every member's position. `own`: the bill's own votes (votesOnBill). Empty string when there are none.
 */
export function recordedVotesSection(billId, own, rec) {
  const items = [
    ...(own || []).filter((v) => v.vote_type !== "final_passage").map((v) => ({ v, rule: null, href: `${billHref(billId)}?vote=${encodeURIComponent(v.id)}#votes` })),
    ...((rec && rec.ruleVotes) || []).map((v) => ({ v, rule: v.bill_id, href: `${billHref(v.bill_id)}?vote=${encodeURIComponent(v.id)}#votes` })),
  ].sort((a, b) => String(a.v.vote_date).localeCompare(String(b.v.vote_date)) || String(a.v.id).localeCompare(String(b.v.id)));
  if (!items.length) return "";
  return `<ul class="plain-list stack-sm">${items
    .map(({ v, rule, href }) => `<li class="stack-xs">
    <p class="list-title">${esc(voteOn(v, { rule }))}</p>
    <p class="small">${esc(CHAMBER_NAME[v.chamber] || "")} · ${fmtDate(v.vote_date)} · Question: “${esc(v.question)}” · ${esc(v.result || "")}${tally(v) ? ` (${esc(tally(v))})` : ""}</p>
    <p class="small"><a class="inline-link" href="${esc(href)}">Every member's position ›</a> ${sourceLink(v.source_url, "Official record")}</p>
  </li>`)
    .join("")}</ul>
  <p class="hint">Recorded votes taken on this bill and on the rule that brought it to the floor, each with its exact question. They are not votes on passing the bill.</p>`;
}

/** "Committee vote on [date]: [question]", each the committee report's own sentence. */
export function committeeSection(rec) {
  const c = (rec && rec.committee) || [];
  if (!c.length) return "";
  return `<ul class="plain-list stack-sm">${c
    .map((x) => `<li class="small">Committee vote on ${fmtDate(x.vote_date)}: “${esc(x.question)}” <span class="secondary">${esc(x.report)}</span> ${sourceLink(x.source_url, "Committee report")}</li>`)
    .join("")}</ul>
  <p class="hint">Quoted from the committee's report. Each member's committee vote, when recorded, is in the report.</p>`;
}

/** "Cosponsors (signed on to the bill; not a vote)": each with the date they signed on. */
export function cosponsorsSection(rec, sourceUrl) {
  const c = (rec && rec.cosponsors) || [];
  if (!c.length) return "";
  const name = (x) => (x.slug ? `<a class="inline-link" href="/reps/${esc(x.slug)}/">${esc(x.official_name || x.name)}</a>` : esc(x.name));
  const active = c.filter((x) => !x.withdrawn_on);
  const withdrawn = c.filter((x) => x.withdrawn_on);
  return `<p class="small">${active.length} ${active.length === 1 ? "member" : "members"} signed on${withdrawn.length ? `; ${withdrawn.length} later withdrew` : ""}.</p>
  <ul class="plain-list stack-xs">${active.map((x) => `<li class="small">${name(x)} <span class="secondary">· signed on ${fmtDate(x.signed_on)}${x.original ? " (original cosponsor)" : ""}</span></li>`).join("")}${withdrawn
    .map((x) => `<li class="small">${name(x)} <span class="secondary">· signed on ${fmtDate(x.signed_on)}, withdrew ${fmtDate(x.withdrawn_on)}</span></li>`)
    .join("")}</ul>
  <p class="hint">Signing on to a bill as a cosponsor is not a vote. ${sourceLink(sourceUrl ? `${String(sourceUrl).replace(/\/+$/, "")}/cosponsors` : null, "Congress.gov")}</p>`;
}

/** "Signed the discharge petition to force a vote": each signature with its date, as the Clerk lists it. */
export function petitionSection(rec) {
  const ps = (rec && rec.petitions) || [];
  if (!ps.length) return "";
  return `${ps
    .map((p) => {
      const sig = p.signatures || [];
      return `<div class="stack-xs">
    <p class="small">Discharge Petition No. ${esc(String(p.number))}${p.filed_on ? `, filed ${fmtDate(p.filed_on)}` : ""}${p.rule_id ? ` (to discharge ${esc(ruleLabel(p.rule_id))})` : ""}: ${sig.filter((s) => !s.withdrawn_on).length} signatures.</p>
    <p class="list-title">Signed the discharge petition to force a vote</p>
    <ul class="plain-list stack-xs">${sig
      .map((s) => `<li class="small">${s.slug ? `<a class="inline-link" href="/reps/${esc(s.slug)}/">${esc(s.official_name || s.name)}</a>` : esc(s.name)} <span class="secondary">· signed ${fmtDate(s.signed_on)}${s.withdrawn_on ? `, withdrew ${fmtDate(s.withdrawn_on)}` : ""}</span></li>`)
      .join("")}</ul>
    ${sourceLink(p.source_url, "Office of the Clerk")}
  </div>`;
    })
    .join("")}
  <p class="hint">A discharge petition with 218 signatures lets the House vote on a bill without a committee's or the leadership's go-ahead. Signing it is not a vote on the bill.</p>`;
}

/** Related bills, one plain line each, in Congress.gov's own words. */
export function relatedSection(rec, have = (rec && rec.have) || new Set()) {
  const r = (rec && rec.related) || [];
  if (!r.length) return "";
  return `<ul class="plain-list stack-xs">${r
    .map((x) => `<li class="small">${esc(relationWords(x))}: ${have.has(x.related_id) ? `<a class="inline-link" href="${billHref(x.related_id)}">${esc(x.label)}</a>` : esc(x.label)}${x.title ? `, “${esc(x.title)}”` : ""}</li>`)
    .join("")}</ul>
  <p class="hint">As Congress.gov lists them, with who identified each relationship.</p>`;
}

/**
 * Your reps on a bill passed without a recorded vote in their chamber: "No recorded vote on passage", then
 * what is on record for them, each as its own fact. `finals`/`own`: the bill's votes with the rep's positions.
 * Returns a short HTML fragment, or "" when the rep's chamber has no such passage. Pure.
 */
export function repRecordLine(o, rec, own = []) {
  const passed = ((rec && rec.passages) || []).filter((p) => p.chamber === o.chamber);
  if (!passed.length) return "";
  const facts = [];
  const c = ((rec && rec.cosponsors) || []).find((x) => x.slug === o.slug);
  if (c) facts.push(c.withdrawn_on ? `Cosponsor ${fmtDate(c.signed_on)} to ${fmtDate(c.withdrawn_on)}` : `Cosponsor since ${fmtDate(c.signed_on)}`);
  const votes = [
    ...(own || []).filter((x) => x.vote_type !== "final_passage").map((v) => ({ v, rule: null })),
    ...((rec && rec.ruleVotes) || []).map((v) => ({ v, rule: v.bill_id })),
  ];
  for (const { v, rule } of votes) {
    const p = (v.positions || []).find((x) => x.slug === o.slug);
    if (p) facts.push(`${voteOn(v, { rule })}, ${fmtDate(v.vote_date)}: ${p.position}`);
  }
  for (const pet of (rec && rec.petitions) || []) {
    const s = (pet.signatures || []).find((x) => x.slug === o.slug);
    if (s) facts.push(`Signed Discharge Petition No. ${pet.number} on ${fmtDate(s.signed_on)}${s.withdrawn_on ? ` (withdrew ${fmtDate(s.withdrawn_on)})` : ""}`);
  }
  const m = passed[passed.length - 1];
  return `<span class="xsmall secondary">No recorded vote on passage (${esc(METHOD_SHORT[m.method].toLowerCase())})${facts.length ? ` · ${facts.map(esc).join(" · ")}` : ""}</span>`;
}
