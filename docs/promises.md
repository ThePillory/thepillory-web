# Promises

A promise is a **specific, checkable commitment** an official made, quoted exactly, with the date and the source. Not general values, priorities or positions. Promises are shown on each official's **Promises** tab, and only after a person approves them.

## Sources

The same kinds of source for everyone in the same office. Coverage starts with the President, California's Governor and Calaveras County's supervisors (`trackedOfficials` in `workers/sync/src/promises/index.js`).

| Official | Sources | How they're read |
|---|---|---|
| The President | Official press releases; the inaugural address; addresses before a joint session of Congress (State of the Union) | `whitehouse.gov/releases/feed/` (full text in the feed; the first run reads 3 pages, then the newest page daily); `whitehouse.gov/remarks/feed/` (the inaugural address); govinfo's Compilation of Presidential Documents (`api.govinfo.gov/collections/CPD`, with `GOVINFO_API_KEY` or the api.data.gov key in `CONGRESS_API_KEY`), addresses only, from the President's term start when it's on record |
| The Governor | Official press releases, including State of the State and inaugural addresses posted there | gov.ca.gov's WordPress API, category "Press releases" (17), full text (`wp-json/wp/v2/posts?categories=17`); the first run reads 3 pages of 20, then the newest page daily; and a daily search for "State of the State" (`search=State of the State`), keeping posts titled as the address |
| Calaveras supervisors | Board of Supervisors meeting agendas, and minutes when the county posts them | The agenda text the meetings step already loads (`meeting_items`), for meetings in the last 60 days. A commitment counts only when the supervisor is named in the document. The county's meeting portal (Tyler Meeting Manager) lists a minutes record for each meeting but hadn't published any as of October 2026; adopted minutes appear only inside agenda packets, which aren't downloaded (often over 100 MB). Expect few supervisor candidates until minutes are published on their own |

| Any official | Their campaign or office website's "Issues" or "Priorities" page, listed by a person on `/admin/review/promise/pages/` (never guessed) | `promise_pages` (migration 0013). Each page is fetched weekly (`PROMISE_PAGES_REFRESH_DAYS`, 7; 10 a day), its text (navigation and footer left out) hashed, and sent to be read again only when the text changes. Read right after addresses. Keep the same kind of page for every official in the same office. |

Press releases that are lists rather than statements (appointments, nominations sent to the Senate, legislative updates, proclamations) are left unread by title (`worthReading` in `sources.js`).

## How a candidate is proposed

In the analysis phase of each run (`runPromises`, after agenda watch):

