-- Stock trades by the President, Vice President and Cabinet: OGE Form 278-T
-- (docs/trades.md). trade_reports gains the executive branch, the request
-- link for reports OGE releases only on request (Form 201), and the filer's
-- position and agency as OGE lists them. A request-only report has no
-- document link and its contents are never guessed.
CREATE TABLE trade_reports_new (
  id           TEXT PRIMARY KEY,            -- 'house:20026789', 'senate:<uuid>', 'oge:<hash>'
  chamber      TEXT NOT NULL CHECK (chamber IN ('us-house', 'us-senate', 'us-executive')),
  official_id  TEXT,
  filer_name   TEXT NOT NULL,
  state        TEXT,
  district     TEXT,
  filed_on     TEXT NOT NULL,
  report_url   TEXT CHECK (report_url IS NULL OR report_url LIKE 'http%'),
  paper        INTEGER NOT NULL DEFAULT 0,
  parsed       INTEGER NOT NULL DEFAULT 0,
  trade_count  INTEGER NOT NULL DEFAULT 0,
  unmatched    TEXT,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now')),
  request_url  TEXT CHECK (request_url IS NULL OR request_url LIKE 'http%'),  -- OGE: released only on request
  position     TEXT,                        -- OGE: the position the report was filed for
  agency       TEXT                         -- OGE: the agency
);
INSERT INTO trade_reports_new (id, chamber, official_id, filer_name, state, district, filed_on, report_url, paper, parsed, trade_count, unmatched, source_url, checked_at)
  SELECT id, chamber, official_id, filer_name, state, district, filed_on, report_url, paper, parsed, trade_count, unmatched, source_url, checked_at FROM trade_reports;
DROP TABLE trade_reports;
ALTER TABLE trade_reports_new RENAME TO trade_reports;
CREATE INDEX IF NOT EXISTS trade_reports_official ON trade_reports (official_id, filed_on);
CREATE INDEX IF NOT EXISTS trade_reports_filed ON trade_reports (filed_on);
