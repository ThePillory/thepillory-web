# Promises

A promise is a **specific, checkable commitment** an official made, quoted exactly, with the date and the source. Not general values, priorities or positions. Promises are shown on each official's **Platform** tab as soon as they pass the code checks below, labeled **"AI-identified, auto-checked"**; a person checks a random sample, every promise a reader flags, and every "Broken" status before it's shown.

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
4. A page found is added to `promise_pages` as **found automatically**, and the promises step reads it: an excerpt for "In their own words", and commitments, published once they pass the checks. Each search is recorded in `issues_page_checks` (found, none, no website, or couldn't be read).

**Order**: Calaveras County's representatives first (its supervisors, its members of Congress and its state legislators), then the rest of California's officials, then everyone else. `ISSUES_PAGES_DAILY` (40) officials are searched a day; a site is searched again every `ISSUES_PAGES_RECHECK_DAYS` (90), and one that couldn't be read is tried again after 3 days. A website shared by several officials (an agency's home page) isn't treated as anyone's own.

**On the Platform tab**, an official with no page found shows "No issues page found" with a link to their website and the date it was searched. A page found but not read yet is listed with its link. A site that couldn't be read says so.

**Removing a wrong page**: on `/admin/review/promise/pages/`, "Remove: wrong page" deletes it and records it in `promise_pages_removed`, so the automatic search never adds it again.

**Campaign websites**: none are on file yet (Congress.gov, Open States and the county list give office websites). A campaign page a person lists on the review page is read the same way.

In a test on real sites (October 2026), the finder found an Issues page for 76 of 95 member and senator sites it could read. Most of the rest have no single issues page (for example, issue topics listed only in a menu). California State Senate sites had none; State Assembly sites refused automated requests from the test runner, and are reported as "couldn't be read" until they can be.

Press releases that are lists rather than statements (appointments, nominations sent to the Senate, legislative updates, proclamations) are left unread by title (`worthReading` in `sources.js`).

## How a promise is found and published

In the analysis phase of each run (`runPromises`, after agenda watch):

