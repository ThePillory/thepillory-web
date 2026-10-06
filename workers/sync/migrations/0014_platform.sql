-- The Platform tab (formerly Promises): "In their own words" above
-- "Commitments tracked". See docs/promises.md.
--
-- 1. A short excerpt, word for word, from each listed Issues or Priorities page
--    (promise_pages), refreshed monthly. The AI picks it and code checks it's on
--    the page word for word; a person can choose a different one or hide it.
ALTER TABLE promise_pages ADD COLUMN page_text TEXT;         -- the page's text when last fetched, for checking excerpts
ALTER TABLE promise_pages ADD COLUMN excerpt TEXT;           -- word for word from the page
ALTER TABLE promise_pages ADD COLUMN excerpt_at TEXT;        -- when it was taken (the page "as of")
ALTER TABLE promise_pages ADD COLUMN excerpt_by TEXT;        -- the model, a person's name, or 'hidden'

-- 2. Statements an official (or their office) sends in, shown word for word,
--    labeled "Submitted by the official". Recorded on /admin/review/ by a person,
--    with how it arrived (kept here, not shown); officials' own logins come later.
CREATE TABLE IF NOT EXISTS official_statements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  official_id  TEXT NOT NULL REFERENCES officials(id),
  title        TEXT,
  body         TEXT NOT NULL CHECK (length(trim(body)) > 0),  -- exactly as submitted
  submitted_on TEXT NOT NULL,                                  -- ISO date the office sent it
  received_via TEXT NOT NULL,                                  -- e.g. "email from the office's official address"; not public
  source_url   TEXT CHECK (source_url IS NULL OR source_url LIKE 'http%'), -- where the office also published it, if anywhere
  recorded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at   TEXT,                                           -- withdrawn by the office, or removed; kept, not shown
  removed_note TEXT
);
CREATE INDEX IF NOT EXISTS official_statements_official ON official_statements (official_id, removed_at, submitted_on);
