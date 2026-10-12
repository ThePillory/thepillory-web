// California lobbying (Cal-Access; tools/load_ca_lobbying.py) for California
// bill pages and each legislator's More tab. The same rules as federal
// lobbying: facts side by side, never cause; organizations by name, lobbyists
// and other people only as counts and totals; every number with its period and
// source; a report "lists" a bill, it never says for or against.
import { esc, safeUrl, fmtDate } from "./render.js";
import { money, METHOD } from "./funding.js";
import { billHref } from "./votes.js";
import { awardsLink } from "./gov-money.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const CAL_ACCESS = "https://cal-access.sos.ca.gov/Lobbying/";
const HOW = METHOD.replace("#funding", "#ca-lobbying");
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;
const ph = (a) => a.map(() => "?").join(",");
const row = (left, right, meta = "") =>
  `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;
const quarter = (start, end) => {
  const s = String(start || "");
  const q = { "01": 1, "04": 2, "07": 3, "10": 4 }[s.slice(5, 7)];
  return q && String(end || "").slice(0, 4) === s.slice(0, 4) ? `Q${q} ${s.slice(0, 4)}` : `${fmtDate(start)} – ${fmtDate(end)}`;
};
const dateSpan = (dates) => {
  const d = dates.filter(Boolean).sort();
  if (!d.length) return "";
  return d[0] === d[d.length - 1] ? fmtDate(d[0]) : `${fmtDate(d[0])} – ${fmtDate(d[d.length - 1])}`;
};
/** The two-year session a bill id belongs to: 'ca-20252026-ab-1' → [2025, 2026]. */
export function sessionYears(billId) {
  const m = /^ca-(\d{4})(\d{4})-/.exec(String(billId || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

async function inChunks(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) out.push(...(await fn(ids.slice(i, i + 90))));
  return out;
}

// ---------------------------------------------------------------------------
// Data

/**
 * Lobbying reports that list a California bill, by employer, and the
 * contributions those employers reported to legislators in the same session.
 * Null before the tables exist.
 */
export async function caLobbyingFor(db, billId) {
  try {
    const years = sessionYears(billId);
    const loaded = await db.prepare("SELECT COUNT(*) AS n FROM ca_lobby_loaded").first();
    const { results } = await db
      .prepare("SELECT r.* FROM ca_bill_lobbying l JOIN ca_lobby_reports r ON r.filing_id = l.filing_id WHERE l.bill_id = ? ORDER BY r.period_end DESC, r.filed_on DESC")
      .bind(billId)
      .all();
    const employers = new Map();
    for (const r of results) {
      const e = employers.get(r.employer_id) || { id: r.employer_id, name: r.employer_name, reports: 0, amount: 0, unreported: 0, latest: r, forms: new Set() };
      e.reports += 1;
      e.forms.add(r.form);
      if (r.amount == null) e.unreported += 1;
      else e.amount += r.amount;
      employers.set(r.employer_id, e);
    }
    const list = [...employers.values()].sort((a, b) => b.amount - a.amount || b.reports - a.reports);
    let givers = [];
    if (list.length && years) {
      const rows = await inChunks(
        list.map((e) => e.id),
        async (part) =>
          (
            await db
              .prepare(
                `SELECT c.filer_id, c.amount, c.date, c.source_url, o.id AS official_id, o.name AS member, o.slug
                 FROM ca_lobby_contributions c
                 JOIN state_campaign_committees k ON k.filer_id = c.recipient_id
                 JOIN officials o ON o.id = k.official_id AND o.active = 1
                 WHERE c.filer_name IS NOT NULL AND c.filer_kind IN ('employer', 'other') AND c.filer_id IN (${ph(part)}) AND c.date BETWEEN ? AND ?`
              )
              .bind(...part, `${years[0]}-01-01`, `${years[1]}-12-31`)
              .all()
          ).results
      );
      const by = new Map();
      for (const r of rows) {
        const g = by.get(r.filer_id) || { employer: employers.get(r.filer_id), total: 0, members: new Map(), latest: r };
        const m = g.members.get(r.official_id) || { member: r.member, slug: r.slug, total: 0, count: 0, dates: [] };
        m.total += r.amount || 0;
        m.count += 1;
        if (r.date) m.dates.push(r.date);
        g.members.set(r.official_id, m);
        g.total += r.amount || 0;
        if (String(r.date || "") > String(g.latest.date || "")) g.latest = r;
        by.set(r.filer_id, g);
      }
      givers = [...by.values()].map((g) => ({ ...g, members: [...g.members.values()].sort((a, b) => b.total - a.total) })).sort((a, b) => b.total - a.total);
    }
    return { loaded: loaded && loaded.n > 0, years, employers: list, reports: results.length, amount: list.reduce((s, e) => s + e.amount, 0), givers };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/**
 * A legislator's Lobbying section: contributions to their campaign committees
 * that lobbying filers reported since 2025, with each named organization's own
 * lobbying reports (payments and the bills listed). Null before the tables exist.
 */
export async function caLobbyingForOfficial(db, officialId) {
  try {
    const loaded = await db.prepare("SELECT COUNT(*) AS n FROM ca_lobby_loaded").first();
    const committees = (await db.prepare("SELECT filer_id FROM state_campaign_committees WHERE official_id = ?").bind(officialId).all()).results.map((r) => r.filer_id);
    const rows = committees.length
      ? (
          await db
            .prepare(`SELECT * FROM ca_lobby_contributions WHERE recipient_id IN (${ph(committees)}) AND date >= '2025-01-01' ORDER BY date DESC`)
            .bind(...committees)
            .all()
        ).results
      : [];
    const orgs = new Map();
    const people = { ids: new Set(), count: 0, total: 0, dates: [] };
    for (const r of rows) {
      if (!r.filer_name) {
        people.ids.add(r.filer_id || `${r.filing_id}:${r.n}`);
        people.count += 1;
        people.total += r.amount || 0;
        people.dates.push(r.date);
        continue;
      }
      const o = orgs.get(r.filer_id) || { id: r.filer_id, name: r.filer_name, kind: r.filer_kind, total: 0, count: 0, dates: [], latest: r };
      o.total += r.amount || 0;
      o.count += 1;
      o.dates.push(r.date);
      orgs.set(r.filer_id, o);
    }
    const list = [...orgs.values()].sort((a, b) => b.total - a.total || b.count - a.count);
    const ids = list.filter((o) => o.kind !== "firm").map((o) => o.id);
    if (ids.length) {
      const reports = await inChunks(ids, async (part) =>
        (await db.prepare(`SELECT employer_id, COUNT(*) AS reports, SUM(amount) AS amount, MIN(period_start) AS first, MAX(period_end) AS last FROM ca_lobby_reports WHERE employer_id IN (${ph(part)}) GROUP BY employer_id`).bind(...part).all()).results
      );
      const bills = await inChunks(ids, async (part) =>
        (
          await db
            .prepare(
              `SELECT r.employer_id, b.id, b.bill_number, MAX(r.period_end) AS last FROM ca_lobby_reports r JOIN ca_bill_lobbying l ON l.filing_id = r.filing_id JOIN bills b ON b.id = l.bill_id
               WHERE r.employer_id IN (${ph(part)}) GROUP BY r.employer_id, b.id ORDER BY last DESC`
            )
            .bind(...part)
            .all()
        ).results
      );
      for (const o of list) {
        o.lobbying = reports.find((r) => r.employer_id === o.id) || null;
        o.bills = bills.filter((b) => b.employer_id === o.id);
      }
    }
    return { loaded: loaded && loaded.n > 0, committees: committees.length, orgs: list, people: { count: people.count, total: people.total, n: people.ids.size, span: dateSpan(people.dates) } };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering

const billLink = (b) => `<a class="inline-link" href="${esc(billHref(b.id))}">${esc(b.bill_number)}</a>`;

/** Follow the money on a California bill page. */
export function caFollowTheMoney(bill, l) {
  if (!l || !l.loaded) {
    return `<p class="secondary small">California lobbying reports (Cal-Access) haven't been loaded yet. They're loaded each week from the Secretary of State's export.</p>`;
  }
  const span = l.years ? `${l.years[0]}–${l.years[1]}` : "this session";
  if (!l.employers.length) {
    return `<p class="secondary small">No lobbying report since 2025 lists ${esc(bill.bill_number)}. Reports are matched by the bill numbers written in them; a report that writes the number another way, or lists bills only in an attachment, can be missed.</p>
      <p class="hint">Source: Cal-Access lobbying reports (Forms 635 and 645), ${span}. <a class="tap" href="${HOW}">How</a></p>`;
  }
  const emp = (e) =>
    row(
      `<a class="inline-link" href="${esc(safeUrl(e.latest.source_url) || CAL_ACCESS)}" target="_blank" rel="noopener">${esc(e.name)}</a>`,
      e.amount ? money(e.amount) : '<span class="secondary">not stated</span>',
      `${plural(e.reports, "quarterly report")} · latest ${quarter(e.latest.period_start, e.latest.period_end)}, filed ${fmtDate(e.latest.filed_on)}`
    );
  const employers = `<p class="small"><strong>${plural(l.employers.length, "organization")}</strong> filed <strong>${plural(l.reports, "lobbying report")}</strong> in ${span} that list ${esc(bill.bill_number)}.</p>
    <ul class="plain-list money-list">${l.employers.slice(0, 12).map(emp).join("")}</ul>
    ${l.employers.length > 12 ? `<details class="weigh-details"><summary>${l.employers.length - 12} more organizations</summary><ul class="plain-list money-list">${l.employers.slice(12).map(emp).join("")}</ul></details>` : ""}
    <p class="hint">Total lobbying payments in these reports: <strong>${money(l.amount)}</strong>. Each amount is everything the organization reported paying for lobbying that quarter (its own lobbyists, lobbying firms, activity expenses and other payments), not only this bill, so it overstates spending on this bill. A report lists the bills the organization lobbied on, in its own words; it doesn't say what position it took. Bills are read from those words by their numbers, and a mention about carrying out an earlier law with the same number is set aside; a report that lists bills only in an attachment can be missed. Each organization links to its latest report. Source: Cal-Access (Forms 635 and 645). <a class="tap" href="${HOW}">How</a></p>`;
  const giver = (g) => {
    const e = g.employer;
    const line = (m) =>
      `<li><a class="inline-link" href="/reps/${esc(m.slug)}/#more-lobbying">${esc(m.member)}</a>: ${money(m.total)} (${plural(m.count, "contribution")}${m.dates.length ? `; ${[...new Set(m.dates)].sort().slice(-3).map(fmtDate).join(", ")}${m.dates.length > 3 ? ", …" : ""}` : ""})</li>`;
    return `<div class="card-inset stack-xs">
      <p class="small"><strong>${esc(e.name)}</strong></p>
      <p class="small"><span class="label">Lobbying</span> ${plural(e.reports, "report")} that list ${esc(bill.bill_number)}; latest ${quarter(e.latest.period_start, e.latest.period_end)}, filed ${fmtDate(e.latest.filed_on)}. <a class="tap" href="${esc(safeUrl(e.latest.source_url) || CAL_ACCESS)}" target="_blank" rel="noopener">Report ↗</a></p>
      <p class="small"><span class="label">Contributions</span> ${money(g.total)} to ${plural(g.members.length, "current legislator")}' campaign committees, ${span}, as the organization reported. <a class="tap" href="${esc(safeUrl(g.latest.source_url) || CAL_ACCESS)}" target="_blank" rel="noopener">Latest report ↗</a></p>
      <ul class="plain-list small">${g.members.slice(0, 5).map(line).join("")}</ul>
      ${g.members.length > 5 ? `<details class="weigh-details"><summary>${g.members.length - 5} more legislators</summary><ul class="plain-list small">${g.members.slice(5).map(line).join("")}</ul></details>` : ""}
    </div>`;
  };
  const givers = l.givers.length
    ? `<h3 class="money-sub">Organizations that lobbied on this bill and also gave to legislators</h3>
       ${l.givers.slice(0, 8).map(giver).join("")}
       ${l.givers.length > 8 ? `<details class="weigh-details"><summary>${l.givers.length - 8} more organizations</summary>${l.givers.slice(8).map(giver).join("")}</details>` : ""}
       <p class="hint">Two separate facts from the same organization's own quarterly reports: the bills it listed, and contributions it made to legislators' campaign committees in the same session. They don't show that one led to the other, what position anyone took, or how anyone voted. Committees are matched to legislators by their Cal-Access committee ID.</p>`
    : "";
  return `${employers}${givers}`;
}

