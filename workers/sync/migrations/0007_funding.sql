-- Campaign funding (FEC) and federal lobbying (lda.gov). See docs/funding.md.
-- Facts only: amounts, names of committees and organizations, and sources.
-- No individual donor is stored by name; individual giving is kept only as
-- aggregates (by size, and by employer).

-- Each member of Congress's FEC candidate ID and principal campaign committee.
CREATE TABLE IF NOT EXISTS fec_candidates (
  official_id  TEXT PRIMARY KEY REFERENCES officials(id),
  candidate_id TEXT,
  committee_id TEXT,
  committee_name TEXT,
  note         TEXT,                     -- why there's no ID, when there isn't one
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Totals for one two-year period (cycle 2026 = 2025–2026), all authorized committees.
CREATE TABLE IF NOT EXISTS funding_totals (
  official_id   TEXT NOT NULL REFERENCES officials(id),
  cycle         INTEGER NOT NULL,
  candidate_id  TEXT NOT NULL,
  receipts      REAL NOT NULL DEFAULT 0,
  disbursements REAL NOT NULL DEFAULT 0,
  cash_on_hand  REAL,
  individual_unitemized REAL NOT NULL DEFAULT 0,   -- $200 or less per donor in the period
  individual_itemized   REAL NOT NULL DEFAULT 0,   -- more than $200
  pac           REAL NOT NULL DEFAULT 0,           -- other political committees (PACs)
  party         REAL NOT NULL DEFAULT 0,
  self_funding  REAL NOT NULL DEFAULT 0,           -- the candidate's own contributions and loans
  other         REAL NOT NULL DEFAULT 0,           -- transfers, other receipts
  coverage_end  TEXT,
  last_report   TEXT,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (official_id, cycle)
);

-- Contributions from PACs and other political committees, summed by committee.
CREATE TABLE IF NOT EXISTS funding_pacs (
  official_id   TEXT NOT NULL REFERENCES officials(id),
  cycle         INTEGER NOT NULL,
  committee_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  committee_type TEXT,
  total         REAL NOT NULL,
  count         INTEGER NOT NULL,
  industry      TEXT NOT NULL DEFAULT 'other',
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, cycle, committee_id)
);

-- Independent expenditures for (S) or against (O) the member, by spender.
CREATE TABLE IF NOT EXISTS funding_outside (
  official_id   TEXT NOT NULL REFERENCES officials(id),
  cycle         INTEGER NOT NULL,
  committee_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  support_oppose TEXT NOT NULL CHECK (support_oppose IN ('S', 'O')),
  total         REAL NOT NULL,
  count         INTEGER,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, cycle, committee_id, support_oppose)
);

-- Itemized individual contributions summed by the employer donors reported.
-- Never a donor's name. Pages show an employer only when 3 or more people gave.
CREATE TABLE IF NOT EXISTS funding_employers (
  official_id   TEXT NOT NULL REFERENCES officials(id),
  cycle         INTEGER NOT NULL,
  employer      TEXT NOT NULL,
  total         REAL NOT NULL,
  count         INTEGER NOT NULL,
  industry      TEXT NOT NULL DEFAULT 'other',
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, cycle, employer)
);

-- One sync pass per official and cycle: what was read, and when.
CREATE TABLE IF NOT EXISTS funding_progress (
  official_id TEXT NOT NULL,
  cycle       INTEGER NOT NULL,
  done_at     TEXT,
  note        TEXT,
  PRIMARY KEY (official_id, cycle)
);

-- Lobbying reports (LD-2) from lda.gov that mention a bill.
CREATE TABLE IF NOT EXISTS lobbying_filings (
  filing_uuid   TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  client_description TEXT,
  registrant_name TEXT NOT NULL,
  filing_year   INTEGER NOT NULL,
  filing_period TEXT,
  filing_type   TEXT,                    -- Q1..Q4, or an amendment (1A..4A)
  posted_at     TEXT,
  registrant_id INTEGER,
  client_id     INTEGER,
  amount        REAL,                    -- income (lobbying firm) or expenses (in-house); the whole report, every issue
  amount_kind   TEXT CHECK (amount_kind IN ('income', 'expenses')),
  industry      TEXT NOT NULL DEFAULT 'other',
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bill_lobbying (
  bill_id     TEXT NOT NULL REFERENCES bills(id),
  filing_uuid TEXT NOT NULL REFERENCES lobbying_filings(filing_uuid),
  issue_code  TEXT,
  excerpt     TEXT,                      -- the report's own words around the bill number
  PRIMARY KEY (bill_id, filing_uuid)
);
CREATE INDEX IF NOT EXISTS bill_lobbying_bill ON bill_lobbying (bill_id);

-- Where each bill's search stopped: {query index, page}; resumes across runs.
CREATE TABLE IF NOT EXISTS bill_lobbying_progress (
  bill_id     TEXT PRIMARY KEY REFERENCES bills(id),
  cursor      TEXT,
  searched    INTEGER NOT NULL DEFAULT 0, -- filings the searches returned, before each mention is checked
  matched     INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
