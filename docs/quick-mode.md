# Quick mode

A **Quick / Detailed** switch under the header of every page. Quick shows a short card in plain words at the top of a page; Detailed is the site as it was. The choice is kept in the browser only (`localStorage` "pillory_mode"); nothing goes to the server, there are no accounts, and nobody is asked their age. Detailed is the default. Without JavaScript the switch doesn't show and every page is Detailed.

Same rules as everywhere else: facts only, neutral wording, no party colors, and the source one tap away. Simpler words, same truth.

## How it works

- **The switch** is in `site_header()` (`tools/build.py`); `assets/app.js` sets `data-mode="simple"` on `<html>` and remembers it. A one-line script in every page's `<head>` sets it before the page draws, so there's no flash.
- **Every page carries both versions.** A page with a Quick card wraps its sections in `.simple-scope`; in Quick mode only the title area (`.summary-head`, `.rep-head`, `.page-head`), the card (`.simple-card`) and anything marked `.simple-keep` show. "See the details" switches to Detailed and goes to the full page. The pages are the same for everyone, so they stay cached at the edge.
- **The cards** (`functions/_lib/simple.js`):

| Page | Lines |
|---|---|
| Bill | What it does · Where it stands (`billStands()`: "Passed the Senate. Waiting on the House.", "Became law on …", "Vetoed by …") · How your reps voted (final passage, with saved districts) · Supporters say / Critics say when the source has both |
| Executive order | What it does · Where it stands (signed, revoked, court records) · Who issued it |
| Reps tab | Your representatives and Search stay; Browse (Federal / State / Courts) sits behind "Browse all" |
| Official | Who they are · Their job (`jobSentence()`, by office) · Latest votes (three, in plain words) · In their own words (the Platform excerpt) · Money (one line from FEC totals, with a link to the Funding tab) |
| The Supreme Court | What it is · Who's on it · Latest decisions (the Court's own one-line summaries) |
| A decided case | What the Court decided (the Court's summary) · Where it stands · How the justices lined up (only when it's simple: unanimous, or everyone in the majority or dissent) |
| Ballot measure | What it does · A Yes vote means / A No vote means (word for word from the official guide, California) · Where it stands |
| Ballot preview | What's on it · Your exact ballot (the statewide list and the address card stay) |

- **The home page and every state page** (one template, `functions/_lib/home.js`; the Quick parts in `functions/_lib/quick-home.js`) change the most. Quick shows, in order: the headline on one line (no subhead); the map (the U.S. map on `/`, the state's own map on `/states/<name>/`); the ballot card (in its window); **Your representatives**; **This week**; Elections; then three links, Explore the map, Topics and How government works. These are the same cards Detailed shows (`.simple-keep`), not copies; the nation and Topics stay in Detailed. It fits about two phone screens.
  - **This week**: a Congress / [State] switch and up to five sentences built from recorded facts only: laws signed or vetoed (`bill_outcomes`), final-passage votes in Congress (with how the state's two senators voted) and in the state legislature (`bill_list`), Supreme Court decisions (the latest term file), executive orders (the President's; California's Governor's). One fixed rule picks them, the same for every state: up to two final actions first (`FINAL_FIRST`), then the newest, from the last 30 days (`THIS_WEEK_DAYS`), at most five (`THIS_WEEK_MAX`). Never by topic or side. A bill's checked plain line (`plain_summaries`) follows its number when it has one; otherwise its official title, word for word. Each sentence links to its page and shows its date.
  - **Your representatives**: one row each for the President, the state's two U.S. Senators and the Governor, each with its job in plain words ("Writes federal laws for the whole state", "Runs the state government"); then the House member and state legislators once the visitor's districts are known in this state, or the ZIP or address box.
- **Constitution chips** keep their links and show a plain name ("Speech, religion, press, assembly" for the First Amendment).
- **The glossary**: words like cloture, veto override, committee, roll call and ballot measure get a dotted underline the first time they appear on a page; a tap shows a one-sentence definition.

## The glossary file

`data/glossary.json`, one file anyone can review: `terms` (term, aliases, one-sentence definition) and `constitution` (a plain name for each provision id in `data/constitution.json`; a clause without its own falls back to its section's, then its article's or amendment's). `workers/sync/test/plain.test.mjs` checks every id is real and every definition is short.

## "What it does": the plain rewrites

The sync's `plain-summaries` step (`workers/sync/src/plain/`) rewrites, in plain words, a summary the site already shows, never anything new:

- bills: a person's summary; the official summary's "This bill …" part (Congressional Research Service, or the Legislative Counsel's Digest); or the checked analysis's summary with its supporters and critics lines;
- executive orders: the checked analysis's summary, supporters and critics;
- ballot measures: the official summary (California's Attorney General, Washington's ballot title, a county measure's question), from the election files (`PLAIN_ELECTIONS`).

Every rewrite is checked in code (`check.js`) and kept only when it passes: one or two sentences and at most 40 words; a reading grade of 9.5 or lower (Flesch-Kincaid, about 8th grade); every number and every name in it is in the source; no loaded or judging words (the shared list plus plain-language ones like "common-sense" and "giveaway"); and supporters and critics both or neither, only when the source has both, each at most 30 words and of similar length. It's stored in `plain_summaries` (migration 0023) and shown as "Simplified by AI from [source], with no new facts added", linked to the methodology. A refused rewrite is recorded in `plain_attempts` and tried again only when its source changes. Bills with the latest final votes go first, then orders, then measures; `PLAIN_DAILY` (40) a day. Until an item has one, its card shows the first sentence of its own summary, word for word, with that summary's source.

## Tests

`workers/sync/test/plain.test.mjs` (the checks, the step with a fake model and SQLite, the plain helpers, the glossary, and the cards on the Court, a measure and the ballot preview); `quick-home.test.mjs` (This week's rule and wording, Your representatives, and the order of the Quick home page on `/`, California and Texas); `state-template.test.mjs` and the page tests still check the Detailed pages.
