-- Promises publish automatically once they pass the code checks, labeled
-- "AI-identified, auto-checked" (review = 'auto'); a person can confirm one
-- ('approved', "Reviewed by") or take it down ('rejected'). See docs/promises.md.
--
-- SQLite can't change a CHECK constraint, so promises is rebuilt with the same
-- rows, the way 0013 did: promise_status_changes points at promises(id), so its
-- rows are set aside first and put back after (with two new columns).
CREATE TABLE promise_status_changes_keep AS SELECT * FROM promise_status_changes;
DROP TABLE promise_status_changes;

CREATE TABLE promises_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  official_id   TEXT NOT NULL REFERENCES officials(id),
  quote         TEXT NOT NULL,                -- word for word from the source
  quote_key     TEXT NOT NULL,
  made_on       TEXT NOT NULL,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  source_title  TEXT NOT NULL,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('press_release', 'address', 'minutes', 'agenda', 'meeting_video', 'interview', 'campaign_site', 'office_site')),
  source_time   TEXT,
  check_note    TEXT NOT NULL DEFAULT '',
  due           TEXT,
  review        TEXT NOT NULL DEFAULT 'suggested' CHECK (review IN ('suggested', 'auto', 'approved', 'rejected')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  reject_reason TEXT,
  status        TEXT NOT NULL DEFAULT 'no_action' CHECK (status IN ('no_action', 'in_progress', 'kept', 'broken')),
  suggested_by  TEXT NOT NULL,
  prompt_version TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT,                         -- when it went public (auto-checked or approved)
  spot_check    INTEGER NOT NULL DEFAULT 0,   -- 1: picked at random for a person to look at
  check_reason  TEXT,                         -- why a suggestion didn't publish automatically
  UNIQUE (official_id, quote_key)
);
INSERT INTO promises_new (id, official_id, quote, quote_key, made_on, source_url, source_title, source_kind, source_time, check_note, due,
  review, reviewed_by, reviewed_at, reject_reason, status, suggested_by, prompt_version, created_at, published_at)
  SELECT id, official_id, quote, quote_key, made_on, source_url, source_title, source_kind, source_time, check_note, due,
    review, reviewed_by, reviewed_at, reject_reason, status, suggested_by, prompt_version, created_at,
    CASE WHEN review = 'approved' THEN COALESCE(reviewed_at, created_at) END
  FROM promises;
DROP TABLE promises;
ALTER TABLE promises_new RENAME TO promises;
CREATE INDEX IF NOT EXISTS promises_official ON promises (official_id, review, made_on);
CREATE INDEX IF NOT EXISTS promises_review ON promises (review, created_at);

-- auto = 1: recorded by the sync from evidence quoted word for word
-- (evidence_quote) in its source; In progress and Kept only.
CREATE TABLE promise_status_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  promise_id     INTEGER NOT NULL REFERENCES promises(id),
  from_status    TEXT NOT NULL,
  to_status      TEXT NOT NULL CHECK (to_status IN ('no_action', 'in_progress', 'kept', 'broken')),
  evidence       TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  evidence_on    TEXT NOT NULL,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  recorded_by    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  auto           INTEGER NOT NULL DEFAULT 0,
  evidence_quote TEXT
);
INSERT INTO promise_status_changes (id, promise_id, from_status, to_status, evidence, evidence_on, source_url, recorded_by, recorded_at)
  SELECT id, promise_id, from_status, to_status, evidence, evidence_on, source_url, recorded_by, recorded_at FROM promise_status_changes_keep;
DROP TABLE promise_status_changes_keep;
CREATE INDEX IF NOT EXISTS promise_status_changes_promise ON promise_status_changes (promise_id, recorded_at);

-- "Broken" waits for a person: the AI's suggestion, with its evidence.
CREATE TABLE IF NOT EXISTS promise_status_suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  promise_id     INTEGER NOT NULL REFERENCES promises(id),
  from_status    TEXT NOT NULL,
  to_status      TEXT NOT NULL CHECK (to_status IN ('in_progress', 'kept', 'broken')),
  evidence       TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  evidence_quote TEXT,
  evidence_on    TEXT NOT NULL,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  suggested_by   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by     TEXT,
  decided_at     TEXT,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (promise_id, to_status, source_url)
);
CREATE INDEX IF NOT EXISTS promise_status_suggestions_pending ON promise_status_suggestions (status, created_at);

-- "Something wrong?" on a published promise. No account; the visitor is a
-- daily-rotating hash kept only in public_actions for the daily limit.
CREATE TABLE IF NOT EXISTS promise_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  promise_id  INTEGER NOT NULL REFERENCES promises(id),
  reason      TEXT NOT NULL CHECK (reason IN ('not_a_promise', 'misquoted', 'wrong_status', 'unfair', 'other')),
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution  TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS promise_flags_open ON promise_flags (promise_id, status);
