# Promises

A promise is a **specific, checkable commitment** an official made, quoted exactly, with the date and the source. Not general values, priorities or positions. Promises are shown on each official's **Promises** tab, and only after a person approves them.

## Sources

The same kinds of source for everyone in the same office. **Every official with a Platform page is tracked**: the President, the Governor and Calaveras's supervisors through their own documents below, and everyone else through their Issues or Priorities page, found automatically (next section) or listed by a person.

| Official | Sources | How they're read |
|---|---|---|
| The President | Official press releases; the inaugural address; addresses before a joint session of Congress (State of the Union) | `whitehouse.gov/releases/feed/` (full text in the feed; the first run reads 3 pages, then the newest page daily); `whitehouse.gov/remarks/feed/` (the inaugural address); govinfo's Compilation of Presidential Documents (`api.govinfo.gov/collections/CPD`, with `GOVINFO_API_KEY` or the api.data.gov key in `CONGRESS_API_KEY`), addresses only, from the President's term start when it's on record |
| The Governor | Official press releases, including State of the State and inaugural addresses posted there | gov.ca.gov's WordPress API, category "Press releases" (17), full text (`wp-json/wp/v2/posts?categories=17`); the first run reads 3 pages of 20, then the newest page daily; and a daily search for "State of the State" (`search=State of the State`), keeping posts titled as the address |
| Calaveras supervisors | Board of Supervisors meeting agendas, and minutes when the county posts them | The agenda text the meetings step already loads (`meeting_items`), for meetings in the last 60 days. A commitment counts only when the supervisor is named in the document. The county's meeting portal (Tyler Meeting Manager) lists a minutes record for each meeting but hadn't published any as of October 2026; adopted minutes appear only inside agenda packets, which aren't downloaded (often over 100 MB). Expect few supervisor candidates until minutes are published on their own |

| Any official | Their office website's "Issues", "Priorities" or "On the Issues" page, found automatically (below), or a campaign or office page a person lists on `/admin/review/promise/pages/` | `promise_pages` (migration 0013; `found_by` 'auto' or 'person', migration 0017). Each page is fetched weekly (`PROMISE_PAGES_REFRESH_DAYS`, 7; `PROMISE_PAGES_DAILY`, 25 a day), its text (navigation and footer left out) hashed, and sent to be read again only when the text changes. Read right after addresses. |

## Finding Issues pages automatically (the `issues-pages` step)

For every active official with a website on file (`officials.website`, from Congress.gov, Open States, the county list and the executive lists), the sync follows links from the site's home page (`src/promises/finder.js`, `src/promises/finder-sync.js`), the same way for everyone:

1. **Links**: on the home page, links on the same site whose text is "Issues", "On the Issues", "Key Issues", "Policy Issues", "Priorities", "Platform" and the like, or whose address ends in `/issues`, `/priorities` or `/on-the-issues`. Links about services, press, legislation, votes, tickets and the like don't count. The best two are followed.
2. **The page counts** only when its own first heading or title names Issues, Priorities or Platform and it has some text; or when a link named "Issues" or "Priorities" leads to an `/issues` or `/priorities` address.
3. **Otherwise** the usual addresses are tried: `/issues`, then `/priorities`.
4. A page found is added to `promise_pages` as **found automatically**, and the promises step reads it: an excerpt for "In their own words", and suggested commitments for review. Each search is recorded in `issues_page_checks` (found, none, no website, or couldn't be read).

**Order**: Calaveras County's representatives first (its supervisors, its members of Congress and its state legislators), then the rest of California's officials, then everyone else. `ISSUES_PAGES_DAILY` (40) officials are searched a day; a site is searched again every `ISSUES_PAGES_RECHECK_DAYS` (90), and one that couldn't be read is tried again after 3 days. A website shared by several officials (an agency's home page) isn't treated as anyone's own.

**On the Platform tab**, an official with no page found shows "No issues page found" with a link to their website and the date it was searched. A page found but not read yet is listed with its link. A site that couldn't be read says so.

**Removing a wrong page**: on `/admin/review/promise/pages/`, "Remove: wrong page" deletes it and records it in `promise_pages_removed`, so the automatic search never adds it again.

**Campaign websites**: none are on file yet (Congress.gov, Open States and the county list give office websites). A campaign page a person lists on the review page is read the same way.

In a test on real sites (October 2026), the finder found an Issues page for 76 of 95 member and senator sites it could read. Most of the rest have no single issues page (for example, issue topics listed only in a menu). California State Senate sites had none; State Assembly sites refused automated requests from the test runner, and are reported as "couldn't be read" until they can be.

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

**Caps** on AI cost: `PROMISE_SUGGESTIONS_DAILY` (default 10) new suggestions a day and `PROMISE_DOCS_DAILY` (default 15) documents read a day. Suggestions keep coming however many wait for review; the top of the review page shows how many are waiting.

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
