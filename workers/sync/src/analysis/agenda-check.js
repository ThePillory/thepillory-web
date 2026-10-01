// The checks run on every agenda-watch draft before it's saved (pure; see agenda.js).
import { ISSUES } from "../../../../functions/_lib/generated.js";
import { splitSentences } from "./verify.js";

export const FLAGS = ["budget", "land_use", "fees_taxes", "public_safety", "public_access"];
// At most this many items per agenda are flagged and shown under Agenda watch;
// every other item is in the full agenda only.
export const MAX_FLAGGED = 5;
export const IMPACT = ["high", "medium", "low"];
const IMPACT_RANK = { high: 2, medium: 1, low: 0 };

export const FLAG_LABELS = {
  budget: "Budget",
  land_use: "Land use",
  fees_taxes: "Fees & taxes",
  public_safety: "Public safety",
  public_access: "Public access & meetings",
};

// Numbers, amounts and dates stated in a sentence ("$250,000", "2026-27", "60", "July 28").
const NUMBERS = /\$?\d[\d,]*(?:\.\d+)?(?:-\d+)?%?/g;
const norm = (s) => String(s).replace(/[$,%]/g, "").replace(/\.0+$/, "");

/**
 * Keep flags on at most `max` items, ranked by public impact, and number them
 * (rank 1 = most impact). An item the drafter rated "low" is never flagged; a
 * consent-calendar item only when rated "high" (consent items are meant to be
 * routine). Ties go to regular items before consent items, then agenda order.
 * Summaries saved before impact ratings existed count as "medium". Pure: returns
 * new items and {kept, cleared}.
 */
export function rankFlags(summaryItems, agendaItems, max = MAX_FLAGGED) {
  const meta = new Map((agendaItems || []).map((it, i) => [String(it.item_key), { consent: it.section_kind === "consent", order: i }]));
  const rated = (summaryItems || []).map((s) => ({ ...s, flags: [...(s.flags || [])], impact: IMPACT.includes(s.impact) ? s.impact : null }));
  const impactOf = (s) => s.impact || "medium";
  const eligible = rated.filter((s) => {
    if (!s.flags.length) return false;
    const m = meta.get(String(s.item_key)) || {};
    if (impactOf(s) === "low") return false;
    return !m.consent || impactOf(s) === "high";
  });
  eligible.sort((a, b) => {
    const ma = meta.get(String(a.item_key)) || { order: 1e9 };
    const mb = meta.get(String(b.item_key)) || { order: 1e9 };
    return IMPACT_RANK[impactOf(b)] - IMPACT_RANK[impactOf(a)] || Number(!!ma.consent) - Number(!!mb.consent) || ma.order - mb.order;
  });
  const keep = new Map(eligible.slice(0, max).map((s, i) => [s.item_key, i + 1]));
  let cleared = 0;
  const items = rated.map((s) => {
    const { rank: _old, ...rest } = s;
    if (keep.has(s.item_key)) return { ...rest, rank: keep.get(s.item_key) };
    if (s.flags.length) cleared += 1;
    return { ...rest, flags: [] };
  });
  return { items, kept: keep.size, cleared };
}

/** Remove sentences that state a number the item's agenda text doesn't contain. Mutates; returns the log. */
export function checkSummaries(draft, items) {
  const byKey = new Map(items.map((it) => [it.item_key, it]));
  const log = { dropped_items: [], removed_sentences: [] };
  const seen = new Set();
  draft.items = (draft.items || []).filter((s) => {
    if (!byKey.has(s.item_key) || seen.has(s.item_key)) {
      log.dropped_items.push({ item_key: s.item_key, reason: byKey.has(s.item_key) ? "duplicate" : "no such item on the agenda" });
      return false;
    }
    seen.add(s.item_key);
    const it = byKey.get(s.item_key);
    const source = `${it.title} ${JSON.parse(it.attachments || "[]").map((a) => a.title).join(" ")}`;
    const have = new Set((source.match(NUMBERS) || []).map(norm));
    const keep = [];
    for (const sentence of splitSentences(s.summary || "")) {
      const missing = (sentence.match(NUMBERS) || []).map(norm).filter((x) => x && !have.has(x) && !source.includes(x));
      if (missing.length) log.removed_sentences.push({ item_key: s.item_key, sentence, because: `states ${missing.join(", ")}, which the agenda item doesn't` });
      else keep.push(sentence);
    }
    s.summary = keep.join(" ");
    s.flags = [...new Set(s.flags || [])].filter((f) => FLAGS.includes(f));
    return true;
  });
  const ranked = rankFlags(draft.items, items);
  draft.items = ranked.items;
  log.flags_cleared = ranked.cleared;
  const links = new Set();
  draft.issue_links = (draft.issue_links || []).filter((l) => {
    const k = `${l.item_key}|${l.issue_slug}`;
    if (!byKey.has(l.item_key) || !ISSUES[l.issue_slug] || links.has(k)) return false;
    links.add(k);
    return true;
  });
  return log;
}

