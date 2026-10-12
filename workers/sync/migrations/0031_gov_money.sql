-- Money flowing from government to organizations, and outside contacts and
-- travel, shown beside funding and lobbying as facts, never as cause (see
-- docs/funding.md). Loaded by tools/load_gov_money.py in GitHub Actions.

-- Earmarks: Community Project Funding (House) and Congressionally Directed
-- Spending (Senate). A project in an Appropriations Committee table: in the
-- enacted law's table ('enacted') or the House committee's bill ('house_committee').
CREATE TABLE IF NOT EXISTS earmarks (
  id           TEXT PRIMARY KEY,            -- stable hash of the table and row
  fy           INTEGER NOT NULL,            -- fiscal year
  stage        TEXT NOT NULL CHECK (stage IN ('enacted', 'house_committee')),
  subcommittee TEXT NOT NULL,               -- 'agriculture', 'cjs', 'energy-water', 'interior', 'lhhs', 'milcon-va', 'thud', ...
  agency       TEXT,
  account      TEXT,
  state        TEXT,
  location     TEXT,
  recipient    TEXT,
  project      TEXT NOT NULL,
  amount       REAL NOT NULL,
  origination  TEXT,                        -- H, S or H/S, as the table states
  page         INTEGER,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS earmarks_fy ON earmarks (fy, subcommittee);

-- Who requested each one, as the table lists them; official_id only on exactly one match.
CREATE TABLE IF NOT EXISTS earmark_requesters (
  earmark_id  TEXT NOT NULL REFERENCES earmarks(id),
  name        TEXT NOT NULL,
  chamber     TEXT,                         -- 'house' or 'senate'
  official_id TEXT,
  PRIMARY KEY (earmark_id, name)
);
CREATE INDEX IF NOT EXISTS earmark_requesters_official ON earmark_requesters (official_id);

-- What House members requested (the committee's consolidated tables of requests).
CREATE TABLE IF NOT EXISTS earmark_requests (
  id               TEXT PRIMARY KEY,
  fy               INTEGER NOT NULL,
  official_id      TEXT,
  member_name      TEXT NOT NULL,
  district         TEXT,
  subcommittee     TEXT,
  recipient        TEXT,
  project          TEXT,
  address          TEXT,
  amount_requested REAL,
  member_url       TEXT,
  enacted_id       TEXT,                    -- the enacted earmark it matches: same member, same recipient, one match only
  source_url       TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS earmark_requests_official ON earmark_requests (official_id, fy);

-- Each table loaded or left as a link, by fiscal year.
CREATE TABLE IF NOT EXISTS earmark_tables (
  source_url   TEXT PRIMARY KEY,
  fy           INTEGER NOT NULL,
  stage        TEXT NOT NULL,
  subcommittee TEXT,
  status       TEXT NOT NULL CHECK (status IN ('read', 'link')),
  rows         INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  read_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Privately paid travel (House Clerk gift travel filings; Senate Gift Rule
-- reimbursed travel reports). traveler: 'member' or 'staff' (staff aren't named).
CREATE TABLE IF NOT EXISTS gift_travel (
  id          TEXT PRIMARY KEY,
  official_id TEXT NOT NULL,
  chamber     TEXT NOT NULL CHECK (chamber IN ('house', 'senate')),
  traveler    TEXT NOT NULL CHECK (traveler IN ('member', 'staff')),
  sponsor     TEXT,                         -- House filings state it; Senate reports are scanned forms (see the report)
  destination TEXT,
  start_date  TEXT,
  end_date    TEXT,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS gift_travel_official ON gift_travel (official_id, start_date);

-- FARA: registered foreign agents and the foreign principals they represent.
CREATE TABLE IF NOT EXISTS fara_registrants (
  registration_number INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  registration_date   TEXT,
  termination_date    TEXT,
  city                TEXT,
  state               TEXT,
  source_url          TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE TABLE IF NOT EXISTS fara_principals (
  registration_number INTEGER NOT NULL,
  principal           TEXT NOT NULL,
  country             TEXT,
  registration_date   TEXT,
  termination_date    TEXT,
  PRIMARY KEY (registration_number, principal)
);
CREATE INDEX IF NOT EXISTS fara_principals_country ON fara_principals (country);

-- Contacts with members of Congress or their offices, as a registrant's
-- supplemental statement reports them (Item 12, political activities).
-- Read from the statement's text layer; scanned statements stay links. The
-- person contacted is named only when it's the member; staff aren't named.
CREATE TABLE IF NOT EXISTS fara_contacts (
  doc_url             TEXT NOT NULL,
  n                   INTEGER NOT NULL,
  registration_number INTEGER NOT NULL,
  official_id         TEXT NOT NULL,
  contact_kind        TEXT NOT NULL CHECK (contact_kind IN ('member', 'office')),
  principal           TEXT,
  contact_date        TEXT,
  method              TEXT,
  filed_on            TEXT,
  PRIMARY KEY (doc_url, n)
);
CREATE INDEX IF NOT EXISTS fara_contacts_official ON fara_contacts (official_id, contact_date);

-- Statements read (or left as links), so a run reads only new ones.
CREATE TABLE IF NOT EXISTS fara_docs (
  doc_url             TEXT PRIMARY KEY,
  registration_number INTEGER NOT NULL,
  filed_on            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('read', 'link')),
  contacts            INTEGER NOT NULL DEFAULT 0,
  read_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Federal awards (USAspending.gov) looked up for an organization's exact name:
-- the result kept a week, so a page doesn't ask USAspending every visit.
CREATE TABLE IF NOT EXISTS federal_awards_cache (
  name_key   TEXT PRIMARY KEY,
  result     TEXT NOT NULL,                 -- JSON
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
