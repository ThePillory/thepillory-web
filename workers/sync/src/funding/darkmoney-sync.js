// The dark-money step (see docs/funding.md and darkmoney.js):
//
//   1. Electioneering communications (FEC Form 9) for the current and previous
//      two-year period, all of them (a few dozen a period), and each Form 9's own
//      total of donations reported.
//   2. Outside spenders that don't report donors (FEC type I) and Form 9 filers:
//      their state from the FEC, then their IRS record through ProPublica's
//      Nonprofit Explorer search (exact name and state, one match only).
//   3. Outside spenders that report donors: their largest donors that are
//      organizations (FEC Schedule A, up to DARK_MONEY_MAX_PAGES pages of 100,
//      largest first), labeled LLC, 501(c)(4) or 501(c)(6) where that's known,
//      and the share of the spender's reported receipts from those.
//   4. Each 501(c)(4) and 501(c)(6) found: its latest Form 990 figures from
//      ProPublica (revenue, expenses, tax year). Political spending from
//      Schedule C is read from the IRS's XML by tools/load_nonprofits.py.
//
// FEC requests go through the funding steps' paced client and stop at
// DARK_MONEY_FEC_DAILY (400) a day; ProPublica requests are paced
// (PROPUBLICA_MIN_INTERVAL_MS, 1 s) and capped (PROPUBLICA_DAILY_LIMIT, 300).
import { getState, setState, BudgetExhausted, UpstreamError, isHttp } from "../util.js";
import { fecOptions } from "./sync.js";
import { currentCycle } from "./fec.js";
import { FEC_LINES, PROPUBLICA, aggregateDonors, pickNonprofit, nonprofitRow, electioneeringRows, orgKey, DARK_KINDS } from "./darkmoney.js";

const TOP_DONORS = 15; // saved per spender and period, and the most looked up in IRS records
async function inBatches(db, stmts, size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}
const today = () => new Date().toISOString().slice(0, 10);

function clients(env, db, budget) {
  const o = fecOptions(env);
  const fecDaily = parseInt(env.DARK_MONEY_FEC_DAILY || "400", 10);
  const countKey = `dark_money_fec_${today()}`;
  let used = null;
  const fec = async (path, label) => {
    if (!o.key) throw new BudgetExhausted("no FEC key");
    if (used === null) used = parseInt((await getState(db, countKey)) || "0", 10);
    if (used >= fecDaily) throw new BudgetExhausted(`dark money FEC limit (${fecDaily}) reached`);
    used += 1;
    await setState(db, countKey, String(used));
    const url = `${o.base}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(o.key)}`;
    try {
      return await (await budget.paced(db, "fec", o.pace, url, { headers: { Accept: "application/json" } }, label)).json();
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 429) throw new BudgetExhausted("FEC hourly rate limit reached");
      throw err;
    }
  };
  const ppPace = { intervalMs: parseInt(env.PROPUBLICA_MIN_INTERVAL_MS || "1000", 10), dailyLimit: parseInt(env.PROPUBLICA_DAILY_LIMIT || "300", 10) };
  const base = (env.PROPUBLICA_API_BASE || PROPUBLICA).replace(/\/$/, "");
  const propublica = async (path, label) => {
    try {
      return await (await budget.paced(db, "propublica", ppPace, `${base}${path}`, { headers: { Accept: "application/json" } }, label)).json();
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return null;
      throw err;
    }
  };
  return { fec, propublica };
}

/** The one IRS record for this name and state, through ProPublica's search; asked once per name. */
async function lookupOrg(db, propublica, name, state) {
  const key = `${orgKey(name)}|${state || ""}`;
  const have = await db.prepare("SELECT ein, subsection FROM org_lookups WHERE name_key = ?").bind(key).first();
  if (have) return have.ein ? have : null;
  const d = await propublica(`/search.json?q=${encodeURIComponent(name)}`, `IRS record search "${name}"`);
  const hit = pickNonprofit(d && d.organizations, name, state);
  await db.prepare("INSERT OR REPLACE INTO org_lookups (name_key, ein, subsection, checked_at) VALUES (?, ?, ?, datetime('now'))").bind(key, hit ? hit.ein : null, hit ? hit.subsection : null).run();
  return hit;
}

