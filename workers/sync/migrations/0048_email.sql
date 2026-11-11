-- The weekly email, "This week from your representatives" (docs/email.md).
--
-- Subscribers choose one of three levels, nothing else:
--   national  email only: the National edition
--   zip       a ZIP code; its districts come from data/zip/ when each edition is built
--   exact     an address looked up once by /api/districts (never stored or logged): the ZIP
--             the lookup returned and the district IDs it found
-- Never an address. Unsubscribing deletes the row. Unconfirmed rows (double opt-in) are
-- deleted after 7 days.
CREATE TABLE IF NOT EXISTS email_subscribers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,                 -- lowercased
  level         TEXT NOT NULL CHECK (level IN ('national', 'zip', 'exact')),
  zip           TEXT CHECK (zip IS NULL OR zip GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  st            TEXT,                                 -- exact: the state
  cd            TEXT,                                 -- exact: congressional district ('0' at-large)
  su            TEXT,                                 -- exact: state upper (or only) chamber district
  sl            TEXT,                                 -- exact: state lower chamber district
  co            TEXT,                                 -- exact: county FIPS
  token         TEXT NOT NULL UNIQUE,                 -- confirm, Change my place and unsubscribe links
  confirmed_at  TEXT,                                 -- NULL until the confirmation link is clicked
  confirm_sent_at TEXT,                               -- when the confirmation email last went out
  place_check_sent_at TEXT,                           -- the January district change's one "confirm your place" email
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS email_subscribers_confirmed ON email_subscribers (confirmed_at, level);

-- Each week's editions, built once and sent to everyone who shares one; also the web
-- version at /email/<week>/<edition key>/. body is the edition as JSON (sections and items),
-- so the email and the web page are rendered from the same facts.
CREATE TABLE IF NOT EXISTS email_editions (
  week          TEXT NOT NULL,                        -- the Sunday it's sent, 'YYYY-MM-DD' (Pacific)
  edition_key   TEXT NOT NULL,                        -- 'national', 'zip-95247', 'x-CA-5-4-8-06009'
  subject       TEXT NOT NULL,
  preview       TEXT NOT NULL,
  items         INTEGER NOT NULL DEFAULT 0,           -- 0: nothing new, not sent
  body          TEXT NOT NULL,
  recipients    INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  built_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week, edition_key)
);

-- Who got which week, so a retried round never sends twice. Kept 8 weeks.
CREATE TABLE IF NOT EXISTS email_sends (
  week          TEXT NOT NULL,
  subscriber_id INTEGER NOT NULL,
  edition_key   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sent', 'error')),
  error         TEXT,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week, subscriber_id)
);

-- Pending confirmation emails: the Worker's once-a-minute check reads only these.
CREATE INDEX IF NOT EXISTS email_subscribers_to_confirm ON email_subscribers (confirm_sent_at) WHERE confirmed_at IS NULL;

-- Requests from the website for the Worker to send (the website itself can't send mail):
-- a test of an edition to ALERT_TO from /admin/email/, or the waitlist invitation. The
-- Worker's once-a-minute check sends each and records when.
CREATE TABLE IF NOT EXISTS email_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('test', 'invite')),
  params      TEXT NOT NULL DEFAULT '{}',             -- test: {level, zip, st, cd, su, sl, co}
  requested_by TEXT,                                  -- the Access email of the person who asked
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  done_at     TEXT,
  result      TEXT
);

-- Sign-ups per visitor (a daily-rotating hash, never the IP address), for the daily limit.
CREATE TABLE IF NOT EXISTS email_signup_attempts (
  visitor    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS email_signup_attempts_visitor ON email_signup_attempts (visitor, created_at);

-- The waitlist gets one invitation to the weekly email, only when a person sends it
-- from /admin/email/; this records that it went.
ALTER TABLE waitlist ADD COLUMN email_invited_at TEXT;
