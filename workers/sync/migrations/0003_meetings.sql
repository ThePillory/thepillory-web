-- Public meetings: Calaveras County (Board of Supervisors, Planning Commission)
-- from the county's IQM2 meeting portal, and California legislative committee
-- hearings from Open States. Every row carries a source URL.

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,                 -- "iqm2-2822" (county), "os-<event id>" (state)
  level TEXT NOT NULL CHECK (level IN ('county', 'state')),
  source TEXT NOT NULL,                -- 'iqm2' | 'openstates'
  body TEXT NOT NULL,                  -- "Board of Supervisors", "Planning Commission", "Assembly Committee on …"
  body_slug TEXT,                      -- governing body page on the site, when there is one
  meeting_type TEXT,                   -- "Regular Meeting", "Special Meeting", "Hearing"
  starts_at TEXT NOT NULL,             -- local (Pacific) date and time, "YYYY-MM-DDTHH:MM"
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'held')),
  location TEXT,
  online_url TEXT,                     -- Zoom or livestream link, as the agenda gives it
  agenda_url TEXT,                     -- official agenda (PDF)
  packet_url TEXT,                     -- agenda packet with staff reports (PDF)
  agenda_file_id TEXT,                 -- changes when the county re-posts the agenda
  posted_at TEXT,                      -- when the agenda was published, if the source says
  first_seen_at TEXT,                  -- when The Pillory first saw the agenda
  comment_text TEXT,                   -- how to comment: sentences copied verbatim from the agenda
  comment_deadline_text TEXT,          -- the verbatim sentence stating the written-comment deadline
  minutes_url TEXT,
  summary_url TEXT,
  video_url TEXT,
  participants TEXT,                   -- state hearings: JSON list of our legislators on the committee
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  details_checked_at TEXT,             -- last time the web agenda was read
  details_file_id TEXT,                -- the agenda_file_id it was read for
  pdf_checked_at TEXT,                 -- last time the agenda PDF was read (for comment instructions)
  pdf_file_id TEXT,                    -- the agenda_file_id it was read for
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS meetings_starts ON meetings (starts_at);

CREATE TABLE IF NOT EXISTS meeting_items (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_key TEXT NOT NULL,              -- the agenda number ("9"), or "s3" for an unnumbered line
  number TEXT,
  title TEXT NOT NULL,
  section TEXT,                        -- the heading as the agenda gives it
  section_kind TEXT NOT NULL DEFAULT 'regular'
    CHECK (section_kind IN ('consent', 'regular', 'public_hearing', 'closed_session', 'other')),
  item_url TEXT,                       -- the item's own page on the portal
  staff_report_url TEXT,               -- the item's staff report ("… Printout"), if attached
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON [{title, url}]
  sort INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, item_key)
);

-- Agenda watch: AI-drafted plain-language summaries and flags, one row per
-- draft (regenerating adds a row and marks the old one current = 0).
CREATE TABLE IF NOT EXISTS agenda_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  agenda_file_id TEXT,
  current INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ai_draft' CHECK (status IN ('ai_draft', 'reviewed', 'rejected')),
  items TEXT NOT NULL DEFAULT '[]',    -- JSON [{item_key, summary, flags: [...]}]
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  check_log TEXT NOT NULL DEFAULT '{}',-- JSON: what the checks removed, and why
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reviewer TEXT,
  reviewer_email TEXT,
  reviewed_at TEXT,
  edited_by TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status != 'reviewed' OR (reviewer IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agenda_summaries_meeting ON agenda_summaries (meeting_id, current);

CREATE TABLE IF NOT EXISTS agenda_summary_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id INTEGER NOT NULL REFERENCES agenda_summaries(id),
  meeting_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'edited', 'approved', 'rejected', 'reopened', 'superseded')),
  actor TEXT NOT NULL,
  note TEXT,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Suggested links between flagged agenda items and issues. Shown only once approved.
CREATE TABLE IF NOT EXISTS item_issue_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_key TEXT NOT NULL,
  issue_slug TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'rejected')),
  suggested_by TEXT NOT NULL,          -- "agenda watch (AI)" or a reviewer
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (meeting_id, item_key, issue_slug),
  CHECK (status != 'approved' OR approved_by IS NOT NULL)
);

-- Regeneration requests for agenda summaries from /admin/review.
CREATE TABLE IF NOT EXISTS agenda_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  handled_at TEXT,
  message TEXT
);

-- California legislative committees our state legislators sit on (Open States),
-- refreshed weekly, used to pick which hearings to show.
CREATE TABLE IF NOT EXISTS state_committees (
  id TEXT PRIMARY KEY,                 -- Open States organization id
  name TEXT NOT NULL,
  chamber TEXT,
  member_ids TEXT NOT NULL DEFAULT '[]', -- JSON: our officials' ids on this committee
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
