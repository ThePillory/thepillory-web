-- Scanned 278-T transcriptions are judged row by row (src/trades/scan-check.js;
-- docs/trades.md): rows both AI readings agree on publish, the rest stay
-- linked to the scan. Long reports are read in chunks of rows, kept here so a
-- reading can resume in the next round.
ALTER TABLE trade_scans ADD COLUMN rows_total INTEGER;      -- rows in the report, as read
ALTER TABLE trade_scans ADD COLUMN unread TEXT;             -- JSON [{n, reason}]: rows not published
ALTER TABLE trade_scans ADD COLUMN error TEXT;              -- the last error reading it, if any
ALTER TABLE trade_scans ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_reports ADD COLUMN rows_total INTEGER;    -- a transcribed scan's row count
ALTER TABLE trade_reports ADD COLUMN unread_rows TEXT;      -- JSON [n, ...]: its rows not published

CREATE TABLE IF NOT EXISTS trade_scan_chunks (
  report_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  first_n    INTEGER NOT NULL,                 -- the chunk asked for rows first_n to last_n
  last_n     INTEGER NOT NULL,
  reading    TEXT NOT NULL,                    -- JSON {rows: [...]}, as the model answered
  read_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, model, first_n)
);
