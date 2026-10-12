// Writing a transcribed scanned 278-T into trades, and taking it down again
// (docs/trades.md). Pure: returns [{sql, binds}] for db.batch, so the sync
// Worker (publishing) and the admin page (taking down) share it.
import { summaryStatements } from "./summary.js";

/** Publish the agreed rows of report `r` ({id, official_id, chamber, state, filed_on}). */
export function publishStatements(r, rows) {
  return [
    { sql: "DELETE FROM trades WHERE report_id = ?", binds: [r.id] },
    ...rows.map((t) => ({
      sql: `INSERT INTO trades (report_id, n, official_id, chamber, state, transaction_date, filed_on, days_to_file, owner, asset_name, ticker, asset_type, type, amount, amount_min, amount_max, sic, sector)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, (SELECT sic FROM sec_tickers WHERE ticker = ?), (SELECT sector FROM sec_tickers WHERE ticker = ?))`,
      binds: [r.id, t.n, r.official_id, r.chamber, r.state ?? null, t.date, r.filed_on, t.owner ?? null, t.description, t.ticker ?? null, t.type, t.amount, t.amount_min ?? null, t.amount_max ?? null, t.ticker ?? null, t.ticker ?? null],
    })),
    { sql: "UPDATE trade_reports SET parsed = 1, trade_count = ?, transcribed_by = NULL, transcribed_at = datetime('now') WHERE id = ?", binds: [rows.length, r.id] },
    ...summaryStatements([r.official_id]),
  ];
}

/** Take a published transcription down: the report is a link again. */
export function takeDownStatements(r) {
  return [
    { sql: "DELETE FROM trades WHERE report_id = ?", binds: [r.id] },
    { sql: "UPDATE trade_reports SET parsed = 0, trade_count = 0, transcribed_by = NULL, transcribed_at = NULL, rows_total = NULL, unread_rows = NULL WHERE id = ?", binds: [r.id] },
    ...summaryStatements([r.official_id]),
  ];
}
