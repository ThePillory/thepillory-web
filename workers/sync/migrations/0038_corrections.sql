-- "Report an error" (/corrections/, linked from every page's footer): what a
-- reader says is wrong on a page, and a source if they have one. No name,
-- email or address is asked for or kept; the visitor is counted only as a
-- daily-rotating hash (correction_attempts) for the daily limit. A person
-- reads each report on /admin/corrections/ and records what was done.
CREATE TABLE IF NOT EXISTS corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT NOT NULL,                  -- the path on the site, e.g. /reps/example/
  what        TEXT NOT NULL,                  -- what's wrong, as the reader wrote it
  source_url  TEXT CHECK (source_url IS NULL OR source_url LIKE 'http%'),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'not_an_error', 'duplicate')),
  note        TEXT,                           -- what the reviewer did, or why not
  resolved_by TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS corrections_status ON corrections (status, created_at);
CREATE TABLE IF NOT EXISTS correction_attempts (
  visitor    TEXT NOT NULL,                   -- daily-rotating hash, never the address itself
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS correction_attempts_visitor ON correction_attempts (visitor, created_at);
