// The sync step `executive-funding` (see docs/funding.md): money and disclosures
// for the executive branch, the same rules as for Congress.
//
//   1. Outside spenders: each group that spent for or against a candidate (from
//      federal-funding's outside-spending rows, for Congress and the President)
//      is looked up once at the FEC for its committee type, so pages can label
//      spending by groups that don't disclose their donors.
//   2. The President's inaugural committee (FEC Form 13): its reports and totals,
//      and the itemized donations summed by organization (individuals only as a
//      count and total). Checked every INAUGURAL_REFRESH_DAYS (7).
//   3. Financial disclosure reports and ethics agreements from the Office of
//      Government Ethics, for the President, the Vice President and the Cabinet,
//      matched by name. Checked every OGE_REFRESH_DAYS (7).
//   4. California's statewide officers: their Form 700 statements from the FPPC's
//      search (FPPC_REFRESH_DAYS, 7), and their campaign committees' Form 460
//      totals from data/ca-campaign.json (built weekly from the Cal-Access export
//      by tools/build_ca_campaign.py in GitHub Actions; loaded when it changes).
//
// FEC requests share federal-funding's key and pace. OGE and the FPPC are paced
// on their own.
import { getState, setState, BudgetExhausted, UpstreamError, isHttp, slugify } from "../util.js";
import { fecOptions } from "./sync.js";
import { seatOf, matchSeat, moneyRows } from "./state.js";
import {
  committeeTypes, pickInauguralCommittee, latestReports, parseForm13, form13Consistent, fecCommitteePage,
  OGE_API, OGE_SEARCH_PAGE, ogeRow, ogeKey, ogeNameMatches, nameParts,
  FPPC_SEARCH, fppcSearchBody, fppcRows, fppcParse,
} from "./disclosure.js";

const DAY = 86400000;
const due = (iso, days) => !iso || Date.parse(`${String(iso).replace(" ", "T")}${/Z$/.test(iso) ? "" : "Z"}`) < Date.now() - days * DAY;