1. **Discover**, once a day, no AI: new documents go into `promise_sources` as `pending` (with their text until they're read).
2. **Read**: an AI model (`PROMISE_MODEL`, default the analysis model) reads one document at a time with the same instructions for everyone (`src/promises/prompt.js`, `PROMISE_PROMPT_VERSION`), and returns at most 3 candidates: the exact quote, a short neutral note on what would show it done, and a deadline only if the quote states one. Before any AI call, code looks for sentences that commit to an action (`commitmentScore` in `sources.js`: will, plan to, by a year, within a stated time; not statements of values). A document with none is skipped without AI and noted ("no sentence committing to an action"); most press releases report what was done and have none. Officials **take turns** (`roundRobin`); within each official, addresses first, then the documents with the most commitment sentences, then the newest, so the few reads a day go to the documents most likely to hold a promise.
3. **Check, in code** (`src/promises/check.js`), before anything is saved:
   - the quote is in the document **word for word** (only spacing, curly quotes, dashes, outer quotation marks and a trailing comma may differ); a quote that isn't is dropped, never corrected;
   - it's a commitment (will, plan to, by a date…), not a statement of values;
   - the note is neutral: no judging or dramatic words, no predictions, no "failed to";
   - on a county agenda, the supervisor is named in the document;
   - a deadline is kept only when the quote states it.
4. Candidates that pass are saved as `review = 'suggested'`. Each document's outcome (how many suggested, why others were dropped, tokens) is in `sync_log` (`promises`, `promise-sources`).

**Caps**, so review keeps up: `PROMISE_SUGGESTIONS_DAILY` (default 3) new suggestions a day, `PROMISE_DOCS_DAILY` (default 6) documents read a day, and none at all while `PROMISE_QUEUE_MAX` (default 12) suggestions wait for review.

## Review (`/admin/review/`, behind Cloudflare Access)

- **Suggested promises**: the quote, the official, the date, a link to the source, and the note. **Approve** (with your name, shown on the page as "Reviewed by [name], [date]") or **Reject** with a reason. The quote can't be edited; the note can (`/admin/review/promise/<id>/`), with the same neutral-wording check.
- **Approve selected**: tick suggestions (or "Select all") and approve them at once, with your name. Reject or edit a note on the suggestion itself.
- **Add a promise by hand** (`/admin/review/promise/new/`): the official (picked from the list), the quote word for word, the date, the kind of source (including a meeting video and an interview), the source link, the time in a video (h:mm:ss; a YouTube link opens at that time, other players show the time beside the link), the source's title, what would show it done, a deadline only as the quote states it, and your name. The same checks run in code as for AI suggestions (neutral note, a deadline only from the quote, an http(s) source); a quote that doesn't read as a commitment is refused unless you tick "This is a specific commitment". It's saved approved, with "Added by [name]".
- **Issues and priorities pages** (`/admin/review/promise/pages/`): list or stop reading an official's campaign or office page.
- **Approved promises → record a status change**: the new status (No action yet, In progress, Kept, Broken), the evidence in plain words, the date of the evidence, a source link (http or https) and your name. All are required. Each change is a row in `promise_status_changes` (from, to, evidence, date, source, who, when) and stays listed under the promise.

## On the official's page

The Promises tab lists approved promises, newest first: the source kind and date, the status, the quote, what would show it done (and a deadline as stated), the source link, "Reviewed by", and the full status history with each change's evidence and source. Status colors follow the design rules: Kept navy, Broken `#8A3B12`, In progress and No action yet gray.

## The Platform tab (`platformTab` in `functions/_lib/promises.js`)

Promises appear on each official's **Platform** tab (About · Platform · Votes · Funding · More; old `#promises` links open it), in two parts:

1. **In their own words**, at the top:
   - **An excerpt from each listed Issues or Priorities page**: one to three sentences, word for word (`src/promises/excerpt.js`). When the sync reads a page (weekly), it asks the AI for the passage that sums up the page in the official's own words, with the same instructions for everyone (the page's own opening summary when there is one; never the passage most likely to make them look good or bad), then checks in code that it's on the page word for word and at most 450 characters. It's picked again monthly (`EXCERPT_REFRESH_DAYS`), or as soon as it's no longer on the page. Shown with the page's link, "as of" the date it was taken, and who chose it. On `/admin/review/promise/pages/` a person can paste a different excerpt (checked word for word against the page's last-read text; it stays while it's on the page), hide it, or let the AI pick again.
   - **Statements the official's office submitted** (`official_statements`, migration 0014), recorded on `/admin/review/promise/statements/`: shown in full and exactly as sent (paragraphs kept, up to 3,000 characters), labeled "Submitted by the official" with the date sent and, if the office also published it, that link. How it reached ThePillory is recorded but not shown. A removed statement is kept with the reason and no longer shown. Officials' own logins to submit directly come with accounts.
2. **Commitments tracked**: the approved promises with their statuses, shown **only when at least one promise has been approved**.

With nothing in either part, the tab says "No platform recorded yet" and explains both parts.

## Tables (`workers/sync/migrations/0011_promises.sql`, `0013_promise_sources.sql`, `0014_platform.sql`)

- `promises`: one row per candidate; unique per official and normalized quote, so the same promise isn't suggested twice.
- `promise_status_changes`: every status change, never edited.
- `promise_sources`: each document seen, read once, with what came of it.

## Testing

`node workers/sync/test/promises.test.mjs` (the checks, the parsers, the reading order), and `workers/sync/test/run-local.sh`, which runs the step against fake White House, gov.ca.gov and govinfo sources and a fake drafter (`test/promise-fixtures.mjs`): some candidates pass, others are built to be dropped (misquoted, a value, loaded wording); then it approves one, refuses status changes without evidence or a source link, records one with both, and checks the official's page.
