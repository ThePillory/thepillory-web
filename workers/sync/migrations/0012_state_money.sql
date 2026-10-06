-- California campaign finance for the Governor, the statewide offices and
-- every legislator, from data/ca-campaign.json (built weekly from the
-- Cal-Access export by tools/build_ca_campaign.py and
-- tools/ca_campaign_finish.mjs). Committees and statement totals stay in
-- state_campaign_committees and state_campaign_totals (migration 0009).
-- See docs/funding.md.

-- Per official and two-year period: raised, spent, itemized individuals.
CREATE TABLE IF NOT EXISTS state_money_cycles (
  official_id        TEXT NOT NULL,
  cycle              TEXT NOT NULL,             -- '2025-2026'
  raised             REAL,                      -- sum of the statements' Summary Page line 5
  spent              REAL,                      -- line 11
  statements         INTEGER NOT NULL DEFAULT 0,
  individuals_total  REAL,                      -- itemized contributions from individuals (Schedule A)
  individuals_count  INTEGER,
  not_employed_total REAL,                      -- of those, from people listing no employer (retired, not employed, self-employed)
  not_employed_count INTEGER,
  source_url         TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, cycle)
);

-- Contributions by industry (approximate: keyword rules on employer and organization names).
CREATE TABLE IF NOT EXISTS state_money_industries (
  official_id TEXT NOT NULL,
  cycle       TEXT NOT NULL,
  industry    TEXT NOT NULL,
  total       REAL NOT NULL,
  PRIMARY KEY (official_id, cycle, industry)
);

-- Individuals' contributions by employer (at least 3 people). Never by person.
CREATE TABLE IF NOT EXISTS state_money_employers (
  official_id TEXT NOT NULL,
  cycle       TEXT NOT NULL,
  employer    TEXT NOT NULL,
  industry    TEXT NOT NULL,
  total       REAL NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (official_id, cycle, employer)
);

-- Contributions from committees, parties, businesses and other organizations, by name.
CREATE TABLE IF NOT EXISTS state_money_orgs (
  official_id TEXT NOT NULL,
  cycle       TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- 'committee', 'political party', 'organization', 'small contributor committee'
  industry    TEXT NOT NULL,
  total       REAL NOT NULL,
  count       INTEGER NOT NULL,
  filer_id    TEXT,
  PRIMARY KEY (official_id, cycle, name)
);

-- Independent expenditures for or against the official (Form 496), by spender.
CREATE TABLE IF NOT EXISTS state_money_ie (
  official_id    TEXT NOT NULL,
  cycle          TEXT NOT NULL,
  spender        TEXT NOT NULL,
  filer_id       TEXT NOT NULL,
  support_oppose TEXT NOT NULL CHECK (support_oppose IN ('support', 'oppose')),
  race           TEXT NOT NULL DEFAULT '',      -- the race as the report states it, e.g. 'State Assembly'
  total          REAL NOT NULL,
  filings        INTEGER NOT NULL,
  first_date     TEXT,
  last_date      TEXT,
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (official_id, cycle, filer_id, support_oppose, race)
);
