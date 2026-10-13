// Dark money on the Funding tab (members of Congress, the President) and on
// candidates' pages: who gives to the groups that spend for and against a
// candidate, what nonprofits that spend or give file with the IRS, and
// electioneering communications (FEC Form 9). The same rules as all money on
// ThePillory: facts side by side, never cause; organizations by name, never an
// individual; every number with its period and source. See docs/funding.md.
import { esc, safeUrl, fmtDate } from "./render.js";
import { awardsLink } from "./gov-money.js";
import { SUBSECTIONS, irsRecord, fecCommitteePage } from "../../workers/sync/src/funding/darkmoney.js";

// Paused (October 2026) while the labels are checked against their public
// records: no donor labels, "don't disclose" share, Form 990 facts or Form 9
// sections on any page, and nothing is read for them. The data stays in D1;
// set `on` back to true to show it again (tests switch it on to check the pages).
export const darkMoney = { on: false };

// Kept here rather than imported from funding.js, which imports this module.
const HOW = "/about/methodology/#dark-money";
const money = (n) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);
const period = (cycle) => `${cycle - 1}–${cycle}`;
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const ph = (a) => a.map(() => "?").join(",");
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;
const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;
const dates = (a, b) => (!a ? "" : a === b || !b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
const link = (href, text) => (safeUrl(href) ? `<a class="inline-link" href="${esc(href)}" target="_blank" rel="noopener">${text}</a>` : text);
const KIND_LABEL = { committee: "Political committee", llc: "LLC", c4: "501(c)(4)", c6: "501(c)(6)" };

// ---------------------------------------------------------------------------
// Data

/** For these outside spenders and this period: {committee_id: {read, donors, nonprofit}}, and donors' nonprofits by EIN. */
export async function darkMoneyFor(db, committeeIds, cycle) {
  if (!darkMoney.on || !committeeIds.length) return { spenders: {}, nonprofits: {} };
  try {
    const [reads, donors, spenders] = await Promise.all([
      db.prepare(`SELECT * FROM outside_donor_reads WHERE cycle = ? AND committee_id IN (${ph(committeeIds)})`).bind(cycle, ...committeeIds).all(),
      db.prepare(`SELECT * FROM outside_donors WHERE cycle = ? AND committee_id IN (${ph(committeeIds)}) ORDER BY total DESC`).bind(cycle, ...committeeIds).all(),
      db.prepare(`SELECT committee_id, ein FROM fec_committees WHERE ein IS NOT NULL AND committee_id IN (${ph(committeeIds)})`).bind(...committeeIds).all(),
    ]);
    const eins = [...new Set([...spenders.results.map((r) => r.ein), ...donors.results.filter((d) => d.ein).map((d) => d.ein)])];
    const nonprofits = {};
    if (eins.length) {
      for (const n of (await db.prepare(`SELECT * FROM nonprofits WHERE ein IN (${ph(eins)})`).bind(...eins).all()).results) nonprofits[n.ein] = n;
    }
    const out = {};
    for (const id of committeeIds) {
      const read = reads.results.find((r) => r.committee_id === id) || null;
      const sp = spenders.results.find((r) => r.committee_id === id);
      out[id] = { read, donors: donors.results.filter((d) => d.committee_id === id), nonprofit: sp ? nonprofits[sp.ein] || null : null };
    }
    return { spenders: out, nonprofits };
  } catch (err) {
    if (missing(err)) return { spenders: {}, nonprofits: {} };
    throw err;
  }
}

/**
 * Electioneering communications naming these FEC candidate IDs in a two-year
 * period, by spender: [{committee_id, name, total, count, first, last,
 * donations, filings, source_url, nonprofit}]. Null before the tables exist.
 */
export async function electioneeringFor(db, candidateIds, cycle) {
  const ids = (candidateIds || []).filter(Boolean);
  if (!darkMoney.on || !ids.length) return null;
  try {
    const { results } = await db
      .prepare(
        `SELECT e.*, f.donations, c.ein FROM electioneering e
         LEFT JOIN electioneering_filings f ON f.file_number = e.file_number
         LEFT JOIN fec_committees c ON c.committee_id = e.committee_id
         WHERE e.cycle = ? AND e.candidate_id IN (${ph(ids)}) ORDER BY e.distribution_date DESC`
      )
      .bind(cycle, ...ids)
      .all();
    const read = await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(`electioneering_read_${cycle}`).first();
    const by = new Map();
    for (const r of results) {
      const g = by.get(r.committee_id) || { committee_id: r.committee_id, name: r.committee_name, total: 0, count: 0, first: null, last: null, filings: new Map(), source_url: r.source_url, ein: r.ein };
      g.total = Math.round((g.total + r.amount) * 100) / 100;
      g.count += 1;
      const d = r.distribution_date || r.disbursement_date;
      if (d && (!g.first || d < g.first)) g.first = d;
      if (d && (!g.last || d > g.last)) g.last = d;
      if (r.file_number != null) g.filings.set(r.file_number, r.donations);
      by.set(r.committee_id, g);
    }
    const list = [...by.values()].map((g) => {
      const known = [...g.filings.values()].filter((v) => v != null);
      return { ...g, filings: g.filings.size, donations: known.length ? known.reduce((s, v) => s + v, 0) : null };
    });
    const eins = [...new Set(list.map((g) => g.ein).filter(Boolean))];
    const nonprofits = {};
    if (eins.length) for (const n of (await db.prepare(`SELECT * FROM nonprofits WHERE ein IN (${ph(eins)})`).bind(...eins).all()).results) nonprofits[n.ein] = n;
    return { cycle, read: read ? read.value : null, spenders: list.map((g) => ({ ...g, nonprofit: g.ein ? nonprofits[g.ein] || null : null })).sort((a, b) => b.total - a.total) };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering

const NO_DONORS_990 = "A nonprofit's Form 990 doesn't list its donors: the public copy leaves out the names of who gave.";

/** One nonprofit's Form 990, as filed: revenue, total spending, political spending, with its tax year. */
export function nonprofitFacts(n) {
  if (!n) return "";
  const kind = SUBSECTIONS[n.subsection] || "tax-exempt";
  const year = n.tax_year ? `for ${n.tax_year}` : "";
  let political;
  if (n.political_read === "schedule_c") political = `political spending ${n.political != null ? money(n.political) : "not stated"} (Schedule C)`;
  else if (n.political_read === "no_schedule_c") political = "no political spending reported (no Schedule C filed)";
  else political = "political spending not read yet (see the filing)";
  let recipients = [];
  try {
    recipients = n.recipients ? JSON.parse(n.recipients) : [];
  } catch {
    recipients = [];
  }
  const paid = recipients.length
    ? ` Schedule C lists payments to political organizations: ${recipients.slice(0, 4).map((r) => `${esc(r.name)}${r.amount != null ? ` ${money(r.amount)}` : ""}`).join("; ")}${recipients.length > 4 ? `; and ${recipients.length - 4} more` : ""}.`
    : "";
  return `<p class="small">${esc(n.name)} is a ${kind} nonprofit. Its IRS Form 990 ${year}: revenue ${n.revenue != null ? money(n.revenue) : "not stated"}, total spending ${n.expenses != null ? money(n.expenses) : "not stated"}, ${political}.${paid} ${NO_DONORS_990} ${link(n.filing_url || n.source_url, "The filing ↗")} · ${link(irsRecord(n.ein), "IRS record ↗")}</p>`;
}

/** Details under one outside spender: its largest donors that are organizations, or its IRS filing. */
export function spenderDetails(x, dm, cycle) {
  if (!darkMoney.on) return "";
  const s = dm && dm.spenders && dm.spenders[x.committee_id];
  if (!s) return "";
  const parts = [];
  if (s.read && s.donors.length) {
    const donorRow = (d) => {
      const href = d.kind === "committee" ? fecCommitteePage(d.donor_committee_id) : ["c4", "c6"].includes(d.kind) && d.ein ? irsRecord(d.ein) : d.source_url;
      const chip = KIND_LABEL[d.kind] ? ` <span class="chip chip--gray chip--sm">${KIND_LABEL[d.kind]}</span>` : "";
      return row(`${link(href, esc(d.name))}${chip}${d.kind === "committee" ? "" : awardsLink(d.name)}`, money(d.total), `${plural(d.count, "contribution")}${d.first_date ? ` · ${dates(d.first_date, d.last_date)}` : ""}`);
    };
    const pct = s.read.receipts ? Math.round((100 * s.read.dark_total) / s.read.receipts) : null;
    const darkNonprofits = s.donors.filter((d) => ["c4", "c6"].includes(d.kind) && d.ein && dm.nonprofits[d.ein]);
    parts.push(`<p class="label">Largest donors that are organizations · ${period(cycle)}</p>
      <ul class="plain-list money-list">${s.donors.slice(0, 8).map(donorRow).join("")}</ul>
      ${pct != null ? `<p class="small"><strong>${s.read.truncated ? "At least " : ""}${pct}% of this group's reported money came from organizations that don't disclose their own donors.</strong></p>` : ""}
      ${darkNonprofits.map((d) => nonprofitFacts(dm.nonprofits[d.ein])).join("")}
      <p class="hint">From this group's FEC reports (Schedule A), ${period(cycle)}: contributions from organizations, largest first, summed by donor; individuals aren't listed. LLCs are labeled by their name; 501(c)(4) and 501(c)(6) nonprofits by their IRS record, matched by exact name and state. These organizations don't have to say who funds them. Percent of ${money(s.read.receipts)} in total reported receipts. <a class="tap" href="${esc(s.read.source_url)}" target="_blank" rel="noopener">Every receipt at the FEC ↗</a> · <a class="tap" href="${HOW}">How dark money works</a></p>`);
  } else if (s.read) {
    parts.push(`<p class="small secondary">No contributions from organizations in this group's FEC reports for ${period(cycle)}.</p>`);
  }
  if (s.nonprofit) parts.push(nonprofitFacts(s.nonprofit));
  if (!parts.length) return "";
  return `<details class="weigh-details"><summary>Who funds ${esc(x.name)}</summary><div class="stack-xs">${parts.join("")}</div></details>`;
}

/** Electioneering communications (FEC Form 9) naming the candidate, under outside spending. */
export function electioneeringSection(e, name) {
  if (!darkMoney.on || !e) return "";
  const span = period(e.cycle);
  const head = `<h3>Electioneering communications</h3>`;
  if (!e.read) return `<section class="card stack-sm">${head}<p class="secondary small">Electioneering communications (FEC Form 9) haven't been loaded yet.</p></section>`;
  const donorsChip = (g) =>
    g.donations == null
      ? ""
      : g.donations > 0
        ? ` <span class="chip chip--gray chip--sm">Donors listed on Form 9</span>`
        : ` <span class="chip chip--gray chip--sm">No donors reported</span>`;
  const item = (g) =>
    `${row(`${link(g.source_url, esc(g.name))}${donorsChip(g)}`, money(g.total), `${plural(g.count, "ad disbursement")} · aired ${dates(g.first, g.last)}${g.donations > 0 ? ` · ${money(g.donations)} in donations reported for its ads` : ""}`)}${
      g.nonprofit ? `<li class="money-row"><div class="money-name">${nonprofitFacts(g.nonprofit)}</div></li>` : ""
    }`;
  const list = e.spenders.length
    ? `<ul class="plain-list money-list">${e.spenders.map(item).join("")}</ul>`
    : `<p class="secondary small">No electioneering communications naming ${esc(name)} were reported in ${span}.</p>`;
  return `<section class="card stack-sm">
  ${head}
  ${list}
  <p class="hint">Broadcast, cable and satellite ads that name a federal candidate and air within 30 days of a primary or 60 days of a general election, reported to the FEC on Form 9, ${span}. The amount is the share of each ad's cost the filer attributes to ${esc(name)}. These ads don't have to ask for a vote for or against anyone, and ThePillory doesn't say which way they lean. A group lists donors on Form 9 only for money given to pay for these ads; "No donors reported" means its filing lists none. <a class="tap" href="${HOW}">How dark money works</a></p>
</section>`;
}

