// Why the AI reviewer flags drafts: a summary across flagged drafts, for /status
// (sync Worker) and the review page (/admin/review/). Pure: no fetching, no SDK.
import { CHECKS } from "./review-checks.js";

const short = (s, n = 220) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * `rows`: [{bill_id, detail}] where detail is a parsed ai_review_detail. Uses
 * the review as given, or, for a draft re-reviewed under newer rules, the
 * earlier review kept in `previous` (pass `which: "previous"`).
 * Returns {drafts, by_check: {id: n}, by_severity: {major, minor, unrated}, revised, items: [...]}.
 */
export function summarizeFlags(rows, { which = "current" } = {}) {
  const by_check = Object.fromEntries(CHECKS.map(([id]) => [id, 0]));
  const by_severity = { major: 0, minor: 0, unrated: 0 };
  let revised = 0;
  const items = [];
  for (const { bill_id, detail } of rows) {
    const d = which === "previous" ? detail && detail.previous : detail;
    if (!d) continue;
    const failed = (d.checks || []).filter((c) => c && c.ok === false);
    if (detail && detail.revised && which !== "previous") revised += 1;
    for (const c of failed) {
      if (by_check[c.id] != null) by_check[c.id] += 1;
      if (c.severity === "major" || c.severity === "minor") by_severity[c.severity] += 1;
      else by_severity.unrated += 1;
    }
    items.push({
      bill_id,
      failed: failed.map((c) => (c.severity && c.severity !== "none" ? `${c.id} (${c.severity})` : c.id)),
      reasons: (failed.length ? failed.map((c) => `${c.id}: ${short(c.note)}`) : (d.reasons || []).map((r) => short(r))).slice(0, 5),
    });
  }
  return { drafts: items.length, by_check, by_severity, revised, items };
}
