-- Scanned OGE Form 278-T reports, transcribed (docs/trades.md). A scanned
-- report's text layer is too poor to read, so it's read twice by AI from the
-- PDF, by two different models; code checks the two readings agree on every
-- row and against what the text layer does show; a person then compares the
-- agreed rows with the scan and approves them. Only then do the trades
-- publish, labeled "Transcribed from a scanned report · Checked by [name]".
-- Anything that doesn't agree stays a link to the report. Never guessed.
ALTER TABLE trade_reports ADD COLUMN transcribed_by TEXT;   -- the person who checked the transcription
ALTER TABLE trade_reports ADD COLUMN transcribed_at TEXT;

CREATE TABLE IF NOT EXISTS trade_scans (
  report_id      TEXT PRIMARY KEY,             -- trade_reports.id ('oge:<hash>')
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'agreed', 'disagree', 'approved', 'rejected')),
  text_rows      INTEGER NOT NULL DEFAULT 0,   -- rows the text layer shows (trade_scan_lines)
  reading        TEXT,                         -- JSON: the rows both readings agree on
  problems       TEXT,                         -- JSON: what didn't agree, row by row
  models         TEXT,                         -- the two models that read it
  read_at        TEXT,
  reviewed_by    TEXT,
  reviewer_email TEXT,
  reviewed_at    TEXT,
  reject_reason  TEXT,
  queued_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS trade_scans_status ON trade_scans (status, queued_at);

-- The report's own text layer, one numbered row each, as pdftotext reads it
-- (often garbled on a scan): the independent check on the AI readings.
CREATE TABLE IF NOT EXISTS trade_scan_lines (
  report_id  TEXT NOT NULL,
  n          INTEGER NOT NULL,
  line       TEXT NOT NULL,
  PRIMARY KEY (report_id, n)
);
