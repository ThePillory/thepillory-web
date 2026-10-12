-- Dark money: who gives to the groups that spend for and against candidates,
-- nonprofits' IRS filings, and electioneering communications (FEC Form 9).
-- See docs/funding.md. Organizations only: no individual donor is stored.

-- An outside spender's state (to match it to its IRS record) and, for a
-- 501(c)(4) or 501(c)(6) nonprofit, its EIN.
ALTER TABLE fec_committees ADD COLUMN state TEXT;
ALTER TABLE fec_committees ADD COLUMN ein TEXT;
ALTER TABLE fec_committees ADD COLUMN ein_checked_at TEXT;

-- An outside spender's largest donors that are organizations (FEC Schedule A,
-- contribution lines only), summed by donor. kind: committee (a political
-- committee, which discloses its own donors to the FEC), llc, c4 or c6
-- (501(c)(4) or (c)(6), from the IRS record), or org (any other organization).
CREATE TABLE IF NOT EXISTS outside_donors (
  committee_id       TEXT NOT NULL,          -- the spender
  cycle              INTEGER NOT NULL,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('committee', 'llc', 'c4', 'c6', 'org')),
  donor_committee_id TEXT,
  ein                TEXT,
  state              TEXT,
  total              REAL NOT NULL,
  count              INTEGER NOT NULL,
  first_date         TEXT,
  last_date          TEXT,
  source_url         TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (committee_id, cycle, name)
);

-- One read of a spender's receipts: its total reported receipts for the
-- period, how much of the receipts read came from organizations that don't
-- disclose their own donors (LLCs, 501(c)(4)s, 501(c)(6)s), and whether the
-- read stopped at the largest MAX receipts (then the share is "at least").
CREATE TABLE IF NOT EXISTS outside_donor_reads (
  committee_id TEXT NOT NULL,
  cycle        INTEGER NOT NULL,
  receipts     REAL,
  rows_read    INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0,
  dark_total   REAL NOT NULL DEFAULT 0,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  read_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (committee_id, cycle)
);

-- An organization name (and state) looked up in the IRS's exempt-organization
-- records through ProPublica's Nonprofit Explorer; kept so it's asked once.
CREATE TABLE IF NOT EXISTS org_lookups (
  name_key   TEXT PRIMARY KEY,             -- normalized name|state
  ein        TEXT,                          -- set only on exactly one match
  subsection INTEGER,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 501(c)(4) and 501(c)(6) nonprofits that appear as spenders or donors, with
-- their latest IRS Form 990 as filed. political comes from Schedule C Part I-A
-- (tools/load_nonprofits.py reads the e-file XML); political_read says what
-- was found: 'schedule_c', 'no_schedule_c', or 'not_read' (left a link).
CREATE TABLE IF NOT EXISTS nonprofits (
  ein           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  subsection    INTEGER,
  state         TEXT,
  tax_year      INTEGER,
  period_end    TEXT,
  revenue       REAL,
  expenses      REAL,
  political     REAL,
  political_read TEXT CHECK (political_read IN ('schedule_c', 'no_schedule_c', 'not_read')),
  recipients    TEXT,                       -- JSON: political organizations paid, by name, as Schedule C lists them
  filing_url    TEXT,                       -- the filing (ProPublica's copy of the IRS return)
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  xml_checked_at TEXT
);

-- Electioneering communications (FEC Form 9): broadcast ads that name a federal
-- candidate within 30 days of a primary or 60 days of a general election.
CREATE TABLE IF NOT EXISTS electioneering (
  sub_id          TEXT PRIMARY KEY,
  cycle           INTEGER NOT NULL,
  committee_id    TEXT NOT NULL,
  committee_name  TEXT NOT NULL,
  candidate_id    TEXT,
  amount          REAL NOT NULL,           -- the share of the disbursement attributed to this candidate
  disbursement_date TEXT,
  distribution_date TEXT,
  file_number     INTEGER,
  source_url      TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS electioneering_candidate ON electioneering (candidate_id, cycle);

-- Each Form 9's own total of donations reported for the communications.
CREATE TABLE IF NOT EXISTS electioneering_filings (
  file_number  INTEGER PRIMARY KEY,
  committee_id TEXT,
  donations    REAL,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
