-- Which committees count (docs/funding.md), the second part:
-- 1. funding_progress.committees_at: when an official's committees for the period (official_committees,
--    migration 0054) were last read. An official whose current period has none yet is read in the next
--    sync whatever the step's weekly cadence (src/cadence.js), once; afterwards the normal cadence.
-- 2. state_campaign_committees.kind and office: every California committee Cal-Access links to the
--    official as one they control (FILER_LINKS_CD type 12011), with its type, from tools/build_ca_campaign.py:
--    'candidate' (a campaign committee, `office` the office it's for when its statements name one),
--    'officeholder' (an officeholder account) or 'ballot-measure' (a ballot measure committee they control).
ALTER TABLE funding_progress ADD COLUMN committees_at TEXT;
ALTER TABLE state_campaign_committees ADD COLUMN kind TEXT;
ALTER TABLE state_campaign_committees ADD COLUMN office TEXT;
