-- "Net worth, as reported" from scanned reports (tools/networth_scan.py;
-- docs/funding.md "Net worth"): each asset and liability line read twice, by
-- two AI models, a few pages at a time (networth_scan_chunks, so a reading
-- resumes), then compared line by line in code (networth_scans). A report
-- whose readings agree on every line publishes into networth_reports with
-- method 'ai', labeled "Transcribed by AI from a scanned report,
-- auto-checked"; one that doesn't stays a link until a person settles each
-- line on /admin/review/networth/. A person can confirm a transcription
-- ("Checked by [name]") or take it down. Free: never sold or exported.
CREATE TABLE IF NOT EXISTS networth_scan_chunks (
  report_id     TEXT NOT NULL,                  -- networth_reports.id
  model         TEXT NOT NULL,
  first_page    INTEGER NOT NULL,               -- PDF page numbers, 1-based
  last_page     INTEGER NOT NULL,
  reading       TEXT NOT NULL,                  -- JSON {lines: [...]}
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_cents    INTEGER,
  read_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, model, first_page)
);
CREATE TABLE IF NOT EXISTS networth_scans (
  report_id     TEXT PRIMARY KEY,
  official_id   TEXT NOT NULL,
  report_url    TEXT NOT NULL CHECK (report_url LIKE 'http%'),
  year          INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('agreed', 'disagree', 'approved', 'rejected')),
  pages         TEXT,                           -- JSON: the PDF pages read, by section
  lines_total   INTEGER,
  disagreements TEXT,                           -- JSON: [{key, page, a, b}]
  reading       TEXT,                           -- JSON: the agreed lines (both readings, the same)
  problems      TEXT,                           -- JSON: [{kind: 'block'|'look', text}]
  models        TEXT,
  cost_cents    INTEGER,
  spot_check    INTEGER NOT NULL DEFAULT 0,
  read_at       TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by   TEXT,
  reviewer_email TEXT,
  reviewed_at   TEXT,
  reject_reason TEXT,
  settled       TEXT                            -- JSON: {key: value} a person chose for each disagreement
);
