# Topics

Topics tie records about the same subject together, for a place: bills and how its representatives voted, county meeting items, executive actions, what officials say on their own Issues pages, and campaign money from industries tied to the subject. They're shown **side by side as facts**: no page says one record caused another.

## The list

One fixed list, in `workers/sync/src/topics/list.js` (19 topics: Water, Wildfire, Roads and Transportation, Housing, Land Use and Planning, Taxes and Budget, Schools and Education, Public Safety and Justice, Health, Social Services, Environment, Energy and Utilities, Agriculture, Jobs and Economy, Broadband and Technology, Veterans, Defense and Foreign Affairs, Immigration, Government and Elections). Slugs are in URLs and in `topic_tags`: never rename or reuse one. The methodology page and the search index read the list from that file (`tools/build.py`), so rebuild after changing it.

The same file holds `INDUSTRY_TOPICS`, the fixed table from campaign-funding industries (`src/funding/industry.js`) to topics. Industries without a clear subject aren't tied to any topic.

## Tagging

`src/topics/` in the sync Worker, run after each analysis round (`src/analysis/index.js` → `runTopics`):

- **What's tagged:** county agenda items (newest meetings first), Platform excerpts (`promise_pages.excerpt`; again when the text changes), executive actions, then bills with recorded votes (newest first; bills the relevance check set aside as routine aren't tagged).
- **How:** batches of 25 items to `claude-haiku-4-5` with the instructions in `src/topics/tag.js` (`TOPIC_PROMPT_VERSION`). Each item gets up to three topics and one short, neutral reason; procedure and ceremony get none. `cleanTags` keeps only listed topics and replaces a reason with judging wording.
- **Caps:** `TOPIC_DAILY_LIMIT` items a day (500 in `wrangler.toml`). Logged in `sync_log` as step `topics` (shown under Recent activity on the review page).
- **Tables** (migration `0015_topics.sql`): `topic_tags` (one row per topic on an item, with reason and who tagged it; a removed tag keeps `removed_at`, `removed_by`, `removed_note`), and `topic_runs` (which items were tagged, for what text, and `locked_by` once a person corrected them).

Item ids: bills `bills.id`; agenda items `<meeting id>/<item key>`; executive actions `executive_actions.id`; Platform excerpts `promise_pages.url`.

## Corrections

`/admin/review/topics/` (behind Cloudflare Access): the latest tagged items by kind, and "find an item" from a bill page link, an agenda item link (`…/meetings/<id>/#item-<key>`) or a bill id. On an item, tick up to three topics (or none), say why, and save: dropped tags are marked removed with your name and reason, your tags are added under your name (an AI tag you keep is re-recorded under your name, the AI's row kept as history), and the item is locked so the AI never re-tags it. Code: `functions/_lib/topic-review.js`.

## Pages

- `/topics/` and `/topics/<topic>/` (`functions/topics/`): Congress and California bills with final-passage votes, the President's and the Governor's executive actions, and officials' own words on the topic; links to a county's topic page.
- `/place/<st>/<county>/topics/` and `/place/<st>/<county>/topics/<topic>/` (routed from `functions/place/`): for that county, bills with each of its representatives' positions (every district that overlaps the county), county meeting items (live communities), executive actions, officials' own words, and money from related industries (FEC for members of Congress, this two-year period; Cal-Access for California officials, their latest period).
- Chips on bill pages, meeting items (and "Topics on this agenda"), executive orders and Platform excerpts on officials' pages; a Topics section on Home (for the visitor's county when known) and on county pages.

Rendering and queries: `functions/_lib/topics.js` and `functions/_lib/topic-pages.js`. Every query starts from the `topic_tags` topic index and reads votes by primary key, never the whole `votes` or `vote_positions` tables.

## Tests

`node workers/sync/test/topics.test.mjs`: the list and industry table, the answer checks, what's tagged next and how it's saved (re-tagging a changed excerpt, never a routine bill), corrections (history, lock), chips, and a county's topic page with everything side by side.
