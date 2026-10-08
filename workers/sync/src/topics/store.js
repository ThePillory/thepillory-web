// What the topics step reads and writes in D1: the next items to tag, and
// saving the answers. No SDK and no migrations here, so tests can run it
// against SQLite (test/topics.test.mjs). The step itself is in index.js.
import { TOPIC_PROMPT_VERSION } from "./tag.js";

const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

function summaryText(json, itemKey) {
  try {
    const it = JSON.parse(json || "[]").find((x) => x && x.item_key === itemKey);
    return it && it.summary ? ` Summary: ${it.summary}` : "";
  } catch (_) {
    return "";
  }
}

/** The next items to tag, at most `limit`, as { kind, id, text, hash }. Pure SQL reads; small. */
export async function nextItems(db, limit) {
  const out = [];
  const take = async (kind, rows, toItem) => {
    for (const r of rows) {
      if (out.length >= limit) return;
      const it = toItem(r);
      if (it && it.text.trim()) out.push({ kind, ...it });
    }
  };
  // County agenda items, with the AI summary of the item when there is one.
  const items = (
    await db
      .prepare(
        `SELECT mi.meeting_id, mi.item_key, mi.title, mi.section, m.body, s.items AS summaries
         FROM meeting_items mi JOIN meetings m ON m.id = mi.meeting_id
         LEFT JOIN agenda_summaries s ON s.meeting_id = mi.meeting_id AND s.current = 1 AND s.status != 'rejected'
         LEFT JOIN topic_runs r ON r.item_kind = 'meeting_item' AND r.item_id = mi.meeting_id || '/' || mi.item_key
         WHERE m.level = 'county' AND r.item_id IS NULL
         ORDER BY m.starts_at DESC, mi.sort LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results;
  await take("meeting_item", items, (r) => ({
    id: `${r.meeting_id}/${r.item_key}`,
    text: `${r.body}${r.section ? `, ${r.section}` : ""}: ${r.title}.${summaryText(r.summaries, r.item_key)}`,
  }));
  // Platform excerpts: new, or changed since they were tagged.
  if (out.length < limit) {
    const pages = (
      await db
        .prepare(
          `SELECT p.url, p.excerpt, o.name, o.office, r.text_hash, r.locked_by
           FROM promise_pages p JOIN officials o ON o.id = p.official_id
           LEFT JOIN topic_runs r ON r.item_kind = 'platform' AND r.item_id = p.url
           WHERE p.excerpt IS NOT NULL AND p.excerpt != '' AND r.locked_by IS NULL`
        )
        .all()
    ).results;
    for (const p of pages) {
      if (out.length >= limit) break;
      const hash = await sha256(p.excerpt);
      if (p.text_hash === hash) continue;
      out.push({ kind: "platform", id: p.url, text: `${p.office}: "${p.excerpt}"`, hash, retag: p.text_hash != null });
    }
  }
  if (out.length < limit) {
    const actions = (
      await db
        .prepare(
          `SELECT a.id, a.kind, a.title FROM executive_actions a
           LEFT JOIN topic_runs r ON r.item_kind = 'executive_action' AND r.item_id = a.id
           WHERE r.item_id IS NULL ORDER BY COALESCE(a.signed_on, a.published_on) DESC LIMIT ?`
        )
        .bind(limit - out.length)
        .all()
    ).results;
    await take("executive_action", actions, (r) => ({ id: r.id, text: `${r.kind === "executive_order" ? "Executive order" : r.kind === "proclamation" ? "Proclamation" : "Executive action"}: ${r.title}` }));
  }
  if (out.length < limit) {
    const bills = (
      await db
        .prepare(
          `SELECT bl.bill_id, bl.bill_number, bl.level, bl.title, b.summary, rel.reason
           FROM bill_list bl JOIN bills b ON b.id = bl.bill_id
           LEFT JOIN bill_relevance rel ON rel.bill_id = bl.bill_id AND rel.verdict = 'analyze'
           LEFT JOIN topic_runs r ON r.item_kind = 'bill' AND r.item_id = bl.bill_id
           WHERE bl.routine = 0 AND r.item_id IS NULL
           ORDER BY COALESCE(bl.last_final, bl.last_vote) DESC LIMIT ?`
        )
        .bind(limit - out.length)
        .all()
    ).results;
    await take("bill", bills, (r) => ({
      id: r.bill_id,
      text: `${r.bill_number} (${r.level === "state" ? "California Legislature" : "U.S. Congress"}): ${r.title}.${r.summary ? ` Summary: ${r.summary}` : r.reason ? ` What it does: ${r.reason}` : ""}`,
    }));
  }
  return out;
}

/** Save one batch's answers: each item's topics, and the item as tagged. */
export async function saveTags(db, results, model) {
  const stmts = [];
  for (const { item, topics, reason } of results) {
    if (item.retag) {
      stmts.push(
        db
          .prepare("UPDATE topic_tags SET removed_at = datetime('now'), removed_by = 'ai', removed_note = 'the text changed; tagged again' WHERE item_kind = ? AND item_id = ? AND removed_at IS NULL AND tagged_by NOT LIKE 'person:%'")
          .bind(item.kind, item.id)
      );
    }
    for (const t of topics) {
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO topic_tags (item_kind, item_id, topic, reason, tagged_by, prompt_version) VALUES (?, ?, ?, ?, ?, ?)").bind(item.kind, item.id, t, reason, model, TOPIC_PROMPT_VERSION)
      );
    }
    stmts.push(
      db
        .prepare("INSERT INTO topic_runs (item_kind, item_id, text_hash, model) VALUES (?, ?, ?, ?) ON CONFLICT (item_kind, item_id) DO UPDATE SET text_hash = excluded.text_hash, model = excluded.model, tagged_at = datetime('now')")
        .bind(item.kind, item.id, item.hash || null, model)
    );
  }
  if (stmts.length) await db.batch(stmts);
}
