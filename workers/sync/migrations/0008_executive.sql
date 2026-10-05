-- The executive branch: the President, Vice President and Cabinet; California's
-- Governor and the other statewide elected offices. What they do in office:
-- executive orders, bills signed and vetoed, nominations. Every row has a source.

-- officials.chamber gains the executive branches, and `rank` orders offices
-- within one (President first). SQLite can't change a CHECK in place, so the
-- table is rebuilt under the same name: the rows are copied aside, the old table
-- emptied and dropped, and the rows inserted into the new one. Re-inserting
-- them settles the deferred foreign-key checks (votes and funding rows point at
-- officials) before the batch commits.
PRAGMA defer_foreign_keys = on;

CREATE TABLE officials_copy AS SELECT * FROM officials;
DELETE FROM officials;
DROP TABLE officials;

CREATE TABLE officials (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  last_name     TEXT,
  office        TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('county', 'state', 'federal')),
  chamber       TEXT NOT NULL CHECK (chamber IN ('us-senate', 'us-house', 'ca-senate', 'ca-assembly', 'county-board', 'us-executive', 'ca-executive')),
  body          TEXT NOT NULL,
  district      TEXT,
  party         TEXT,
  term_start    TEXT,
  term_end      TEXT,
  website       TEXT,
  photo_url     TEXT,
  photo_credit  TEXT,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  last_verified TEXT NOT NULL,
  bioguide_id   TEXT,
  lis_id        TEXT,
  openstates_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  state         TEXT,
  district_code TEXT,
  detail_checked TEXT,
  rank          INTEGER                    -- order within an executive branch: 1 = President / Governor
);

INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party, term_start, term_end,
  website, photo_url, photo_credit, source_url, last_verified, bioguide_id, lis_id, openstates_id, active, updated_at,
  state, district_code, detail_checked)
SELECT id, slug, name, last_name, office, level, chamber, body, district, party, term_start, term_end,
  website, photo_url, photo_credit, source_url, last_verified, bioguide_id, lis_id, openstates_id, active, updated_at,
  state, district_code, detail_checked
FROM officials_copy;

DROP TABLE officials_copy;
CREATE INDEX IF NOT EXISTS officials_state ON officials (chamber, state, district_code);

-- Executive orders: the Federal Register (President) and the Governor's Office (Governor).
CREATE TABLE IF NOT EXISTS executive_actions (
  id           TEXT PRIMARY KEY,           -- 'fr:2026-20321' (Federal Register document number), 'ca-gov:<post id>'
  official_id  TEXT NOT NULL,              -- who issued it (officials.id)
  kind         TEXT NOT NULL CHECK (kind IN ('executive_order', 'proclamation', 'other')),
  number       TEXT,                       -- '14434', 'N-12-26'; NULL if the source doesn't give one
  title        TEXT NOT NULL,              -- exactly as published
  signed_on    TEXT,                       -- ISO date signed, if the source says
  published_on TEXT,                       -- ISO date published
  citation     TEXT,                       -- '91 FR 63129'
  document_url TEXT,                       -- the order itself (PDF), when linked
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS executive_actions_official ON executive_actions (official_id, signed_on);

-- A bill's final outcome: signed, vetoed, law without signature, law over a veto,
-- or presented and awaiting action. One row per bill; actor_name is whoever held
-- the office on that date, from the source.
CREATE TABLE IF NOT EXISTS bill_outcomes (
  bill_id      TEXT PRIMARY KEY,
  outcome      TEXT NOT NULL CHECK (outcome IN ('presented', 'signed', 'vetoed', 'pocket_vetoed', 'without_signature', 'over_veto', 'became_law')),
  action_date  TEXT NOT NULL,              -- ISO date of that action
  presented_on TEXT,
  law_number   TEXT,                       -- 'Public Law 119-21', 'Chapter 472, Statutes of 2025'
  action_text  TEXT NOT NULL,              -- the action exactly as recorded
  actor_id     TEXT,                       -- officials.id of the President or Governor, when on ThePillory
  actor_name   TEXT,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bill_outcomes_actor ON bill_outcomes (actor_id, action_date);

-- When each bill's outcome was last looked up (also for bills with no outcome yet).
CREATE TABLE IF NOT EXISTS bill_outcome_checks (
  bill_id    TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  final      INTEGER NOT NULL DEFAULT 0       -- 1 once signed, vetoed and not overridable, or law
);

-- Nominations the President sent to the Senate (civilian), from Congress.gov.
CREATE TABLE IF NOT EXISTS nominations (
  id            TEXT PRIMARY KEY,          -- 'PN1180-2'
  congress      INTEGER NOT NULL,
  official_id   TEXT,                      -- the President who sent it
  description   TEXT NOT NULL,             -- exactly as Congress.gov gives it
  organization  TEXT,
  received_on   TEXT,
  latest_action TEXT,
  latest_on     TEXT,
  status        TEXT CHECK (status IN ('confirmed', 'withdrawn', 'returned', 'failed', 'pending')),
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS nominations_received ON nominations (official_id, received_on);
