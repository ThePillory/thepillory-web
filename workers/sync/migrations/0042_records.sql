-- Public Records & Investigations (docs/records-tab-spec.md, §5). Phase 1: the
-- tables only; nothing writes to them yet and no page reads them. Every table
-- is prefixed records_ so it can't collide with the site's own (corrections,
-- statements). Every dataset, document and statement carries an http(s) link
-- to its government-hosted or published source, as everywhere on the site.
-- The non-negotiable rules (spec §2) are enforced in code and review, not
-- only here: victim identities are never stored, redactions stay redacted,
-- and nothing at Tier 2 or above is published without a person's review.

-- One row per investigation or collection ('epstein-doj')
CREATE TABLE IF NOT EXISTS records_datasets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  description TEXT
);

-- People tracked, each linked to their official profile
CREATE TABLE IF NOT EXISTS records_subjects (
  id           TEXT PRIMARY KEY,
  official_id  TEXT NOT NULL REFERENCES officials(id),
  display_name TEXT NOT NULL,
  in_scope     INTEGER NOT NULL DEFAULT 1 CHECK (in_scope IN (0, 1))
);

-- Names and variants used for matching ("Gates, William", initials, an email)
CREATE TABLE IF NOT EXISTS records_subject_aliases (
  subject_id TEXT NOT NULL REFERENCES records_subjects(id),
  alias      TEXT NOT NULL,
  alias_type TEXT CHECK (alias_type IS NULL OR alias_type IN ('full', 'surname', 'initials', 'email', 'nickname')),
  ambiguity  TEXT NOT NULL DEFAULT 'low' CHECK (ambiguity IN ('low', 'high')),  -- high: always reviewed
  PRIMARY KEY (subject_id, alias)
);

-- One row per unique document (after dedupe; duplicates point at their canonical copy)
CREATE TABLE IF NOT EXISTS records_documents (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL REFERENCES records_datasets(id),
  bates_id         TEXT,                      -- e.g. EFTA02365899
  r2_key           TEXT NOT NULL,             -- the original file
  text_r2_key      TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('court_filing', 'deposition', 'law_enforcement_report', 'flight_log',
                     'contact_book', 'calendar', 'email_by_subject', 'email_to_subject', 'email_about_subject',
                     'financial_record', 'news_clipping', 'photo_or_media', 'other')),
  doc_date         TEXT,                      -- ISO date
  date_confidence  TEXT CHECK (date_confidence IS NULL OR date_confidence IN ('exact', 'inferred', 'unknown')),
  canonical_doc_id TEXT REFERENCES records_documents(id),
  restricted       INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),  -- 1: never shown publicly
  original_url     TEXT NOT NULL CHECK (original_url LIKE 'http%')           -- the government-hosted copy
);
CREATE INDEX IF NOT EXISTS records_documents_dataset ON records_documents (dataset_id, restricted);

-- A subject appearing in a document
CREATE TABLE IF NOT EXISTS records_mentions (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES records_documents(id),
  subject_id       TEXT NOT NULL REFERENCES records_subjects(id),
  role             TEXT NOT NULL CHECK (role IN ('author', 'recipient', 'cc', 'subject_of', 'listed', 'passenger', 'party')),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 300),   -- redactions preserved
  page             INTEGER,
  match_confidence REAL NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
  ai_tier          INTEGER CHECK (ai_tier IS NULL OR ai_tier BETWEEN 1 AND 5),  -- the model's suggestion
  ai_rationale     TEXT,                                                       -- internal only, never public
  tier             INTEGER CHECK (tier IS NULL OR tier BETWEEN 1 AND 5),       -- confirmed; null until reviewed if 2+
  review_status    TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'needs_info')),
  reviewed_by      TEXT,
  reviewed_at      TEXT,
  -- Tier 2 and above is published only after a person's review (spec §2.2)
  CHECK (NOT (review_status = 'approved' AND tier >= 2 AND reviewed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS records_mentions_subject ON records_mentions (subject_id, review_status);
CREATE INDEX IF NOT EXISTS records_mentions_document ON records_mentions (document_id);

-- The subject's own public statements about the matter, quoted verbatim
CREATE TABLE IF NOT EXISTS records_statements (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES records_subjects(id),
  dataset_id  TEXT NOT NULL REFERENCES records_datasets(id),
  quote       TEXT NOT NULL,
  stated_at   TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%')
);

-- The public corrections log: what changed and when, never who asked
CREATE TABLE IF NOT EXISTS records_corrections (
  id         TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES records_subjects(id),
  mention_id TEXT REFERENCES records_mentions(id),
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status     TEXT NOT NULL CHECK (status IN ('received', 'reviewing', 'corrected', 'declined'))
);

-- When a person last reviewed a subject's records in a dataset
CREATE TABLE IF NOT EXISTS records_profile_reviews (
  subject_id       TEXT NOT NULL REFERENCES records_subjects(id),
  dataset_id       TEXT NOT NULL REFERENCES records_datasets(id),
  last_reviewed_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, dataset_id)
);
