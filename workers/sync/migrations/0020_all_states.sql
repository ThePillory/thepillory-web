-- Every state's legislators and executive officers, and their votes. See docs/states.md.
--
-- 1. officials.chamber gains every state's chambers ('tx-upper', 'tx-lower',
--    'ne-legislature', 'tx-executive'; California keeps 'ca-senate',
--    'ca-assembly', 'ca-executive'), and officials gain `k`, the short integer
--    key state vote positions are stored under. SQLite can't change a CHECK in
--    place, so the table is rebuilt under the same name, as 0008 did: rows
--    copied aside, the table emptied and dropped, created again and filled
--    with the same rows, which settles the deferred foreign-key checks. Every
--    table that points at officials has an index on official_id, so the checks
--    are lookups, not scans.
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
  chamber       TEXT NOT NULL CHECK (
                  chamber IN ('us-senate', 'us-house', 'ca-senate', 'ca-assembly', 'county-board', 'us-executive', 'ca-executive')
                  OR chamber GLOB '[a-z][a-z]-upper' OR chamber GLOB '[a-z][a-z]-lower'
                  OR chamber GLOB '[a-z][a-z]-legislature' OR chamber GLOB '[a-z][a-z]-executive'),
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
  rank          INTEGER,
  k             INTEGER UNIQUE              -- stableKey(id), for state_positions; set by the state loaders
);

INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party, term_start, term_end,
  website, photo_url, photo_credit, source_url, last_verified, bioguide_id, lis_id, openstates_id, active, updated_at,
  state, district_code, detail_checked, rank)
SELECT id, slug, name, last_name, office, level, chamber, body, district, party, term_start, term_end,
  website, photo_url, photo_credit, source_url, last_verified, bioguide_id, lis_id, openstates_id, active, updated_at,
  state, district_code, detail_checked, rank
FROM officials_copy;

DROP TABLE officials_copy;
CREATE INDEX IF NOT EXISTS officials_state ON officials (chamber, state, district_code);
CREATE INDEX IF NOT EXISTS officials_by_state ON officials (state, active, chamber);

-- 2. State vote positions, compactly: two integer keys and a code per row
--    (about 25 bytes with its index, against about 320 in vote_positions with
--    Open States' long ids), so every state's roll calls fit in one database.
--    California and Congress keep vote_positions. `raw` is the position exactly
--    as the source recorded it, kept only when it isn't the usual word.
ALTER TABLE votes ADD COLUMN k INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS votes_k ON votes (k) WHERE k IS NOT NULL;

CREATE TABLE IF NOT EXISTS state_positions (
  vote_k   INTEGER NOT NULL,                -- votes.k
  member_k INTEGER NOT NULL,                -- officials.k
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),  -- 0 Yes, 1 No, 2 Present, 3 Not voting
  raw      TEXT,
  PRIMARY KEY (vote_k, member_k)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS state_positions_member ON state_positions (member_k, vote_k);

-- Every position, wherever it's stored: the pages read this.
CREATE VIEW IF NOT EXISTS all_positions AS
  SELECT vote_id, official_id, position, raw_position FROM vote_positions
  UNION ALL
  SELECT v.id AS vote_id, o.id AS official_id,
    CASE p.position WHEN 0 THEN 'Yes' WHEN 1 THEN 'No' WHEN 2 THEN 'Present' ELSE 'Not voting' END AS position,
    COALESCE(p.raw, CASE p.position WHEN 0 THEN 'yes' WHEN 1 THEN 'no' WHEN 2 THEN 'present' ELSE 'not voting' END) AS raw_position
  FROM state_positions p JOIN votes v ON v.k = p.vote_k JOIN officials o ON o.k = p.member_k;

-- The bill list knows each state bill's state (the first two letters of its id:
-- 'ca-20252026-ab-1', 'tx-89-hb-1'), so a page lists one state's bills.
ALTER TABLE bill_list ADD COLUMN st TEXT;
-- Rows built before this migration: state bills were California's.
UPDATE bill_list SET st = upper(substr(bill_id, 1, 2)) WHERE level = 'state';
CREATE INDEX IF NOT EXISTS bill_list_state ON bill_list (st, last_final);

-- 3. Which states to load first: lookups of reps by state (counts only: no
--    address, ZIP or visitor is kept), added to waitlist signups.
CREATE TABLE IF NOT EXISTS state_interest (
  st      TEXT NOT NULL,
  day     TEXT NOT NULL,                    -- ISO date
  lookups INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (st, day)
);

-- 4. Bulk loads of a state's session from Open States' session files
--    (tools/load_state_votes.py, the "Load state votes" workflow), one row per file.
CREATE TABLE IF NOT EXISTS state_loads (
  st           TEXT NOT NULL,
  session      TEXT NOT NULL,
  file_url     TEXT NOT NULL CHECK (file_url LIKE 'http%'),
  generated_at TEXT,                         -- the file's own "Generated At"
  bills        INTEGER NOT NULL DEFAULT 0,
  votes        INTEGER NOT NULL DEFAULT 0,
  positions    INTEGER NOT NULL DEFAULT 0,
  skipped_positions INTEGER NOT NULL DEFAULT 0,   -- members not in officials (former members)
  loaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (st, session)
);

-- 5. What's loaded for each state, rebuilt by the sync's page-summaries step,
--    so the map and state pages say plainly what's there and what isn't.
CREATE TABLE IF NOT EXISTS state_coverage (
  st          TEXT PRIMARY KEY,
  legislators INTEGER NOT NULL DEFAULT 0,
  executives  INTEGER NOT NULL DEFAULT 0,
  bills       INTEGER NOT NULL DEFAULT 0,
  votes       INTEGER NOT NULL DEFAULT 0,
  first_vote  TEXT,
  last_vote   TEXT,
  sessions    TEXT,                          -- the sessions with votes, comma-separated
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
