-- The Pillory: officials, bills, and voting records.
--
-- Rule: every record keeps a source URL, and nothing is shown without one.
-- The CHECK constraints below make a row without an http(s) source impossible.

CREATE TABLE IF NOT EXISTS officials (
  id            TEXT PRIMARY KEY,          -- 'bioguide:X000000', 'openstates:ocd-person/…', 'county:d1'
  slug          TEXT NOT NULL UNIQUE,      -- URL slug, e.g. 'jane-doe'
  name          TEXT NOT NULL,
  last_name     TEXT,                      -- used to match senate.gov roll call XML, which lists last names
  office        TEXT NOT NULL,             -- 'U.S. Senator', 'U.S. Representative', 'State Assemblymember', …
  level         TEXT NOT NULL CHECK (level IN ('county', 'state', 'federal')),
  chamber       TEXT NOT NULL CHECK (chamber IN ('us-senate', 'us-house', 'ca-senate', 'ca-assembly', 'county-board')),
  body          TEXT NOT NULL,             -- body slug, e.g. 'us-senate', 'state-legislature', 'board-of-supervisors'
  district      TEXT,                      -- 'CA-5', 'Assembly District 8', 'District 1'; NULL for statewide
  party         TEXT,                      -- plain text, exactly as the source gives it; NULL if none (e.g. nonpartisan office)
  term_start    TEXT,                      -- ISO date or year as given by the source; NULL if the source doesn't say
  term_end      TEXT,
  website       TEXT,
  photo_url     TEXT,
  photo_credit  TEXT,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  last_verified TEXT NOT NULL,             -- ISO date the record was last confirmed against the source
  bioguide_id   TEXT,                      -- Congress.gov / Bioguide ID (federal)
  lis_id        TEXT,                      -- Senate LIS member ID, learned from senate.gov roll call XML
  openstates_id TEXT,                      -- ocd-person ID (state)
  active        INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id           TEXT PRIMARY KEY,           -- 'us-119-hr-1234', 'ca-20252026-ab-123'
  level        TEXT NOT NULL CHECK (level IN ('state', 'federal')),
  chamber      TEXT NOT NULL,              -- chamber of origin: 'us-house', 'us-senate', 'ca-assembly', 'ca-senate'
  bill_number  TEXT NOT NULL,              -- as displayed: 'H.R. 1234', 'AB 123'
  session      TEXT NOT NULL,              -- '119' (Congress) or '20252026' (CA session)
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',   -- plain-language summary; blank until written by a person
  official_url TEXT,                       -- congress.gov / leginfo.legislature.ca.gov page
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id         TEXT PRIMARY KEY,             -- 'us-house-119-1-123', 'us-senate-119-1-45', 'ca-<openstates vote id>'
  bill_id    TEXT REFERENCES bills(id),    -- NULL for votes not on a bill (nominations, amendments without a bill link)
  subject    TEXT,                         -- what was voted on when there is no bill, e.g. 'PN 123: nomination of …'
  level      TEXT NOT NULL CHECK (level IN ('state', 'federal')),
  chamber    TEXT NOT NULL,                -- where the vote happened
  vote_date  TEXT NOT NULL,                -- ISO date (YYYY-MM-DD)
  question   TEXT NOT NULL,                -- the exact question, e.g. 'On Passage', 'On Motion to Recommit'
  vote_type  TEXT NOT NULL CHECK (vote_type IN ('final_passage', 'procedural', 'amendment', 'nomination', 'committee', 'other')),
  result     TEXT NOT NULL,                -- as the source states it, e.g. 'Passed', 'Failed', 'Agreed to'
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS votes_bill ON votes(bill_id);
CREATE INDEX IF NOT EXISTS votes_date ON votes(vote_date);

CREATE TABLE IF NOT EXISTS vote_positions (
  vote_id      TEXT NOT NULL REFERENCES votes(id),
  official_id  TEXT NOT NULL REFERENCES officials(id),
  position     TEXT NOT NULL CHECK (position IN ('Yes', 'No', 'Present', 'Not voting')),
  raw_position TEXT NOT NULL,              -- exactly as the source recorded it ('Yea', 'Aye', 'abstain', …)
  PRIMARY KEY (vote_id, official_id)
);
CREATE INDEX IF NOT EXISTS positions_official ON vote_positions(official_id);

-- Links between sample/real issues and bills. Never created automatically:
-- every link starts as 'suggested' and is shown only once 'approved'.
CREATE TABLE IF NOT EXISTS issue_bill_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_slug  TEXT NOT NULL,
  bill_id     TEXT NOT NULL REFERENCES bills(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved')),
  approved_by TEXT,
  approved_at TEXT,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issue_slug, bill_id),
  CHECK (status = 'suggested' OR approved_by IS NOT NULL)
);

-- Sync bookkeeping: cursors, daily request budgets, cached settings.
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per sync step per run. Errors are logged here, never swallowed.
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  trigger     TEXT NOT NULL,               -- 'cron' or 'manual'
  step        TEXT NOT NULL,               -- 'federal-officials', 'house-votes', …
  status      TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'error', 'skipped')),
  requests    INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_log_run ON sync_log(run_id);
