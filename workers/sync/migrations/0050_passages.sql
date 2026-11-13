-- Bills passed without a recorded vote, and what is on record about them (docs/data-sync.md,
-- "Passage without a recorded vote"). The bill-passages step reads each bill's Congress.gov
-- actions; nothing here records or implies any member's position.

-- A chamber's passage of a bill by voice vote, unanimous consent or (House) without objection:
-- the latest such passage in each chamber, as Congress.gov's action states it.
CREATE TABLE IF NOT EXISTS bill_passages (
  bill_id     TEXT NOT NULL,
  chamber     TEXT NOT NULL CHECK (chamber IN ('us-house', 'us-senate')),
  method      TEXT NOT NULL CHECK (method IN ('voice_vote', 'unanimous_consent', 'without_objection')),
  action_date TEXT NOT NULL,
  action_text TEXT NOT NULL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, chamber)
);
CREATE INDEX IF NOT EXISTS bill_passages_date ON bill_passages (action_date);

-- The rules (H.Res.) under which the House considered a bill, from the bill's own actions.
CREATE TABLE IF NOT EXISTS bill_rules (
  bill_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (bill_id, rule_id)
);

-- Cosponsors as Congress.gov lists them (signing on to a bill isn't a vote).
CREATE TABLE IF NOT EXISTS bill_cosponsors (
  bill_id      TEXT NOT NULL,
  bioguide_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  signed_on    TEXT,
  original     INTEGER NOT NULL DEFAULT 0,
  withdrawn_on TEXT,
  PRIMARY KEY (bill_id, bioguide_id)
);
CREATE INDEX IF NOT EXISTS bill_cosponsors_member ON bill_cosponsors (bioguide_id);

-- Related bills as Congress.gov lists them, with the relationship's own words and who identified it.
CREATE TABLE IF NOT EXISTS bill_related (
  bill_id       TEXT NOT NULL,
  related_id    TEXT NOT NULL,
  label         TEXT NOT NULL,
  title         TEXT,
  relationship  TEXT NOT NULL,
  identified_by TEXT,
  PRIMARY KEY (bill_id, related_id)
);

-- Committee votes stated in a committee report (H. Rept. / S. Rept.), each the report's own sentence.
CREATE TABLE IF NOT EXISTS committee_votes (
  bill_id    TEXT NOT NULL,
  report     TEXT NOT NULL,             -- "H. Rept. 119-123"
  vote_date  TEXT NOT NULL,
  question   TEXT NOT NULL,             -- the report's sentence, word for word
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  PRIMARY KEY (bill_id, report, vote_date, question)
);

-- When each bill's cosponsors, related bills and reports were last read, and Congress.gov's updateDate then.
CREATE TABLE IF NOT EXISTS bill_record_checks (
  bill_id     TEXT PRIMARY KEY,
  update_date TEXT,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- House discharge petitions (the Clerk's pages): the petition, the rule it would discharge and the
-- bill that rule provides for, and each signature with its date.
CREATE TABLE IF NOT EXISTS discharge_petitions (
  id          TEXT PRIMARY KEY,         -- "119-5": Congress and petition number
  congress    INTEGER NOT NULL,
  number      INTEGER NOT NULL,
  bill_id     TEXT,                     -- the bill it would bring to a vote
  rule_id     TEXT,                     -- the H.Res. it would discharge, when it names one
  filed_on    TEXT,
  status      TEXT,
  signatures  INTEGER,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  checked_at  TEXT,                     -- when its page (and signatures) was last read
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS discharge_petitions_bill ON discharge_petitions (bill_id);
CREATE TABLE IF NOT EXISTS discharge_signatures (
  petition_id  TEXT NOT NULL,
  name         TEXT NOT NULL,           -- as the Clerk lists it
  bioguide_id  TEXT,                    -- from the Clerk's link to the Member's page
  official_id  TEXT,                    -- the official with that Bioguide ID, when loaded
  signed_on    TEXT,
  withdrawn_on TEXT,
  PRIMARY KEY (petition_id, name)
);

-- The Laws list, This week and the email show a passage without a recorded vote like any passage.
ALTER TABLE bill_list ADD COLUMN passage_method TEXT;
ALTER TABLE bill_list ADD COLUMN passage_chamber TEXT;
ALTER TABLE bill_list ADD COLUMN passage_date TEXT;
