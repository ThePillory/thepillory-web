-- Promises from more kinds of source: a meeting video (with the time in the
-- video), an interview, and the official's campaign or office website's
-- "Issues" or "Priorities" page. Promises can also be added by a person on
-- /admin/review/ (already approved, with their name). See docs/promises.md.
--
-- SQLite can't change a CHECK constraint, so promises is rebuilt with the
-- same rows. promise_status_changes points at promises(id), so its rows are
-- set aside first and put back after (dropping a table that rows point at
-- fails, even with deferred foreign keys).
CREATE TABLE promise_status_changes_keep AS SELECT * FROM promise_status_changes;
DROP TABLE promise_status_changes;

CREATE TABLE promises_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  official_id   TEXT NOT NULL REFERENCES officials(id),
  quote         TEXT NOT NULL,                -- word for word from the source
  quote_key     TEXT NOT NULL,                -- the quote normalized (lowercase, letters and digits), for duplicates
  made_on       TEXT NOT NULL,                -- ISO date the official said or published it
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  source_title  TEXT NOT NULL,                -- the document's own title
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('press_release', 'address', 'minutes', 'agenda', 'meeting_video', 'interview', 'campaign_site', 'office_site')),
  source_time   TEXT,                         -- where in a video or recording it's said, as h:mm:ss
  check_note    TEXT NOT NULL DEFAULT '',     -- plain, neutral: what would show it done ("A signed law that …")
  due           TEXT,                         -- a deadline only when the quote states one, as stated
  review        TEXT NOT NULL DEFAULT 'suggested' CHECK (review IN ('suggested', 'approved', 'rejected')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  reject_reason TEXT,
  status        TEXT NOT NULL DEFAULT 'no_action' CHECK (status IN ('no_action', 'in_progress', 'kept', 'broken')),
  suggested_by  TEXT NOT NULL,                -- the model, or "Added by <name>"
  prompt_version TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (official_id, quote_key)
);
INSERT INTO promises_new (id, official_id, quote, quote_key, made_on, source_url, source_title, source_kind, check_note, due, review, reviewed_by, reviewed_at, reject_reason, status, suggested_by, prompt_version, created_at)
  SELECT id, official_id, quote, quote_key, made_on, source_url, source_title, source_kind, check_note, due, review, reviewed_by, reviewed_at, reject_reason, status, suggested_by, prompt_version, created_at FROM promises;
DROP TABLE promises;
ALTER TABLE promises_new RENAME TO promises;
CREATE INDEX IF NOT EXISTS promises_official ON promises (official_id, review, made_on);
CREATE INDEX IF NOT EXISTS promises_review ON promises (review, created_at);

CREATE TABLE promise_status_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promise_id   INTEGER NOT NULL REFERENCES promises(id),
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL CHECK (to_status IN ('no_action', 'in_progress', 'kept', 'broken')),
  evidence     TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  evidence_on  TEXT NOT NULL,                 -- ISO date of the evidence
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  recorded_by  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO promise_status_changes (id, promise_id, from_status, to_status, evidence, evidence_on, source_url, recorded_by, recorded_at)
  SELECT id, promise_id, from_status, to_status, evidence, evidence_on, source_url, recorded_by, recorded_at FROM promise_status_changes_keep;
DROP TABLE promise_status_changes_keep;
CREATE INDEX IF NOT EXISTS promise_status_changes_promise ON promise_status_changes (promise_id, recorded_at);

-- Campaign and office websites' "Issues" or "Priorities" pages, entered on
-- /admin/review/ by a person (never guessed). The sync fetches each weekly and
-- sends it to be read again only when its text changes.
CREATE TABLE IF NOT EXISTS promise_pages (
  url          TEXT PRIMARY KEY CHECK (url LIKE 'http%'),
  official_id  TEXT NOT NULL REFERENCES officials(id),
  kind         TEXT NOT NULL CHECK (kind IN ('campaign_site', 'office_site')),
  title        TEXT NOT NULL,                 -- as the person entered it, e.g. "Issues"
  added_by     TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  fetched_at   TEXT,
  text_hash    TEXT,                          -- of the page's text when last fetched
  note         TEXT                           -- the last fetch's result
);
