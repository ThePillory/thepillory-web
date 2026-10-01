// Saving a meeting's agenda items (both county sources).

export async function saveItems(db, meetingId, fileId, parsed) {
  // A page with no items (agenda not posted yet) never erases items already saved.
  const stmts = parsed.items.length ? [db.prepare("DELETE FROM meeting_items WHERE meeting_id = ?").bind(meetingId)] : [];
  for (const it of parsed.items) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO meeting_items (meeting_id, item_key, number, title, section, section_kind, item_url, staff_report_url, attachments, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(meetingId, it.item_key, it.number, it.title, it.section, it.section_kind, it.item_url, it.staff_report_url, JSON.stringify(it.attachments), it.sort)
    );
  }
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
