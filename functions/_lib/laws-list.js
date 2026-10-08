// The Laws list pages (/laws/): one compact line per item, with a
// Bills / Orders / Constitution switch, filter chips, and "Load more".
//   bills          bill_list (built by the sync; never computed from the votes tables)
//   orders         executive orders, every President and Governor on file, newest first
//   constitution   bills and orders with a checked analysis, by the clause they touch
// Each line shows the first constitutional clause a checked analysis maps.
import { inChunks } from "./data.js";
import { OUTCOME_LABEL } from "./executive.js";
import { orderShort, orderHref } from "./orders.js";
import { billHref } from "./votes.js";
import { fmtDate } from "./render.js";

export const PER_PAGE = 25;
const PUBLIC = "(a.status = 'reviewed' OR (a.status = 'ai_draft' AND a.ai_review = 'pass'))";
const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

export const BILL_FILTERS = {
  all: ["All", ""],
  federal: ["Congress", "AND level = 'federal'"],
  state: ["California", "AND level = 'state'"],
  law: ["Became law", "AND outcome IN ('signed', 'without_signature', 'over_veto', 'became_law')"],
  vetoed: ["Vetoed", "AND outcome IN ('vetoed', 'pocket_vetoed')"],
  any: ["Any recorded vote", ""],
};
export const ORDER_FILTERS = {
  all: ["All", ""],
  president: ["President", "AND x.id LIKE 'fr:%'"],
  governor: ["Governor", "AND x.id LIKE 'ca-gov:%'"],
};

const SHORT_CHAMBER = { "us-house": "House", "us-senate": "Senate", "ca-assembly": "Assembly", "ca-senate": "State Senate" };

/** A bill's status in a few words, from its bill_list row. */
export function listBillStatus(b) {
  if (b.outcome && b.outcome !== "presented") return OUTCOME_LABEL[b.outcome] || b.outcome;
  if (b.outcome === "presented") return b.level === "federal" ? "Presented to the President" : "Presented to the Governor";
  if (b.final_result) return `${b.final_result}${SHORT_CHAMBER[b.final_chamber] ? ` · ${SHORT_CHAMBER[b.final_chamber]}` : ""}`;
  return "Recorded votes";
}

/** The first clause each subject's checked analysis maps: Map id -> {id, label}. */
export async function firstClauses(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const rows = await inChunks(ids, async (chunk) =>
      (await db.prepare(`SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND ${PUBLIC} AND a.bill_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all()).results
    );
    const first = new Map();
    for (const r of rows) {
      try {
        const c = JSON.parse(r.clauses || "[]")[0];
        if (c && c.id) first.set(r.bill_id, c.id);
      } catch (_) {}
    }
    const pids = [...new Set(first.values())];
    if (!pids.length) return out;
    const labels = new Map(
      (await inChunks(pids, async (chunk) => (await db.prepare(`SELECT id, label FROM constitution_provisions WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all()).results)).map((p) => [p.id, p.label])
    );
    for (const [id, pid] of first) if (labels.has(pid)) out.set(id, { id: pid, label: labels.get(pid) });
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return out;
}

/** One page of bills, newest final vote first (or newest vote of any kind for "Any recorded vote"). */
export async function billRows(db, { filter = "all", offset = 0 }) {
  const f = BILL_FILTERS[filter] || BILL_FILTERS.all;
  const any = filter === "any";
  const order = any ? "last_vote" : "last_final";
  try {
    const { results } = await db
      .prepare(`SELECT * FROM bill_list WHERE 1 = 1 ${any ? "" : "AND last_final IS NOT NULL"} ${f[1]} ORDER BY ${order} DESC, bill_id DESC LIMIT ? OFFSET ?`)
      .bind(PER_PAGE + 1, offset)
      .all();
    const rows = results.slice(0, PER_PAGE);
    const clauses = await firstClauses(db, rows.map((r) => r.bill_id));
    return {
      more: results.length > PER_PAGE,
      rows: rows.map((b) => ({
        href: billHref(b.bill_id),
        type: b.bill_number,
        title: b.title,
        status: listBillStatus(b),
        meta: b.outcome && b.outcome !== "presented" ? fmtDate(b.outcome_date) : fmtDate(any ? b.last_vote : b.last_final),
        clause: clauses.get(b.bill_id) || null,
      })),
    };
  } catch (err) {
    if (missing(err)) return { rows: [], more: false, provisional: true };
    throw err;
  }
}

