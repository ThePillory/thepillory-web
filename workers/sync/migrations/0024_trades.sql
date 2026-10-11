-- Stock trades by members of Congress: STOCK Act Periodic Transaction Reports
-- (docs/trades.md). Loaded by tools/load_trades.py in the "Load stock trades"
-- workflow. Only what the public report says is stored. The Ethics in
-- Government Act forbids commercial use of these reports: never sell, export
-- or put them behind a paid plan.

-- One filed report. A report that couldn't be matched to exactly one member
-- is kept with official_id NULL and a reason, for review, and never shown.
CREATE TABLE IF NOT EXISTS trade_reports (
  id           TEXT PRIMARY KEY,            -- 'house:20026789', 'senate:<uuid>'
  chamber      TEXT NOT NULL CHECK (chamber IN ('us-house', 'us-senate')),
  official_id  TEXT,                        -- officials.id; NULL when not matched
  filer_name   TEXT NOT NULL,               -- as the filing index gives it
  state        TEXT,                        -- 'CA'
  district     TEXT,                        -- House: 'CA05' as filed
  filed_on     TEXT NOT NULL,               -- ISO date
  report_url   TEXT NOT NULL CHECK (report_url LIKE 'http%'),
  paper        INTEGER NOT NULL DEFAULT 0,  -- 1: filed on paper (a scanned image); its contents aren't read
  parsed       INTEGER NOT NULL DEFAULT 0,  -- 1: its transactions were read
  trade_count  INTEGER NOT NULL DEFAULT 0,
  unmatched    TEXT,                        -- why it isn't attached to a member
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS trade_reports_official ON trade_reports (official_id, filed_on);
CREATE INDEX IF NOT EXISTS trade_reports_filed ON trade_reports (filed_on);

-- One transaction, exactly as filed.
CREATE TABLE IF NOT EXISTS trades (
  report_id        TEXT NOT NULL,
  n                INTEGER NOT NULL,        -- its line in the report
  official_id      TEXT NOT NULL,
  chamber          TEXT NOT NULL,
  state            TEXT,
  transaction_date TEXT,                    -- ISO date, as filed (NULL if the report gives none)
  filed_on         TEXT NOT NULL,
  days_to_file     INTEGER,                 -- filed_on - transaction_date
  owner            TEXT,                    -- 'Self', 'Spouse', 'Joint', 'Dependent child' (never a name)
  asset_name       TEXT NOT NULL,
  ticker           TEXT,
  asset_type       TEXT,
  type             TEXT NOT NULL,           -- 'Purchase', 'Sale', 'Partial sale', 'Exchange'
  amount           TEXT NOT NULL,           -- the range exactly as filed: '$1,001 - $15,000'
  amount_min       INTEGER,
  amount_max       INTEGER,                 -- NULL for the open-ended top range ('Over $50,000,000')
  sic              TEXT,                    -- SEC SIC code, by ticker (EDGAR)
  sector           TEXT,                    -- the SIC division ('Manufacturing', 'Finance, Insurance and Real Estate', …)
  PRIMARY KEY (report_id, n)
);
CREATE INDEX IF NOT EXISTS trades_official ON trades (official_id, transaction_date);
CREATE INDEX IF NOT EXISTS trades_date ON trades (transaction_date);
CREATE INDEX IF NOT EXISTS trades_filters ON trades (chamber, state, sector, transaction_date);

-- Per member and year, precomputed after each load: pages never add up trades.
CREATE TABLE IF NOT EXISTS trade_summary (
  official_id  TEXT NOT NULL,
  year         INTEGER NOT NULL,
  trades       INTEGER NOT NULL,
  total_min    INTEGER NOT NULL,
  total_max    INTEGER,                     -- NULL when a trade's range is open-ended
  open_ended   INTEGER NOT NULL DEFAULT 0,
  paper        INTEGER NOT NULL DEFAULT 0,  -- reports filed on paper that year
  PRIMARY KEY (official_id, year)
);

-- SEC EDGAR: a ticker's company and SIC code, cached.
CREATE TABLE IF NOT EXISTS sec_tickers (
  ticker      TEXT PRIMARY KEY,
  cik         TEXT,
  company     TEXT,
  sic         TEXT,
  sector      TEXT,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Current committee assignments of members of Congress (congress-legislators).
CREATE TABLE IF NOT EXISTS congress_committees (
  official_id   TEXT NOT NULL,
  committee_id  TEXT NOT NULL,              -- 'SSAF', 'HSAG15'
  name          TEXT NOT NULL,
  parent        TEXT,                       -- the full committee, for a subcommittee
  title         TEXT,                       -- 'Chair', 'Ranking Member', as listed
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, committee_id)
);
