-- California officials' investments bought and sold, from Schedule A-1 of their
-- annual Form 700 (Statement of Economic Interests), read by tools/load_form700.py.
-- A Form 700 lists an investment's fair market value range and, when it was
-- acquired or disposed of during the year, the date; these are kept apart from
-- the federal trade reports (trades), which list each trade's own amount.

-- One row per Form 700 read (or tried): read in full, or left as a link.
CREATE TABLE IF NOT EXISTS form700_reads (
  disclosure_id TEXT PRIMARY KEY,           -- disclosures.id ('fppc:<index ID>')
  official_id TEXT NOT NULL,
  period TEXT,                              -- the statement's year
  status TEXT NOT NULL CHECK (status IN ('read', 'link')),
  reason TEXT,                              -- why a statement was left as a link
  entries INTEGER NOT NULL DEFAULT 0,       -- Schedule A-1 entries on the statement
  lines INTEGER NOT NULL DEFAULT 0,         -- of those, acquired or disposed of in the period
  parser INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS form700_reads_official ON form700_reads (official_id);

-- One row per Schedule A-1 investment acquired or disposed of in the period, as filed.
CREATE TABLE IF NOT EXISTS form700_lines (
  id INTEGER PRIMARY KEY,
  disclosure_id TEXT NOT NULL,
  official_id TEXT NOT NULL,
  period TEXT,
  n INTEGER NOT NULL,                       -- the entry's place on the schedule
  entity TEXT NOT NULL,                     -- name of business entity, as filed
  description TEXT,                         -- general description of the business, as filed
  nature TEXT,                              -- Stock / Partnership / Other (with its description)
  value TEXT,                               -- the fair market value box checked
  acquired TEXT,                            -- ISO date, when filed
  disposed TEXT,                            -- ISO date, when filed
  page INTEGER,
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS form700_lines_official ON form700_lines (official_id, period);