/** One page of executive orders, newest first. */
export async function orderRows(db, { filter = "all", offset = 0 }) {
  const f = ORDER_FILTERS[filter] || ORDER_FILTERS.all;
  try {
    const { results } = await db
      .prepare(
        `SELECT x.id, x.kind, x.number, x.title, x.signed_on, x.published_on, x.notes, o.name AS official_name
         FROM executive_actions x LEFT JOIN officials o ON o.id = x.official_id
         WHERE x.kind = 'executive_order' ${f[1]}
         ORDER BY COALESCE(x.signed_on, x.published_on) DESC, x.id DESC LIMIT ? OFFSET ?`
      )
      .bind(PER_PAGE + 1, offset)
      .all();
    const rows = results.slice(0, PER_PAGE);
    const clauses = await firstClauses(db, rows.map((r) => r.id));
    return {
      more: results.length > PER_PAGE,
      rows: rows.map((x) => ({
        href: orderHref(x.id),
        type: orderShort(x),
        title: x.title,
        status: /Revoked by/i.test(x.notes || "") ? "Revoked" : x.signed_on ? "Signed" : "Posted",
        meta: [fmtDate(x.signed_on || x.published_on), x.official_name].filter(Boolean).join(" · "),
        clause: clauses.get(x.id) || null,
      })),
    };
  } catch (err) {
    if (missing(err)) return { rows: [], more: false };
    throw err;
  }
}

/** The provisions checked analyses map most often, for the Constitution view's chips. */
export async function topClauses(db, limit = 8) {
  try {
    const { results } = await db
      .prepare(
        `SELECT json_extract(j.value, '$.id') AS id, p.label, COUNT(*) AS n
         FROM bill_analyses a, json_each(a.clauses) j JOIN constitution_provisions p ON p.id = json_extract(j.value, '$.id')
         WHERE a.current = 1 AND ${PUBLIC}
         GROUP BY 1 ORDER BY n DESC, p.sort LIMIT ?`
      )
      .bind(limit)
      .all();
    return results;
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** Bills and orders with a checked analysis, newest analysis first; `clause` keeps those that map that provision. */
export async function constitutionRows(db, { clause = null, offset = 0 }) {
  try {
    const { results } = await db
      .prepare(
        `SELECT a.bill_id AS id, a.clauses, b.bill_number, b.title AS bill_title, l.outcome, l.final_result, l.final_chamber, l.level AS list_level,
                x.number, x.kind, x.title AS order_title, x.signed_on, x.published_on, x.notes
         FROM bill_analyses a LEFT JOIN bills b ON b.id = a.bill_id LEFT JOIN bill_list l ON l.bill_id = a.bill_id
           LEFT JOIN executive_actions x ON x.id = a.bill_id
         WHERE a.current = 1 AND ${PUBLIC} AND (b.id IS NOT NULL OR x.id IS NOT NULL)
           ${clause ? "AND EXISTS (SELECT 1 FROM json_each(a.clauses) j WHERE json_extract(j.value, '$.id') = ?)" : ""}
         ORDER BY a.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...(clause ? [clause] : []), PER_PAGE + 1, offset)
      .all();
    const rows = results.slice(0, PER_PAGE);
    const pids = new Set();
    const firstOf = (r) => {
      try {
        const list = JSON.parse(r.clauses || "[]").map((c) => c.id);
        return clause && list.includes(clause) ? clause : list[0];
      } catch (_) {
        return null;
      }
    };
    for (const r of rows) {
      const p = firstOf(r);
      if (p) pids.add(p);
    }
    const labels = new Map(
      pids.size ? (await db.prepare(`SELECT id, label FROM constitution_provisions WHERE id IN (${[...pids].map(() => "?").join(",")})`).bind(...pids).all()).results.map((p) => [p.id, p.label]) : []
    );
    return {
      more: results.length > PER_PAGE,
      rows: rows.map((r) => {
        const p = firstOf(r);
        const isOrder = !r.bill_number;
        return {
          href: isOrder ? orderHref(r.id) : billHref(r.id),
          type: isOrder ? orderShort(r) : r.bill_number,
          title: isOrder ? r.order_title : r.bill_title,
          status: isOrder ? (/Revoked by/i.test(r.notes || "") ? "Revoked" : "Executive order") : listBillStatus({ outcome: r.outcome, final_result: r.final_result, final_chamber: r.final_chamber, level: r.list_level }),
          meta: isOrder ? fmtDate(r.signed_on || r.published_on) : "",
          clause: p && labels.has(p) ? { id: p, label: labels.get(p) } : null,
        };
      }),
    };
  } catch (err) {
    if (missing(err)) return { rows: [], more: false };
    throw err;
  }
}
