-- The Time Machine (docs/history.md): campaign money by two-year period for
-- past years, and what the history steps have already read.
--
-- FEC totals for each candidate ID and two-year period (cycle 2008 = 2007–2008),
-- as the FEC reports them: receipts, disbursements and cash on hand at the end.
CREATE TABLE IF NOT EXISTS funding_cycles (
  official_id   TEXT NOT NULL,
  fec_id        TEXT NOT NULL,
  cycle         INTEGER NOT NULL,
  receipts      REAL,
  disbursements REAL,
  cash_on_hand  REAL,
  coverage_end  TEXT,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (fec_id, cycle)
);
CREATE INDEX IF NOT EXISTS funding_cycles_official ON funding_cycles (official_id, cycle);

-- What the history steps have read, and when ("fec:<candidate id>").
CREATE TABLE IF NOT EXISTS history_checks (
  key        TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  note       TEXT
);

-- A past year's votes and executive orders are read by date.
CREATE INDEX IF NOT EXISTS votes_chamber_date ON votes (chamber, vote_date);
CREATE INDEX IF NOT EXISTS executive_actions_signed ON executive_actions (signed_on);