// 1. Electioneering communications.
async function electioneering(db, fec, counts) {
  const cycle = currentCycle();
  for (const cyc of [cycle, cycle - 2]) {
    const key = `electioneering_read_${cyc}`;
    if ((await getState(db, key)) === today() || (cyc < cycle && (await getState(db, key)))) continue;
    let page = 1;
    for (;;) {
      const d = await fec(`/electioneering/?min_date=${cyc - 1}-01-01&max_date=${cyc}-12-31&per_page=100&page=${page}&sort=-disbursement_date`, `electioneering ${cyc} page ${page}`);
      const rows = electioneeringRows(d.results, cyc);
      await inBatches(
        db,
        rows.map((r) =>
          db
            .prepare(
              `INSERT OR REPLACE INTO electioneering (sub_id, cycle, committee_id, committee_name, candidate_id, amount, disbursement_date, distribution_date, file_number, source_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(r.sub_id, r.cycle, r.committee_id, r.committee_name, r.candidate_id, r.amount, r.disbursement_date, r.distribution_date, r.file_number, r.source_url)
        )
      );
      counts.ec += rows.length;
      if (!d.pagination || page >= (d.pagination.pages || 1)) break;
      page += 1;
    }
    await setState(db, key, today());
  }
  // Each Form 9's own total of donations reported.
  const { results } = await db
    .prepare("SELECT DISTINCT e.file_number FROM electioneering e LEFT JOIN electioneering_filings f ON f.file_number = e.file_number WHERE e.file_number IS NOT NULL AND f.file_number IS NULL LIMIT 200")
    .all();
  for (let i = 0; i < results.length; i += 25) {
    const nums = results.slice(i, i + 25).map((r) => r.file_number);
    const d = await fec(`/filings/?${nums.map((n) => `file_number=${n}`).join("&")}&per_page=100`, `Form 9 filings (${nums.length})`);
    const found = new Map((d.results || []).map((f) => [Number(f.file_number), f]));
    await inBatches(
      db,
      nums.map((n) => {
        const f = found.get(Number(n));
        return db
          .prepare("INSERT OR REPLACE INTO electioneering_filings (file_number, committee_id, donations, source_url, checked_at) VALUES (?, ?, ?, ?, datetime('now'))")
          .bind(n, f ? f.committee_id : null, f && f.total_receipts != null ? Number(f.total_receipts) : null, f && isHttp(f.pdf_url) ? f.pdf_url : `https://docquery.fec.gov/cgi-bin/forms/${f ? f.committee_id : ""}/${n}/`);
      })
    );
  }
  // Form 9 filers are spenders too: make sure each has a committee row.
  await db
    .prepare(
      `INSERT OR IGNORE INTO fec_committees (committee_id, name, committee_type, source_url, checked_at)
       SELECT committee_id, MAX(committee_name), NULL, 'https://www.fec.gov/data/committee/' || committee_id || '/', datetime('now', '-1 year') FROM electioneering GROUP BY committee_id`
    )
    .run();
}

// 2. Spenders that don't report donors, and Form 9 filers: their IRS record.
async function spenderRecords(db, fec, propublica, counts) {
  const { results } = await db
    .prepare(
      `SELECT c.committee_id, c.name, c.state FROM fec_committees c
       WHERE (c.committee_type = 'I' OR c.committee_id IN (SELECT committee_id FROM electioneering))
         AND (c.ein_checked_at IS NULL OR c.ein_checked_at < datetime('now', '-180 days'))
       LIMIT 40`
    )
    .all();
  for (const c of results) {
    let state = c.state;
    let name = c.name;
    if (!state || !name) {
      const d = await fec(`/committee/${c.committee_id}/`, `committee ${c.committee_id}`);
      const r = (d.results || [])[0] || {};
      state = r.state || null;
      name = name || r.name || null;
    }
    const hit = name ? await lookupOrg(db, propublica, name, state) : null;
    const ein = hit && [4, 6].includes(Number(hit.subsection)) ? hit.ein : null;
    await db
      .prepare("UPDATE fec_committees SET state = ?, name = COALESCE(name, ?), ein = ?, ein_checked_at = datetime('now') WHERE committee_id = ?")
      .bind(state, name, ein, c.committee_id)
      .run();
    counts.spenders += 1;
    if (ein) counts.matched += 1;
  }
}

// 3. Spenders that report donors: their largest donors that are organizations.
async function spenderDonors(env, db, fec, propublica, counts) {
  const maxPages = parseInt(env.DARK_MONEY_MAX_PAGES || "10", 10);
  const cycle = currentCycle();
  const { results } = await db
    .prepare(
      `SELECT x.committee_id, x.cycle, SUM(x.total) AS spent FROM funding_outside x
       JOIN fec_committees c ON c.committee_id = x.committee_id AND c.committee_type IS NOT NULL AND c.committee_type <> 'I'
       LEFT JOIN outside_donor_reads r ON r.committee_id = x.committee_id AND r.cycle = x.cycle
       WHERE r.committee_id IS NULL OR (x.cycle = ? AND r.read_at < datetime('now', '-30 days'))
       GROUP BY x.committee_id, x.cycle ORDER BY r.committee_id IS NOT NULL, spent DESC LIMIT 25`
    )
    .bind(cycle)
    .all();
  for (const s of results) {
    const t = await fec(`/committee/${s.committee_id}/totals/?cycle=${s.cycle}`, `totals ${s.committee_id} ${s.cycle}`);
    const receipts = t.results && t.results[0] ? Number(t.results[0].receipts ?? t.results[0].fed_receipts) || null : null;
    const rows = [];
    let last = null;
    let truncated = false;
    for (let page = 0; page < maxPages; page += 1) {
      const q = new URLSearchParams({ committee_id: s.committee_id, two_year_transaction_period: String(s.cycle), is_individual: "false", sort: "-contribution_receipt_amount", per_page: "100" });
      for (const l of FEC_LINES) q.append("line_number", l);
      if (last) for (const [k, v] of Object.entries(last)) q.set(k, v);
      const d = await fec(`/schedules/schedule_a/?${q}`, `Schedule A ${s.committee_id} ${s.cycle} page ${page + 1}`);
      rows.push(...(d.results || []));
      last = d.pagination && d.pagination.last_indexes;
      if (!last || (d.results || []).length < 100) break;
      if (page === maxPages - 1) truncated = true;
    }
    const { donors } = aggregateDonors(rows, s.committee_id, s.cycle);
    // Look the largest organizations up in IRS records (committees and LLCs are known by their filing and name).
    for (const d of donors.slice(0, TOP_DONORS)) {
      if (d.kind !== "org") continue;
      const hit = await lookupOrg(db, propublica, d.name, d.state);
      if (hit && [4, 6].includes(Number(hit.subsection))) {
        d.kind = Number(hit.subsection) === 4 ? "c4" : "c6";
        d.ein = hit.ein;
      }
    }
    const dark = donors.filter((d) => DARK_KINDS.has(d.kind)).reduce((sum, d) => sum + d.total, 0);
    const keep = donors.slice(0, TOP_DONORS);
    const stmts = [
      db.prepare("DELETE FROM outside_donors WHERE committee_id = ? AND cycle = ?").bind(s.committee_id, s.cycle),
      ...keep.map((d) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO outside_donors (committee_id, cycle, name, kind, donor_committee_id, ein, state, total, count, first_date, last_date, source_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(s.committee_id, s.cycle, d.name, d.kind, d.donor_committee_id, d.ein || null, d.state, d.total, d.count, d.first_date, d.last_date, d.source_url)
      ),
      db
        .prepare(
          `INSERT OR REPLACE INTO outside_donor_reads (committee_id, cycle, receipts, rows_read, truncated, dark_total, source_url, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(s.committee_id, s.cycle, receipts, rows.length, truncated ? 1 : 0, Math.round(dark * 100) / 100, `https://www.fec.gov/data/receipts/?committee_id=${s.committee_id}&two_year_transaction_period=${s.cycle}`),
    ];
    await inBatches(db, stmts);
    counts.donors += 1;
  }
}

// 4. Nonprofits' Form 990 figures.
async function nonprofits(db, propublica, counts) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT e.ein FROM (SELECT ein FROM fec_committees WHERE ein IS NOT NULL UNION SELECT ein FROM outside_donors WHERE ein IS NOT NULL) e
       LEFT JOIN nonprofits n ON n.ein = e.ein WHERE n.ein IS NULL OR n.checked_at < datetime('now', '-90 days') LIMIT 40`
    )
    .all();
  for (const { ein } of results) {
    const d = await propublica(`/organizations/${ein}.json`, `990 ${ein}`);
    const row = nonprofitRow(d);
    if (!row || !isHttp(row.source_url)) continue;
    await db
      .prepare(
        `INSERT INTO nonprofits (ein, name, subsection, state, tax_year, period_end, revenue, expenses, filing_url, source_url, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(ein) DO UPDATE SET name = excluded.name, subsection = excluded.subsection, state = excluded.state,
           tax_year = COALESCE(excluded.tax_year, nonprofits.tax_year), period_end = COALESCE(excluded.period_end, nonprofits.period_end),
           revenue = COALESCE(excluded.revenue, nonprofits.revenue), expenses = COALESCE(excluded.expenses, nonprofits.expenses),
           filing_url = COALESCE(excluded.filing_url, nonprofits.filing_url), source_url = excluded.source_url, checked_at = excluded.checked_at`
      )
      .bind(row.ein, row.name, row.subsection, row.state, row.tax_year, row.period_end, row.revenue, row.expenses, row.filing_url, row.source_url)
      .run();
    counts.nonprofits += 1;
  }
}

export async function syncDarkMoney(env, db, budget) {
  const { fec, propublica } = clients(env, db, budget);
  const counts = { ec: 0, spenders: 0, matched: 0, donors: 0, nonprofits: 0 };
  const summary = () =>
    `${counts.ec} electioneering line(s) read, ${counts.spenders} spender(s) looked up in IRS records (${counts.matched} matched), ${counts.donors} spender-period(s) of donors read, ${counts.nonprofits} nonprofit filing(s) read`;
  try {
    await electioneering(db, fec, counts);
    await spenderRecords(db, fec, propublica, counts);
    await spenderDonors(env, db, fec, propublica, counts);
    await nonprofits(db, propublica, counts);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary()}; ${err.message}` };
  }
  const any = Object.values(counts).some((n) => n > 0);
  return { status: any ? "ok" : "skipped", message: any ? summary() : "dark money data is up to date" };
}