async function inBatches(db, stmts, size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

function fecClient(env, db, budget) {
  const o = fecOptions(env);
  if (!o.key) return null;
  return async (path, label) => {
    const url = `${o.base}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(o.key)}`;
    try {
      return await (await budget.paced(db, "fec", o.pace, url, { headers: { Accept: "application/json" } }, label)).json();
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 429) throw new BudgetExhausted("FEC hourly rate limit reached");
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Outside spenders' committee types

async function spenderTypes(db, fec) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT x.committee_id FROM funding_outside x LEFT JOIN fec_committees c ON c.committee_id = x.committee_id
       WHERE c.committee_id IS NULL OR c.checked_at < datetime('now', '-180 days') LIMIT 500`
    )
    .all();
  let n = 0;
  for (let i = 0; i < results.length; i += 50) {
    const ids = results.slice(i, i + 50).map((r) => r.committee_id);
    const d = await fec(`/committees/?${ids.map((id) => `committee_id=${encodeURIComponent(id)}`).join("&")}&per_page=100`, `committee types (${ids.length})`);
    const found = new Map(committeeTypes(d.results).map((c) => [c.committee_id, c]));
    const stmts = ids.map((id) => {
      const c = found.get(id) || { committee_id: id, name: null, committee_type: null, committee_type_full: null };
      return db
        .prepare(
          `INSERT INTO fec_committees (committee_id, name, committee_type, committee_type_full, source_url, checked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(committee_id) DO UPDATE SET name = COALESCE(excluded.name, fec_committees.name), committee_type = excluded.committee_type,
             committee_type_full = excluded.committee_type_full, source_url = excluded.source_url, checked_at = excluded.checked_at`
        )
        .bind(id, c.name, c.committee_type, c.committee_type_full, fecCommitteePage(id));
    });
    await inBatches(db, stmts);
    n += ids.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 2. The inaugural committee

async function inaugural(env, db, budget, fec) {
  const days = parseInt(env.INAUGURAL_REFRESH_DAYS || "7", 10);
  if (!due(await getState(db, "inaugural_checked"), days)) return null;
  const president = await db.prepare("SELECT id, name, term_start FROM officials WHERE chamber = 'us-executive' AND rank = 1 AND active = 1").first();
  if (!president || !president.term_start) return "no President with a term start date";
  const d = await fec(`/committees/?q=inaugural&sort=-first_file_date&per_page=20`, "inaugural committees");
  const c = pickInauguralCommittee(d.results, president.term_start);
  if (!c) {
    await setState(db, "inaugural_checked", new Date().toISOString());
    return `no inaugural committee registered for the term starting ${president.term_start}`;
  }
  const src = fecCommitteePage(c.committee_id);
  await db
    .prepare(
      `INSERT INTO inaugural_committees (committee_id, official_id, name, term_start, source_url, checked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(committee_id) DO UPDATE SET official_id = excluded.official_id, name = excluded.name, term_start = excluded.term_start, checked_at = excluded.checked_at`
    )
    .bind(c.committee_id, president.id, String(c.name).trim(), president.term_start, src)
    .run();
  const f = await fec(`/filings/?committee_id=${c.committee_id}&form_type=F13&per_page=100&sort=-receipt_date`, `inaugural reports ${c.committee_id}`);
  const reports = latestReports(f.results);
  await inBatches(db, [
    db.prepare("DELETE FROM inaugural_reports WHERE committee_id = ?").bind(c.committee_id),
    ...reports.map((r) =>
      db
        .prepare(
          `INSERT INTO inaugural_reports (committee_id, report, coverage_start, coverage_end, receipt_date, total_receipts, amended, file_number, pdf_url, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(c.committee_id, r.report, r.coverage_start || "", r.coverage_end, r.receipt_date, r.total_receipts, r.amended, r.file_number, r.pdf_url, r.pdf_url || src)
    ),
  ]);

  // The itemized donations in the main report (the one that starts first), read
  // again only when a new version of it is filed.
  const main = reports[0];
  let note = null;
  if (main && main.fec_url) {
    const prev = await db.prepare("SELECT file_number FROM inaugural_breakdown WHERE committee_id = ?").bind(c.committee_id).first();
    if (!prev || prev.file_number !== main.file_number) {
      const text = await (
        await budget.paced(db, "fec-files", { intervalMs: 4000, dailyLimit: parseInt(env.FEC_FILES_DAILY_LIMIT || "20", 10) }, main.fec_url, {}, `inaugural report file ${main.file_number}`)
      ).text();
      const parsed = parseForm13(text);
      const ok = form13Consistent(parsed, main.total_receipts);
      note = ok ? null : `The itemized donations in this report (${parsed.rows} lines) don't add up to its total, so the breakdown isn't shown.`;
      const stmts = [
        db.prepare("DELETE FROM inaugural_organizations WHERE committee_id = ?").bind(c.committee_id),
        db
          .prepare(
            `INSERT OR REPLACE INTO inaugural_breakdown (committee_id, file_number, report, individual_count, individual_total, organization_count, organization_total,
               other_total, refunds_total, itemized_total, note, source_url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(c.committee_id, main.file_number, main.report, parsed.individuals.count, parsed.individuals.total, parsed.organizations.length,
            parsed.organizations.reduce((s, o) => s + o.total, 0), parsed.other.total, parsed.refunds.total, parsed.total, note, main.pdf_url || src),
      ];
      if (ok) {
        for (const o of parsed.organizations) {
          stmts.push(
            db.prepare("INSERT OR REPLACE INTO inaugural_organizations (committee_id, name, total, count, source_url) VALUES (?, ?, ?, ?, ?)").bind(c.committee_id, o.name, o.total, o.count, main.pdf_url || src)
          );
        }
      }
      await inBatches(db, stmts);
    }
  }
  await setState(db, "inaugural_checked", new Date().toISOString());
  return `inaugural committee ${c.committee_id}: ${reports.length} report(s)${note ? `; ${note}` : ""}`;
}

// ---------------------------------------------------------------------------
// 3. OGE disclosures

async function ogeDisclosures(env, db, budget) {
  const days = parseInt(env.OGE_REFRESH_DAYS || "7", 10);
  const pace = { intervalMs: parseInt(env.OGE_MIN_INTERVAL_MS || "3000", 10), dailyLimit: parseInt(env.OGE_DAILY_LIMIT || "200", 10) };
  const base = (env.OGE_API || OGE_API).replace(/\/$/, "");
  const { results: people } = await db
    .prepare(
      `SELECT o.id, o.name FROM officials o LEFT JOIN disclosure_checks k ON k.official_id = o.id AND k.source = 'oge'
       WHERE o.chamber = 'us-executive' AND o.active = 1 AND (k.checked_at IS NULL OR k.checked_at < datetime('now', ?))
       ORDER BY k.checked_at IS NOT NULL, o.rank LIMIT 40`
    )
    .bind(`-${days} days`)
    .all();
  let searched = 0;
  let found = 0;
  for (const p of people) {
    const parts = nameParts(p.name);
    if (!parts) continue;
    const rows = [];
    for (let start = 0, page = 0; page < 5; page++, start += 100) {
      const url = `${base}?draw=1&start=${start}&length=100&search%5Bvalue%5D=${encodeURIComponent(parts.last)}`;
      const d = await (await budget.paced(db, "oge", pace, url, { headers: { Accept: "application/json" } }, `OGE disclosures ${p.name}`)).json();
      rows.push(...(d.data || []));
      if (start + 100 >= (d.recordsFiltered || 0)) break;
    }
    const mine = rows.filter((r) => ogeNameMatches(r.name, p.name)).map(ogeRow).filter(Boolean);
    const stmts = [db.prepare("DELETE FROM disclosures WHERE official_id = ? AND source = 'oge'").bind(p.id)];
    for (const x of mine) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO disclosures (id, official_id, source, kind, doc_type, filer_name, position, agency, filed_on, amended_on, document_url, request_url, source_url, updated_at)
             VALUES (?, ?, 'oge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(`oge:${ogeKey(x)}`, p.id, x.kind, x.doc_type, x.name, x.title, x.agency, x.added_on, x.amended_on,
            isHttp(x.document_url) ? x.document_url : null, isHttp(x.request_url) ? x.request_url : null, OGE_SEARCH_PAGE)
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO disclosure_checks (official_id, source, checked_at, note) VALUES (?, 'oge', datetime('now'), ?)
           ON CONFLICT(official_id, source) DO UPDATE SET checked_at = excluded.checked_at, note = excluded.note`
        )
        .bind(p.id, mine.length ? null : `No OGE records under "${parts.last}" matched ${p.name}.`)
    );
    await inBatches(db, stmts);
    searched += 1;
    found += mine.length;
  }
  return searched ? `OGE: ${searched} official(s) searched, ${found} record(s)` : null;
}

// ---------------------------------------------------------------------------
// 4. California: Form 700 statements and campaign committees

async function fppcStatements(env, db, budget) {
  const days = parseInt(env.FPPC_REFRESH_DAYS || "7", 10);
  const pace = { intervalMs: parseInt(env.FPPC_MIN_INTERVAL_MS || "3000", 10), dailyLimit: parseInt(env.FPPC_DAILY_LIMIT || "100", 10) };
  const base = (env.FPPC_SEARCH || FPPC_SEARCH).replace(/\/$/, "");
  const { results: people } = await db
    .prepare(
      `SELECT o.id, o.name, o.office FROM officials o LEFT JOIN disclosure_checks k ON k.official_id = o.id AND k.source = 'fppc'
       WHERE o.chamber = 'ca-executive' AND o.active = 1 AND (k.checked_at IS NULL OR k.checked_at < datetime('now', ?))
       ORDER BY k.checked_at IS NOT NULL, o.rank LIMIT 20`
    )
    .bind(`-${days} days`)
    .all();
  let searched = 0;
  let found = 0;
  for (const p of people) {
    const parts = nameParts(p.name);
    if (!parts) continue;
    const res = await budget.paced(db, "fppc", pace, `${base}/Home/SearchDocuments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(fppcSearchBody(p.name.replace(/,? (Jr|Sr|II|III)\.?$/, "").split(/\s+/).pop())),
    }, `FPPC Form 700s ${p.name}`);
    const docs = fppcParse(await res.text()).documents || [];
    const mine = fppcRows(docs, p);
    const stmts = [db.prepare("DELETE FROM disclosures WHERE official_id = ? AND source = 'fppc'").bind(p.id)];
    for (const x of mine) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO disclosures (id, official_id, source, kind, doc_type, filer_name, position, agency, filed_on, period, amended_on, detail, source_url, updated_at)
             VALUES (?, ?, 'fppc', 'financial', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(`fppc:${x.index_id}`, p.id, x.doc_type, p.name, x.position, x.agency, x.filed_on, x.period, x.amended ? x.filed_on : null,
            JSON.stringify({ index_id: x.index_id, pdf: x.pdf, no_interests: x.no_interests }), `${FPPC_SEARCH}/`)
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO disclosure_checks (official_id, source, checked_at, note) VALUES (?, 'fppc', datetime('now'), ?)
           ON CONFLICT(official_id, source) DO UPDATE SET checked_at = excluded.checked_at, note = excluded.note`
        )
        .bind(p.id, mine.length ? null : `No Form 700 filed as ${p.office} under this name was found in the FPPC's search.`)
    );
    await inBatches(db, stmts);
    searched += 1;
    found += mine.length;
  }
  return searched ? `FPPC: ${searched} official(s) searched, ${found} Form 700(s)` : null;
}

/** The statements that replace one official's California campaign rows with an entry from data/ca-campaign.json. */
export function stateCampaignStatements(db, id, entry, note) {
  const stmts = [
    db.prepare("DELETE FROM state_campaign_totals WHERE filer_id IN (SELECT filer_id FROM state_campaign_committees WHERE official_id = ?)").bind(id),
    db.prepare("DELETE FROM state_campaign_committees WHERE official_id = ?").bind(id),
    ...["state_money_cycles", "state_money_industries", "state_money_employers", "state_money_orgs", "state_money_ie"].map((t) => db.prepare(`DELETE FROM ${t} WHERE official_id = ?`).bind(id)),
  ];
  let committees = 0;
  let reports = 0;
  for (const c of (entry && entry.committees) || []) {
    if (!c.filer_id || !isHttp(c.source_url)) continue;
    stmts.push(db.prepare("INSERT OR REPLACE INTO state_campaign_committees (official_id, filer_id, name, source_url, checked_at) VALUES (?, ?, ?, ?, datetime('now'))").bind(id, String(c.filer_id), c.name || null, c.source_url));
    committees += 1;
    for (const r of c.reports || []) {
      if (!r.from || !r.thru || !isHttp(r.source_url)) continue;
      stmts.push(
        db
          .prepare("INSERT OR REPLACE INTO state_campaign_totals (filer_id, period_start, period_end, contributions, expenditures, cash_end, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(String(c.filer_id), r.from, r.thru, r.contributions ?? null, r.expenditures ?? null, r.cash_end ?? null, r.source_url)
      );
      reports += 1;
    }
  }
  if (entry) {
    const m = moneyRows(id, entry);
    const insert = (table, rows) => {
      for (const row of rows) {
        const cols = Object.keys(row);
        stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((k) => row[k])));
      }
    };
    insert("state_money_cycles", m.cycles);
    insert("state_money_industries", m.industries);
    insert("state_money_employers", m.employers);
    insert("state_money_orgs", m.orgs);
    insert("state_money_ie", m.ie);
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO disclosure_checks (official_id, source, checked_at, note) VALUES (?, 'cal-access', datetime('now'), ?)
         ON CONFLICT(official_id, source) DO UPDATE SET checked_at = excluded.checked_at, note = excluded.note`
      )
      .bind(id, note)
  );
  return { stmts, committees, reports };
}

/**
 * data/ca-campaign.json (Cal-Access, built in GitHub Actions) → state_campaign_*
 * and state_money_*, for the statewide officers and every legislator; only when
 * the file changes.
 */
async function caCampaign(env, db, budget) {
  const url = `${(env.SITE_URL || "").replace(/\/$/, "")}/data/ca-campaign.json`;
  let file;
  try {
    file = await budget.json(url, {}, "ca-campaign.json");
  } catch (err) {
    if (err && err.status === 404) return "California campaign data: data/ca-campaign.json not built yet";
    throw err;
  }
  const stamp = `${file.generated}|${file.export_modified}`;
  if ((await getState(db, "ca_campaign_loaded")) === stamp) return null;
  const exported = `Cal-Access export of ${file.export_modified || file.generated}`;
  const { results: officials } = await db
    .prepare("SELECT id, name, chamber, district_code FROM officials WHERE chamber IN ('ca-executive', 'ca-assembly', 'ca-senate') AND active = 1")
    .all();
  const stmts = [];
  let committees = 0;
  let reports = 0;
  let people = 0;
  let unmatched = 0;
  const add = (id, entry, note) => {
    const r = stateCampaignStatements(db, id, entry, note);
    stmts.push(...r.stmts);
    committees += r.committees;
    reports += r.reports;
    people += 1;
  };
  // Statewide officers, by office.
  for (const [key, entry] of Object.entries(file.officials || {})) {
    const id = `ca-exec:${slugify(key)}:${slugify(entry.name || "")}`;
    if (!officials.some((o) => o.id === id)) continue;
    add(id, entry, (entry.committees || []).length ? exported : "No campaign statements (Form 460) naming this official as the candidate since 2023 in the Cal-Access export.");
  }
  // Legislators, by seat and name; the seats file lists only candidates with a statement since 2025.
  if (file.seats) {
    for (const o of officials.filter((x) => x.chamber !== "ca-executive")) {
      const seat = seatOf(o);
      const entry = seat ? matchSeat(file.seats[seat], o) : null;
      if (!entry) unmatched += 1;
      add(o.id, entry, entry ? exported : `No campaign statement (Form 460) since 2025 naming this legislator as the candidate for this seat in the ${exported}.`);
    }
  }
  await inBatches(db, stmts);
  await setState(db, "ca_campaign_loaded", stamp);
  return `California campaign data: ${people} official(s) (${unmatched} legislator(s) without a statement for their seat), ${committees} committee(s), ${reports} statement(s)`;
}

export async function syncExecutiveFunding(env, db, budget) {
  const done = [];
  const fec = fecClient(env, db, budget);
  try {
    if (fec) {
      const n = await spenderTypes(db, fec);
      if (n) done.push(`${n} outside spender(s) looked up at the FEC`);
      const i = await inaugural(env, db, budget, fec);
      if (i) done.push(i);
    } else {
      done.push("FEC: no key (FEC_API_KEY or CONGRESS_API_KEY), skipped");
    }
    const o = await ogeDisclosures(env, db, budget);
    if (o) done.push(o);
    const c = await caCampaign(env, db, budget);
    if (c) done.push(c);
    const f = await fppcStatements(env, db, budget);
    if (f) done.push(f);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: [...done, err.message].join("; ") };
  }
  if (!done.length) return { status: "skipped", message: "executive funding and disclosures are up to date" };
  return { status: "ok", message: done.join("; ") };
}