/** The Lobbying section on a California legislator's More tab. */
export function caLegislatorLobbying(official, l) {
  if (!l || !l.loaded) return `<p class="secondary small">California lobbying reports (Cal-Access) haven't been loaded yet. They're loaded each week from the Secretary of State's export.</p>`;
  if (!l.committees) return `<p class="secondary small">No campaign committee is on record for ${esc(official.name)} in the Cal-Access export, so contributions from lobbying organizations can't be matched.</p>`;
  const org = (o) => {
    const lob = o.lobbying;
    const bills = o.bills || [];
    const meta = [
      `${plural(o.count, "contribution")}, ${dateSpan(o.dates)}`,
      o.kind === "firm" ? "a lobbying firm" : "",
      lob ? `its own lobbying reports since 2025: ${money(lob.amount)} in lobbying payments over ${plural(lob.reports, "quarter")}${bills.length ? `, listing ${plural(bills.length, "bill")} on ThePillory, including ${bills.slice(0, 4).map(billLink).join(", ")}` : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return row(`<a class="inline-link" href="${esc(safeUrl(o.latest.source_url) || CAL_ACCESS)}" target="_blank" rel="noopener">${esc(o.name)}</a>${awardsLink(o.name)}`, money(o.total), meta);
  };
  const orgs = l.orgs.length
    ? `<ul class="plain-list money-list">${l.orgs.slice(0, 10).map(org).join("")}</ul>${
        l.orgs.length > 10 ? `<details class="weigh-details"><summary>${l.orgs.length - 10} more organizations</summary><ul class="plain-list money-list">${l.orgs.slice(10).map(org).join("")}</ul></details>` : ""
      }`
    : `<p class="secondary small">No lobbyist employer or lobbying firm reported a contribution to ${esc(official.name)}'s campaign committees since 2025.</p>`;
  const people = l.people.count
    ? `<p class="small">Registered lobbyists and other people reporting on their own: ${plural(l.people.count, "contribution")} from ${plural(l.people.n, "person", "people")}, ${money(l.people.total)}${l.people.span ? `, ${l.people.span}` : ""}. They aren't named.</p>`
    : "";
  return `<section class="card stack-sm">
  <h3>From lobbying organizations</h3>
  ${orgs}
  ${people}
  <p class="hint">Contributions to ${esc(official.name)}'s campaign committees since January 2025, as lobbyist employers (Form 635), lobbying firms (Form 625), organizations spending to influence state action (Form 645) and lobbyists (Form 615) reported them to the Secretary of State; amended reports replace the originals. Beside each organization: its own quarterly lobbying reports since 2025, the total it reported paying for lobbying (everything it lobbied on, not one bill) and the bills it listed. A report lists bills; it doesn't say what position the organization took. These are facts side by side; they don't explain any vote. Source: Cal-Access. <a class="tap" href="${HOW}">How</a></p>
</section>`;
}
