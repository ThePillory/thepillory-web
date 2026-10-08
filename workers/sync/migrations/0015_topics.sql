-- Topics: a fixed list of subjects (workers/sync/src/topics/list.js) that ties
-- bills, county agenda items, executive actions and Platform excerpts together.
-- See docs/topics.md.
--
-- One row per topic on an item. An AI model tags each item with up to three
-- topics and a short reason; a person can correct them on /admin/review/topics/.
-- A tag is never deleted: a correction marks it removed (with who, when and why)
-- and adds the person's tags, so the history stays.
CREATE TABLE IF NOT EXISTS topic_tags (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_kind      TEXT NOT NULL CHECK (item_kind IN ('bill', 'meeting_item', 'executive_action', 'platform')),
  item_id        TEXT NOT NULL,              -- bills.id; "<meeting id>/<item key>"; executive_actions.id; promise_pages.url
  topic          TEXT NOT NULL,              -- a slug from the topic list
  reason         TEXT NOT NULL DEFAULT '',   -- one short, neutral sentence
  tagged_by      TEXT NOT NULL,              -- the model, or "person:<name>"
  prompt_version TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at     TEXT,
  removed_by     TEXT,
  removed_note   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS topic_tags_live ON topic_tags (item_kind, item_id, topic) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS topic_tags_topic ON topic_tags (topic, item_kind, created_at) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS topic_tags_item ON topic_tags (item_kind, item_id);

-- Which items have been tagged (including those given no topic, like a roll
-- call), for what text, so nothing is sent twice. An item a person corrected is
-- locked: the AI doesn't tag it again.
CREATE TABLE IF NOT EXISTS topic_runs (
  item_kind  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  text_hash  TEXT,                           -- of the text that was tagged (an excerpt can change)
  tagged_at  TEXT NOT NULL DEFAULT (datetime('now')),
  model      TEXT,
  locked_by  TEXT,                           -- a person's name, once they've corrected it
  locked_at  TEXT,
  PRIMARY KEY (item_kind, item_id)
);