1. **Discover**, once a day, no AI: new documents go into `promise_sources` as `pending` (with their text until they're read).
2. **Read**: an AI model (`PROMISE_MODEL`, default the analysis model) reads one document at a time with the same instructions for everyone (`src/promises/prompt.js`, `PROMISE_PROMPT_VERSION`), and returns at most 3 candidates: the exact quote, a short neutral note on what would show it done, and a deadline only if the quote states one. Before any AI call, code looks for sentences that commit to an action (`commitmentScore` in `sources.js`: will, plan to, by a year, within a stated time; not statements of values). A document with none is skipped without AI and noted ("no sentence committing to an action"); most press releases report what was done and have none. Officials **take turns** (`roundRobin`); within each official, addresses first, then the documents with the most commitment sentences, then the newest, so the few reads a day go to the documents most likely to hold a promise.
3. **Check, in code** (`src/promises/check.js`), before anything is saved:
   - the quote is in the document **word for word** (only spacing, curly quotes, dashes, outer quotation marks and a trailing comma may differ); a quote that isn't is dropped, never corrected;
   - it's a commitment (will, plan to, by a date…), not a statement of values;
   - it's **specific and checkable** (`notSpecific`): after the commitment word comes an action that is checkable by itself (sign, veto, vote for or against, introduce, repeal, issue an order, hold a hearing, appoint), or a concrete action (build, fund, open, cut, hire, repave …) with something to check it against (a deadline, a number or amount, a named bill or measure). General aims ("fight for working families", "protect Social Security", "make California safer", "create jobs") are dropped;
   - the note is neutral: no judging or dramatic words, no predictions, no "failed to";
   - on a county agenda, the supervisor is named in the document;
   - a deadline is kept only when the quote states it.
4. **Publish**: candidates that pass are saved as `review = 'auto'` and shown at once, labeled "AI-identified, auto-checked" (linked to the methodology), with the quote, the date and the source link. Every promise starts at **No action yet**. A random `SPOT_CHECK_RATE` share (10%, the same as analyses) is marked `spot_check = 1` for a person. Each document's outcome (how many published, why others were dropped, status changes, tokens) is in `sync_log` (`promises`, `promise-sources`).
5. **Status updates**, in the same read: the AI is given the official's published promises that are still open (No action yet or In progress, made before the document) and reports a passage showing one moving, with the passage word for word and a short neutral note. Code checks that the promise is in the list, the move is forward (No action yet → In progress → Kept, or → Broken), the passage is in the document word for word and isn't the promise itself, and the note is neutral. Then:
   - **In progress** and **Kept** are recorded at once in `promise_status_changes` (`auto = 1`, the passage in `evidence_quote`, the document as the source), shown in the promise's history as "AI-identified, auto-checked";
   - **Broken** goes to `promise_status_suggestions` and is shown only after a person confirms it on `/admin/review/`.
   Documents from an official with open promises are read even without a commitment sentence, since they may show one kept.

**Earlier suggestions** (saved as `suggested` before promises published on their own) are checked again by every run without AI (`publishBacklog`): those that pass today's checks are published as AI-identified, auto-checked (their quote was checked word for word when saved); the rest stay on the review page under "Held back by the checks", with the reason, and aren't public.

**Caps** on AI cost: `PROMISE_SUGGESTIONS_DAILY` (default 10) new promises a day and `PROMISE_DOCS_DAILY` (default 15) documents read a day.

## Review (`/admin/review/`, behind Cloudflare Access)

Nothing about promises blocks on the queue: it holds only what needs a person.

- **"Broken": waiting for you**: the promise, the passage (word for word) and note, the date and the source. **Record as Broken** (with your name; a row in `promise_status_changes`) or **Don't record** (kept, not shown).
- **Flagged by readers**: promises with open "Something wrong?" reports, with each reason and note. **Keep it up** (it then shows "Reviewed by [name], [date]") or **Take it down** with a reason (kept with its history, no longer shown); either closes the reports. To change its status or note first, open it.
- **Spot checks**: the random sample of auto-published promises. **Looks right** ("Reviewed by") or **Take it down**.
- **Held back by the checks**: earlier suggestions that don't pass today's checks. **Publish** ("Reviewed by"), **Publish selected** in a batch, or **Reject**.
- On any promise (`/admin/review/promise/<id>/`): the quote can't be edited; the note can, with the same neutral-wording check.
- **Add a promise by hand** (`/admin/review/promise/new/`): the official (picked from the list), the quote word for word, the date, the kind of source (including a meeting video and an interview), the source link, the time in a video (h:mm:ss; a YouTube link opens at that time, other players show the time beside the link), the source's title, what would show it done, a deadline only as the quote states it, and your name. The same checks run in code as for AI suggestions (neutral note, a deadline only from the quote, an http(s) source); a quote that doesn't read as a commitment is refused unless you tick "This is a specific commitment". It's saved approved, with "Added by [name]".
- **Issues and priorities pages** (`/admin/review/promise/pages/`): list or stop reading an official's campaign or office page.
- **Published promises → record a status change**: the new status (No action yet, In progress, Kept, Broken), the evidence in plain words, the date of the evidence, a source link (http or https) and your name. All are required. Each change is a row in `promise_status_changes` (from, to, evidence, date, source, who, when) and stays listed under the promise.

## On the official's page

Commitments tracked lists published promises, newest first: the source kind and date, the status, the quote, what would show it done (and a deadline as stated), the source link, "AI-identified, auto-checked" or "Reviewed by [name], [date]", and the full status history with each change's evidence (the passage word for word when the AI found it) and source. Each has **Something wrong?** (no account; Turnstile and 5 reports a day per visitor, shared with the analysis flags; reasons: not a specific promise, misquoted or out of context, wrong status, unfair wording, other), posting to `/reps/<slug>/promises/<id>/flag`. A flagged promise stays up, marked **Under review**, until a person decides. Status colors follow the design rules: Kept navy, Broken `#8A3B12`, In progress and No action yet gray.

## The Platform tab (`platformTab` in `functions/_lib/promises.js`)

Promises appear on each official's **Platform** tab (About · Platform · Votes · Funding · More; old `#promises` links open it), in two parts:

1. **In their own words**, at the top:
   - **An excerpt from each listed Issues or Priorities page**: one to three sentences, word for word (`src/promises/excerpt.js`). When the sync reads a page (weekly), it asks the AI for the passage that sums up the page in the official's own words, with the same instructions for everyone (the page's own opening summary when there is one; never the passage most likely to make them look good or bad), then checks in code that it's on the page word for word and at most 450 characters. It's picked again monthly (`EXCERPT_REFRESH_DAYS`), or as soon as it's no longer on the page. Shown with the page's link, "as of" the date it was taken, and who chose it. On `/admin/review/promise/pages/` a person can paste a different excerpt (checked word for word against the page's last-read text; it stays while it's on the page), hide it, or let the AI pick again.
   - **Statements the official's office submitted** (`official_statements`, migration 0014), recorded on `/admin/review/promise/statements/`: shown in full and exactly as sent (paragraphs kept, up to 3,000 characters), labeled "Submitted by the official" with the date sent and, if the office also published it, that link. How it reached ThePillory is recorded but not shown. A removed statement is kept with the reason and no longer shown. Officials' own logins to submit directly come with accounts.
2. **Commitments tracked**: the published promises with their statuses, shown **only when at least one is published**.

With nothing in either part, the tab says "No platform recorded yet" and explains both parts.

## Tables (`workers/sync/migrations/0011_promises.sql`, `0013_promise_sources.sql`, `0014_platform.sql`, `0019_promises_auto.sql`)

- `promises`: one row per promise; unique per official and normalized quote, so the same promise isn't recorded twice. `review`: `auto` (published, AI-identified, auto-checked), `approved` (published, reviewed by a person), `suggested` (held back), `rejected` (not shown). `published_at`, `spot_check`, `check_reason`.
- `promise_status_changes`: every status change, never edited (`auto`, `evidence_quote`).
- `promise_status_suggestions`: "Broken" suggestions waiting for a person, and how each was decided.
- `promise_flags`: reader reports, open until a person resolves them.
- `promise_sources`: each document seen, read once, with what came of it.

## Testing

`node workers/sync/test/promises.test.mjs` (the checks, the parsers, the reading order), and `workers/sync/test/run-local.sh`, which runs the step against fake White House, gov.ca.gov and govinfo sources and a fake drafter (`test/promise-fixtures.mjs`): some candidates pass and are published, others are built to be dropped (misquoted, a value, a general aim, loaded wording); then it confirms one, refuses status changes without evidence or a source link, records one with both, and checks the official's page.
