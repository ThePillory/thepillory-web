-- Nationwide: every current member of Congress and every California
-- legislator, every member's position on each vote, vote totals, and the
-- county waitlist. See docs/data-sync.md.

-- Which state an official serves (USPS code, e.g. 'CA'), and the district as a
-- bare number from the source ('5' for CA-5, '8' for Assembly District 8).
-- district_code is NULL for senators and statewide seats, and '0' for a
-- House member elected at large or a non-voting delegate.
ALTER TABLE officials ADD COLUMN state TEXT;
ALTER TABLE officials ADD COLUMN district_code TEXT;
-- When the member's detail record (full name, website) was last read, so the
-- ~540 detail requests are spread across runs.
ALTER TABLE officials ADD COLUMN detail_checked TEXT;
CREATE INDEX IF NOT EXISTS officials_state ON officials (chamber, state, district_code);

-- Every official loaded before this migration represents Calaveras County, California.
UPDATE officials SET state = 'CA';
UPDATE officials SET district_code = substr(district, 4) WHERE chamber = 'us-house' AND district LIKE 'CA-%';
UPDATE officials SET district_code = replace(replace(district, 'Assembly District ', ''), 'Senate District ', '') WHERE chamber IN ('ca-assembly', 'ca-senate');

-- The whole chamber's tally, as the source states it. NULL until read (votes
-- saved before this migration are re-read once to fill these in and to save
-- every member's position, not only the Calaveras delegation's).
ALTER TABLE votes ADD COLUMN yea INTEGER;
ALTER TABLE votes ADD COLUMN nay INTEGER;
ALTER TABLE votes ADD COLUMN present INTEGER;
ALTER TABLE votes ADD COLUMN not_voting INTEGER;
CREATE INDEX IF NOT EXISTS votes_type_date ON votes (vote_type, level, vote_date);

-- "Bring The Pillory to your county": one row per email and county. The email
-- is used only to announce that county's launch. Never shown publicly; the hub
-- shows only the totals.
CREATE TABLE IF NOT EXISTS waitlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  county_fips TEXT NOT NULL CHECK (length(county_fips) = 5),   -- e.g. '06009'
  county_name TEXT NOT NULL,                                    -- e.g. 'Calaveras County, California'
  email       TEXT NOT NULL CHECK (email LIKE '%_@_%'),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email, county_fips)
);
CREATE INDEX IF NOT EXISTS waitlist_county ON waitlist (county_fips);

-- Rate limiting for the waitlist form, the same way as public_actions: the
-- visitor is a daily-rotating hash, never the address.
CREATE TABLE IF NOT EXISTS waitlist_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS waitlist_attempts_visitor ON waitlist_attempts (visitor, created_at);
