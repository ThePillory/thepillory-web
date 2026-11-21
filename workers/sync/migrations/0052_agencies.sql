-- Government agencies (docs/agencies.md): written by tools/load_agencies.py in GitHub Actions,
-- read by /agencies/ and /agencies/<slug>/. Every row has its source; every table is read by its
-- key or the agency's index.

-- The Federal Register's agencies list. id is its slug, kept for good (never renamed).
CREATE TABLE IF NOT EXISTS agencies (
  id          TEXT PRIMARY KEY,
  fr_id       INTEGER,
  name        TEXT NOT NULL,
  short_name  TEXT,
  parent_id   TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('department', 'sub-agency', 'independent')),
  description TEXT,
  website     TEXT,
  usas_code   TEXT,                    -- USAspending top-tier code, when exactly one name matches
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agencies_parent ON agencies (parent_id, name);

-- Senate-confirmed positions (OPM's PLUM data) and who holds them.
CREATE TABLE IF NOT EXISTS agency_leaders (
  agency_id     TEXT NOT NULL,
  organization  TEXT NOT NULL,          -- the PLUM organization (component), as listed
  position      TEXT NOT NULL,
  name          TEXT NOT NULL,          -- '' for a vacant position
  status        TEXT NOT NULL,          -- 'Filled' or 'Vacant', as listed
  appointment   TEXT,                   -- 'PAS', or the type listed for a non-PAS holder
  placement     TEXT,                   -- as listed (e.g. 'PTDO'); NULL when none
  since         TEXT,                   -- begin date, as listed
  nomination_id TEXT,                   -- Congress.gov nomination, one name match only
  confirmed_on  TEXT,
  vote_id       TEXT,                   -- the Senate roll call, when recorded
  confirm_note  TEXT,                   -- otherwise the nomination's latest action, as stated
  official_id   TEXT,                   -- an official already on the site (the Cabinet)
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (agency_id, organization, position, name)
);

-- USAspending: per agency and fiscal year.
CREATE TABLE IF NOT EXISTS agency_money (
  agency_id   TEXT NOT NULL,
  fy          INTEGER NOT NULL,
  resources   REAL,                     -- total budgetary resources
  obligations REAL,
  outlays     REAL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (agency_id, fy)
);

CREATE TABLE IF NOT EXISTS agency_money_parts (
  agency_id   TEXT NOT NULL,
  fy          INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('object_class', 'function')),
  name        TEXT NOT NULL,
  parent      TEXT,                     -- a budget subfunction's function
  obligations REAL,
  outlays     REAL,
  PRIMARY KEY (agency_id, fy, kind, name)
);

CREATE TABLE IF NOT EXISTS agency_recipients (
  agency_id    TEXT NOT NULL,
  fy           INTEGER NOT NULL,
  award        TEXT NOT NULL CHECK (award IN ('contracts', 'grants')),
  rank         INTEGER NOT NULL,
  name         TEXT NOT NULL,
  recipient_id TEXT,
  amount       REAL,
  PRIMARY KEY (agency_id, fy, award, rank)
);

-- OPM: employees on board in September of each year.
CREATE TABLE IF NOT EXISTS agency_workforce (
  agency_id  TEXT NOT NULL,
  year       INTEGER NOT NULL,
  employees  INTEGER NOT NULL,
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (agency_id, year)
);

-- Oversight reports naming the agency (GAO): title, date, number and link only.
CREATE TABLE IF NOT EXISTS agency_reports (
  source       TEXT NOT NULL,           -- 'gao'
  number       TEXT NOT NULL,           -- 'GAO-27-108458'
  agency_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  published_on TEXT,
  url          TEXT NOT NULL CHECK (url LIKE 'http%'),
  PRIMARY KEY (source, number, agency_id)
);
CREATE INDEX IF NOT EXISTS agency_reports_agency ON agency_reports (agency_id, published_on);

-- Federal Register rules.
CREATE TABLE IF NOT EXISTS agency_rule_counts (
  agency_id TEXT NOT NULL,
  year      INTEGER NOT NULL,
  rules     INTEGER NOT NULL,
  PRIMARY KEY (agency_id, year)
);
CREATE TABLE IF NOT EXISTS agency_rules (
  agency_id       TEXT NOT NULL,
  document_number TEXT NOT NULL,
  title           TEXT NOT NULL,
  published_on    TEXT,
  url             TEXT NOT NULL CHECK (url LIKE 'http%'),
  PRIMARY KEY (agency_id, document_number)
);

-- Appropriations bills that fund the agency (bills already on the site).
CREATE TABLE IF NOT EXISTS agency_bills (
  agency_id    TEXT NOT NULL,
  bill_id      TEXT NOT NULL,
  subcommittee TEXT,
  PRIMARY KEY (agency_id, bill_id)
);

-- What each part last saw of its source (Content-Length, ETag, reporting period), so an unchanged
-- source isn't read again.
CREATE TABLE IF NOT EXISTS agency_load_state (
  part       TEXT PRIMARY KEY,
  value      TEXT,
  checked_at TEXT
);
