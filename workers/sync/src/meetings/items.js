import { syncScope } from "../upsert.js";
// Saving a meeting's agenda items (both county sources).

export async function saveItems(db, meetingId, fileId, parsed) {
  // A page with no items (agenda not posted yet) never erases items already saved. Only items
  // that are new, changed or gone are written (src/db.js syncScope).
  const stmts = parsed.items.length
    ? (
        await syncScope(db, {
          table: "meeting_items",
          scope: { meeting_id: meetingId },
          key: ["item_key"],
          cols: ["item_key", "number", "title", "section", "section_kind", "item_url", "staff_report_url", "attachments", "sort"],
          rows: parsed.items.map((it) => ({ ...it, attachments: JSON.stringify(it.attachments) })),
        })
      ).stmts
    : [];
  stmts.push(
    db
      .prepare(
        `UPDATE meetings SET details_checked_at = datetime('now'), details_file_id = ?, agenda_file_id = COALESCE(?, agenda_file_id),
           agenda_url = COALESCE(?, agenda_url), packet_url = COALESCE(?, packet_url) WHERE id = ?`
      )
      .bind(fileId, parsed.agenda_file_id, parsed.agenda_url, parsed.packet_url, meetingId)
  );
  await db.batch(stmts);
}
