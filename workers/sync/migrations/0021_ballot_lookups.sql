-- "Open your ballot" with an address (/ballot/<st>/): a per-visitor daily limit
-- on lookups, so the Google Civic Information API's quota can't be used up.
-- Only the daily-rotating visitor hash and the time are kept: never the
-- address, the state or anything the lookup returned.
CREATE TABLE IF NOT EXISTS ballot_lookups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ballot_lookups_visitor ON ballot_lookups (visitor, created_at);
