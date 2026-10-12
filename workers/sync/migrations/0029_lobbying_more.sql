-- More lobbying (docs/funding.md):
--   1. LD-203 contribution reports (lda.gov): contributions from registered
--      lobbyists and lobbying organizations to members of Congress;
--   2. committee action on federal bills (Congress.gov), so bills a committee
--      acted on are searched for lobbying reports too;
--   3. California lobbying (Cal-Access): lobbyist employers' quarterly reports,
--      the bills each report lists, and contributions lobbying filers report.

-- One LD-203 report. A lobbyist's own report: lobbyist_id is kept only to count
-- distinct lobbyists; no lobbyist's name is stored.
CREATE TABLE IF NOT EXISTS lobby_contrib_filings (
  filing_uuid     TEXT PRIMARY KEY,
  filer_type      TEXT NOT NULL CHECK (filer_type IN ('organization', 'lobbyist')),
  registrant_id   INTEGER,                 -- the same ID as lobbying_filings.registrant_id
  registrant_name TEXT NOT NULL,
  lobbyist_id     INTEGER,
  filing_year     INTEGER NOT NULL,
  filing_period   TEXT,                    -- 'mid_year' or 'year_end'
  filing_type     TEXT,                    -- MM, YE, or an amendment
  posted_at       TEXT,
  source_url      TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lobby_contrib_filings_registrant ON lobby_contrib_filings (registrant_id, filing_year);

-- Each listed contribution whose honoree is a member of Congress (exactly one
-- name match). contributor_name is NULL on a lobbyist's own report.
CREATE TABLE IF NOT EXISTS lobby_contributions (
  filing_uuid       TEXT NOT NULL REFERENCES lobby_contrib_filings(filing_uuid),
  n                 INTEGER NOT NULL,      -- the item's place in the report
  official_id       TEXT NOT NULL REFERENCES officials(id),
  contribution_type TEXT,                  -- feca, he (honorary expenses), me (meeting expenses), ple, pic
  contributor_name  TEXT,
  payee_name        TEXT,
  honoree_name      TEXT,
  amount            REAL,
  date              TEXT,
  PRIMARY KEY (filing_uuid, n)
);
CREATE INDEX IF NOT EXISTS lobby_contributions_official ON lobby_contributions (official_id, date);

-- Where each member's search stopped, by year.
CREATE TABLE IF NOT EXISTS lobby_contrib_progress (
  official_id TEXT NOT NULL,
  year        INTEGER NOT NULL,
  page        INTEGER NOT NULL DEFAULT 1,
  searched    INTEGER NOT NULL DEFAULT 0,
  matched     INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (official_id, year)
);

-- A committee's action on a federal bill, as Congress.gov lists it for the
-- committee ("Reported By", "Markup By", "Hearings By (full committee)", …).
-- Referral alone isn't kept: every bill is referred.
CREATE TABLE IF NOT EXISTS bill_committee_actions (
  bill_id        TEXT NOT NULL REFERENCES bills(id),
  committee_code TEXT NOT NULL,
  committee_name TEXT,
  relationship   TEXT NOT NULL,
  action_date    TEXT,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (bill_id, committee_code, relationship)
);
CREATE INDEX IF NOT EXISTS bill_committee_actions_date ON bill_committee_actions (action_date);

-- California: lobbyist employers' quarterly reports (Form 635) and reports of
-- people who spent $5,000 or more to influence state action (Form 645), the
-- latest amendment of each. amount: the report's total lobbying payments for
-- the quarter (everything it lists, not one bill).
CREATE TABLE IF NOT EXISTS ca_lobby_reports (
  filing_id     TEXT PRIMARY KEY,
  amend_id      INTEGER NOT NULL,
  form          TEXT NOT NULL,             -- F635 or F645
  employer_id   TEXT NOT NULL,             -- Cal-Access filer ID
  employer_name TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  filed_on      TEXT,
  amount        REAL,
  activity      TEXT,                      -- the report's own words: what was lobbied
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  loaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ca_lobby_reports_employer ON ca_lobby_reports (employer_id, period_end);

-- The bills a report lists, by bill id ('ca-20252026-ab-123'), whether or not
-- the bill is loaded yet.
CREATE TABLE IF NOT EXISTS ca_bill_lobbying (
  bill_id   TEXT NOT NULL,
  filing_id TEXT NOT NULL,
  PRIMARY KEY (bill_id, filing_id)
);
CREATE INDEX IF NOT EXISTS ca_bill_lobbying_filing ON ca_bill_lobbying (filing_id);

-- Contributions reported by lobbyist employers (Form 635), lobbying firms
-- (Form 625), people spending to influence (Form 645) and lobbyists (Form 615)
-- to state candidates' committees. A lobbyist's name isn't stored (filer_name
-- is NULL; filer_id only counts distinct lobbyists).
CREATE TABLE IF NOT EXISTS ca_lobby_contributions (
  filing_id      TEXT NOT NULL,
  n              INTEGER NOT NULL,
  form           TEXT NOT NULL,
  filer_kind     TEXT NOT NULL CHECK (filer_kind IN ('employer', 'firm', 'lobbyist', 'other')),
  filer_id       TEXT,
  filer_name     TEXT,
  recipient_id   TEXT,                     -- the receiving committee's Cal-Access filer ID
  recipient_name TEXT,
  date           TEXT,
  amount         REAL,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (filing_id, n)
);
CREATE INDEX IF NOT EXISTS ca_lobby_contributions_recipient ON ca_lobby_contributions (recipient_id, date);
CREATE INDEX IF NOT EXISTS ca_lobby_contributions_filer ON ca_lobby_contributions (filer_id);

-- Which Cal-Access lobbying filings (and which amendment) are loaded, so a
-- weekly run writes only new and amended ones.
CREATE TABLE IF NOT EXISTS ca_lobby_loaded (
  filing_id TEXT PRIMARY KEY,
  amend_id  INTEGER NOT NULL,
  form      TEXT NOT NULL,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
