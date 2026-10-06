-- Promises: specific, checkable commitments by an official, quoted exactly,
-- with the date and the source. See docs/promises.md.
--
-- The AI step (src/promises/) proposes candidates as 'suggested'; nothing is
-- public until a person approves it on /admin/review/. Every status change
-- after that is a row in promise_status_changes, with evidence and a source.

CREATE TABLE IF NOT EXISTS promises (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  official_id   TEXT NOT NULL REFERENCES officials(id),
  quote         TEXT NOT NULL,                -- word for word from the source
  quote_key     TEXT NOT NULL,                -- the quote normalized (lowercase, letters and digits), for duplicates
  made_on       TEXT NOT NULL,                -- ISO date the official said or published it
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  source_title  TEXT NOT NULL,                -- the document's own title
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('press_release', 'address', 'minutes', 'agenda')),
  check_note    TEXT NOT NULL DEFAULT '',     -- plain, neutral: what would show it done ("A signed law that …")
  due           TEXT,                         -- a deadline only when the quote states one, as stated
  review        TEXT NOT NULL DEFAULT 'suggested' CHECK (review IN ('suggested', 'approved', 'rejected')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  reject_reason TEXT,
  status        TEXT NOT NULL DEFAULT 'no_action' CHECK (status IN ('no_action', 'in_progress', 'kept', 'broken')),
  suggested_by  TEXT NOT NULL,                -- the model, or a person's email
  prompt_version TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (official_id, quote_key)
);
CREATE INDEX IF NOT EXISTS promises_official ON promises (official_id, review, made_on);
CREATE INDEX IF NOT EXISTS promises_review ON promises (review, created_at);

-- Every status change, kept: the evidence, its source, and who recorded it.
CREATE TABLE IF NOT EXISTS promise_status_changes (
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
CREATE INDEX IF NOT EXISTS promise_status_changes_promise ON promise_status_changes (promise_id, recorded_at);

-- Each source document read once (again only if it changes), and what came of it.
CREATE TABLE IF NOT EXISTS promise_sources (
  url          TEXT PRIMARY KEY,
  official_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  published_on TEXT,
  text         TEXT,                          -- the document's text, kept until it's read (then cleared)
  content_hash TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'skipped', 'failed')),
  found        INTEGER NOT NULL DEFAULT 0,    -- candidates proposed from it
  note         TEXT,
  read_at      TEXT,
  first_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS promise_sources_status ON promise_sources (status, published_on);
