-- Company taxes (docs/taxes.md): what companies filing a 10-K report in their
-- financial statements' XBRL, from SEC EDGAR (company facts, and each 10-K's own
-- XBRL for the taxes paid by jurisdiction), loaded weekly by
-- tools/build_company_taxes.py in the "Refresh company taxes" workflow.
-- A value a filing doesn't tag stays NULL: nothing is estimated. Pages never sort
-- or rank by taxes paid or by any rate (functions/_lib/taxes.js).

-- One row per company with a 10-K since 2019 that tags any value below.
CREATE TABLE IF NOT EXISTS companies (
  cik          INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,          -- nameKey(): the exact-name match key, the same rule as Federal awards
  tickers      TEXT,                   -- comma-separated, as EDGAR lists them
  sic          TEXT,                   -- Standard Industrial Classification code
  sic_desc     TEXT,
  state        TEXT,                   -- business address state (two letters), US companies only
  fy_end       TEXT,                   -- fiscal year end, MMDD
  latest_end   TEXT,                   -- the latest fiscal year with a value below
  latest_fy    INTEGER,
  revenue      REAL,                   -- that year's revenue (for sorting the list only)
  pretax       REAL,                   -- that year's pretax income
  taxes_paid   REAL,                   -- that year's income taxes paid, net of refunds (never sorted on)
  source_url   TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS companies_name_key ON companies (name_key);
CREATE INDEX IF NOT EXISTS companies_sic ON companies (sic);
CREATE INDEX IF NOT EXISTS companies_state ON companies (state);
-- The list's three sorts (name, revenue, pretax income), so a page reads only its rows.
CREATE INDEX IF NOT EXISTS companies_name ON companies (name);
CREATE INDEX IF NOT EXISTS companies_revenue ON companies (revenue);
CREATE INDEX IF NOT EXISTS companies_pretax ON companies (pretax);

-- One row per company and fiscal year (keyed by the year's last day). Each value's
-- filing (accession number) is in src, as {"taxes_paid": "0000320193-26-000026", ...}.
CREATE TABLE IF NOT EXISTS company_tax_years (
  cik             INTEGER NOT NULL,
  period_end      TEXT NOT NULL,
  period_start    TEXT,
  fy              INTEGER,             -- the fiscal year as the company's own 10-K names it
  taxes_paid      REAL,                -- us-gaap:IncomeTaxesPaidNet
  paid_federal    REAL,                -- IncomeTaxPaidFederalAfterRefundReceived (ASU 2023-09)
  paid_state      REAL,                -- IncomeTaxPaidStateAndLocalAfterRefundReceived
  paid_foreign    REAL,                -- IncomeTaxPaidForeignAfterRefundReceived
  current_federal REAL,                -- CurrentFederalTaxExpenseBenefit
  current_state   REAL,                -- CurrentStateAndLocalTaxExpenseBenefit
  deferred        REAL,                -- DeferredIncomeTaxExpenseBenefit
  pretax          REAL,                -- pretax income, total (pretax_tag says which element)
  pretax_tag      TEXT,
  pretax_us       REAL,                -- ...BeforeIncomeTaxesDomestic
  pretax_foreign  REAL,                -- ...BeforeIncomeTaxesForeign
  revenue         REAL,
  revenue_tag     TEXT,
  src             TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (cik, period_end)
);

-- Taxes paid to a single jurisdiction, as a 10-K files them under ASU 2023-09
-- (IncomeTaxAuthorityAxis: a country or a U.S. state), read from the 10-K's own XBRL.
CREATE TABLE IF NOT EXISTS company_tax_jurisdictions (
  cik           INTEGER NOT NULL,
  period_end    TEXT NOT NULL,
  element       TEXT NOT NULL,         -- the element it's filed under (federal, state and local, foreign, or the total)
  jurisdiction  TEXT NOT NULL,         -- country:XX or stpr:XX
  name          TEXT NOT NULL,
  amount        REAL NOT NULL,
  accn          TEXT NOT NULL,
  PRIMARY KEY (cik, period_end, element, jurisdiction)
);

-- 10-Ks whose own XBRL has been read for jurisdictions (each read once).
CREATE TABLE IF NOT EXISTS company_tax_filings (
  accn      TEXT PRIMARY KEY,
  cik       INTEGER NOT NULL,
  found     INTEGER NOT NULL DEFAULT 0,  -- jurisdiction rows found
  read_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An organization tied to a company by a person, when the names differ
-- ("confirmed CIK link"); otherwise only an exact name match (one company) counts.
CREATE TABLE IF NOT EXISTS company_org_links (
  org_key      TEXT PRIMARY KEY,         -- nameKey() of the organization's name as ThePillory shows it
  cik          INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What ThePillory already has for the same organization, matched once a week by
-- tools/build_company_taxes.py (exact name key, or company_org_links; one company
-- per name only): kind 'pac' (contributions to members of Congress, FEC),
-- 'lobbying' (LDA reports naming it as the client), 'ld203' (its LD-203
-- contributions honoring members), 'ca-lobbying' (California Forms 635/645) and
-- 'ca-measures' (2026 California ballot measure money). summary is JSON:
-- {total, count, first, last, source_url, detail}. Pages read only these rows.
CREATE TABLE IF NOT EXISTS company_orgs (
  cik        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  org_name   TEXT NOT NULL,
  how        TEXT NOT NULL CHECK (how IN ('name', 'confirmed')),
  summary    TEXT NOT NULL,
  PRIMARY KEY (cik, kind, org_name)
);
