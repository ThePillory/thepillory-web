-- Executive-branch funding and disclosures (see docs/funding.md). Every row has a source.

-- FEC committees seen as outside spenders, with their FEC committee type. A group
-- of type I ("Independent expenditure filer (not a committee)") doesn't have to
-- disclose its donors; pages label its spending "Donors not disclosed".
CREATE TABLE IF NOT EXISTS fec_committees (
  committee_id   TEXT PRIMARY KEY,
  name           TEXT,
  committee_type TEXT,                       -- FEC's one-letter type: O super PAC, V/W hybrid PAC, I non-committee spender, ...
  committee_type_full TEXT,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The inaugural committee for a President's term (FEC Form 13).
CREATE TABLE IF NOT EXISTS inaugural_committees (
  committee_id  TEXT PRIMARY KEY,
  official_id   TEXT NOT NULL,               -- the President (officials.id)
  name          TEXT NOT NULL,
  term_start    TEXT NOT NULL,
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The latest version of each Form 13 report, with the total as reported.
CREATE TABLE IF NOT EXISTS inaugural_reports (
  committee_id   TEXT NOT NULL,
  report         TEXT NOT NULL,              -- 'POST INAUGURAL 2025', exactly as the FEC lists it
  coverage_start TEXT NOT NULL,
  coverage_end   TEXT,
  receipt_date   TEXT,
  total_receipts REAL,
  amended        INTEGER NOT NULL DEFAULT 0,
  file_number    TEXT,
  pdf_url        TEXT,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (committee_id, report, coverage_start)
);

-- Itemized donations in one report, summed. Individuals only as a count and total;
-- organizations by name. Kept only when they add up to the report's own total.
CREATE TABLE IF NOT EXISTS inaugural_breakdown (
  committee_id   TEXT PRIMARY KEY,
  file_number    TEXT,
  report         TEXT,
  individual_count INTEGER, individual_total REAL,
  organization_count INTEGER, organization_total REAL,
  other_total    REAL,                       -- unitemized and unattributed lines
  refunds_total  REAL,                       -- donations refunded (F133 lines)
  itemized_total REAL,
  note           TEXT,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inaugural_organizations (
  committee_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  total        REAL NOT NULL,
  count        INTEGER NOT NULL,
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (committee_id, name)
);

-- Financial disclosure reports and ethics agreements: the Office of Government
-- Ethics (Cabinet, President, Vice President) and the FPPC (California's Form 700).
CREATE TABLE IF NOT EXISTS disclosures (
  id           TEXT PRIMARY KEY,             -- 'oge:<name|type|date|agency|title>', 'fppc:<...>'
  official_id  TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('oge', 'fppc')),
  kind         TEXT NOT NULL CHECK (kind IN ('financial', 'ethics', 'other')),
  doc_type     TEXT NOT NULL,                -- exactly as the source lists it
  filer_name   TEXT,                         -- as the source lists it
  position     TEXT,                         -- the position the report was filed for
  agency       TEXT,
  filed_on     TEXT,                         -- the source's date (OGE: date added; FPPC: date filed)
  period       TEXT,                         -- e.g. '2025' for an annual statement
  amended_on   TEXT,
  document_url TEXT,                         -- the document itself, when the source links it
  request_url  TEXT,                         -- otherwise, where to request it
  detail       TEXT,                         -- JSON: what's needed to fetch the document (FPPC: its PDF request)
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS disclosures_official ON disclosures (official_id, filed_on);

-- When each official's disclosures were last searched.
CREATE TABLE IF NOT EXISTS disclosure_checks (
  official_id TEXT NOT NULL,
  source      TEXT NOT NULL,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note        TEXT,
  PRIMARY KEY (official_id, source)
);

-- California campaign committees and their reported totals (Cal-Access), for
-- the Governor and the other statewide offices.
CREATE TABLE IF NOT EXISTS state_campaign_committees (
  official_id TEXT NOT NULL,
  filer_id    TEXT NOT NULL,                 -- the Cal-Access filer ID
  name        TEXT,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (official_id, filer_id)
);
CREATE TABLE IF NOT EXISTS state_campaign_totals (
  filer_id      TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  contributions REAL,                        -- contributions received in the period
  expenditures  REAL,                        -- expenditures made in the period
  cash_end      REAL,                        -- ending cash balance
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (filer_id, period_start, period_end)
);
