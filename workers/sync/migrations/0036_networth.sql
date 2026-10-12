-- "Net worth, as reported" (tools/load_networth.py, tools/networth.py;
-- docs/funding.md "Net worth"): one row per annual, candidate, nominee or new
-- member financial disclosure report of a member of Congress, the President,
-- Vice President, Cabinet or a Supreme Court justice, with the sums of its
-- assets and liabilities as filed (value ranges) and the range they add up to.
-- A report that couldn't be read in full keeps status other than 'read' and
-- stays a link. Free, like trades: never sold, exported or put behind a paid plan.
CREATE TABLE IF NOT EXISTS networth_reports (
  id            TEXT PRIMARY KEY,               -- 'house:<DocID>', 'senate:<uuid>', 'oge:<hash>', 'judiciary:<justice>:<year>'
  official_id   TEXT NOT NULL,                  -- officials.id, or 'justice:<slug>'
  source        TEXT NOT NULL CHECK (source IN ('house', 'senate', 'oge', 'judiciary')),
  kind          TEXT NOT NULL CHECK (kind IN ('annual', 'candidate', 'nominee', 'new')),
  amended       INTEGER NOT NULL DEFAULT 0,
  year          INTEGER NOT NULL,               -- the calendar year an annual report covers; the year filed otherwise
  filed_on      TEXT,
  before_office INTEGER NOT NULL DEFAULT 0,     -- a candidate or nominee report filed before the office the person holds now began
  status        TEXT NOT NULL CHECK (status IN ('read', 'scan', 'paper', 'unreadable', 'request')),
  reason        TEXT,                           -- why it wasn't read
  method        TEXT,                           -- 'text' (e-filed PDF), 'html' (e-filed page), 'ai' (scan, two readings)
  assets        INTEGER,
  liabilities   INTEGER,
  asset_min     INTEGER,
  asset_max     INTEGER,
  liab_min      INTEGER,
  liab_max      INTEGER,
  low           INTEGER,
  high          INTEGER,
  low_open      INTEGER NOT NULL DEFAULT 0,     -- an open-ended liability: the low end is "or less"
  high_open     INTEGER NOT NULL DEFAULT 0,     -- an open-ended asset: the high end is "or more"
  residence_mortgages INTEGER NOT NULL DEFAULT 0, -- mortgages on a personal residence left out
  report_url    TEXT NOT NULL CHECK (report_url LIKE 'http%'),
  parser        INTEGER,
  checked_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS networth_reports_official ON networth_reports (official_id, year);
