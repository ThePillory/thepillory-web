-- The official description of each bill, for the relevance check: Congress.gov's
-- CRS summary (or, before one is written, the official title as introduced), or a
-- California bill's Legislative Counsel's Digest. Fetched once per bill, before the
-- check. bills.summary stays the summary a person writes.
ALTER TABLE bills ADD COLUMN official_summary TEXT;
ALTER TABLE bills ADD COLUMN official_summary_label TEXT;
ALTER TABLE bills ADD COLUMN official_summary_url TEXT;
ALTER TABLE bills ADD COLUMN official_summary_checked_at TEXT;
