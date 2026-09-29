// The checks run on every agenda-watch draft before it's saved (pure; see agenda.js).
import { ISSUES } from "../../../../functions/_lib/generated.js";
import { splitSentences } from "./verify.js";

export const FLAGS = ["budget", "land_use", "fees_taxes", "public_safety", "public_access"];
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
  const links = new Set();
  draft.issue_links = (draft.issue_links || []).filter((l) => {
    const k = `${l.item_key}|${l.issue_slug}`;
    if (!byKey.has(l.item_key) || !ISSUES[l.issue_slug] || links.has(k)) return false;
    links.add(k);
    return true;
  });
  return log;
}

