-- Every committee the FEC ties to an official (docs/funding.md, "Which committees count"), with what each
-- raised in the period from its own reports: the candidate's authorized committees (principal and other
-- authorized, any cycle's registration, kept only when it reports receipts in the period), the leadership
-- PACs the candidate sponsors (designation D), and joint fundraising committees the FEC links to the
-- candidate (designation J). Never a super PAC or other independent-expenditure-only committee (types O
-- and I): those stay in outside spending. Read in the federal-funding step for the current two-year
-- period, written through syncScope (only changed rows).
--
-- "Raised $X in [period]" adds the campaign committees and leadership PACs. A joint fundraising committee
-- passes what it raises on to the committees it raises for, so it is listed on the Funding tab on its own
-- line and never added in (no double counting).
CREATE TABLE IF NOT EXISTS official_committees (
  official_id    TEXT NOT NULL,
  cycle          INTEGER NOT NULL,
  committee_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('campaign', 'leadership', 'joint')),
  designation    TEXT,              -- the FEC's designation code (P, A, D, J)
  committee_type TEXT,              -- the FEC's committee type code
  receipts       REAL NOT NULL,     -- total receipts in the period, from the committee's own reports
  coverage_end   TEXT,              -- the end of the latest report's period (YYYY-MM-DD)
  source_url     TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at     TEXT,
  PRIMARY KEY (official_id, cycle, committee_id)
);
-- Your representatives read a few officials' committees for one period.
CREATE INDEX IF NOT EXISTS official_committees_cycle ON official_committees (cycle, official_id);
