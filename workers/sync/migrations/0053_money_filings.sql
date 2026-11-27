-- Campaign finance reports as events (docs/funding.md, "Filings as events"): one row per report a
-- campaign filed for its period, as the agency states it. FEC: the principal campaign committee's
-- quarterly, pre- and post-election and year-end reports (Form 3), read in the funding step for the
-- current two-year period. Cal-Access: each Form 460 statement of the committees a California official
-- controls (data/ca-campaign.json), read in the executive-funding step. Shown as one line in This week
-- (home and state pages) and the weekly email: "[Name]'s campaign reported raising $X and spending $Y,
-- [period] ([agency])", linked to the report. Totals only; no donor is ever named here.
CREATE TABLE IF NOT EXISTS money_filings (
  official_id  TEXT NOT NULL,
  agency       TEXT NOT NULL CHECK (agency IN ('FEC', 'Cal-Access')),
  committee_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  report       TEXT,                  -- the agency's name for the report ("October Quarterly"), when stated
  raised       REAL,                  -- total receipts (FEC) or contributions received (Cal-Access) in the period
  spent        REAL,                  -- total disbursements (FEC) or expenditures made (Cal-Access) in the period
  filed        TEXT NOT NULL,         -- the date the agency received it (YYYY-MM-DD)
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, agency, committee_id, period_start, period_end)
);
-- This week and the weekly email read a week of filings by date.
CREATE INDEX IF NOT EXISTS money_filings_filed ON money_filings (filed);
