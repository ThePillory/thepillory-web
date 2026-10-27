# Candidates (not yet in office)

Pages for candidates, with the same layout as an official's page (About · Platform · Votes · Funding · More), and a page for each race. One rule for everyone, no hand-picking; no polls, predictions, rankings or contact details; individual donors are never named.

## Pages

| URL | What |
|---|---|
| `/candidates/<FEC id>/` | A candidate for the U.S. Senate or House (`functions/candidates/`). |
| `/candidates/ca/<contest>/<name>/` | A candidate on California's certified list for a state office: Governor, the statewide offices, Board of Equalization, State Senate, Assembly. |
| `/races/2026/<st>/` | Every race in the state with candidates (`functions/races/`). |
| `/races/2026/<st>/<race>/` | Every candidate in one race: `senate`, `house-<n>`, or a certified contest's id (`governor`, `state-senate-2`, …). |

All rendering is in `functions/_lib/candidates.js`. The pages are the same for everyone and kept at the edge for five minutes (`edgeCached`).

Linked from: the ballot preview (each candidate's name, "The race", "Every 2026 race in [State]"), each state page's Elections section ("Candidates in [State]"), and site search.

## Who's included

- **Congress:** every candidate in `data/elections/federal-2026/<st>.json` (`tools/build_federal_races.py`: the FEC's statutory candidates, `candidate_status=C`, active this cycle), plus every candidate for Congress on a loaded certified list with an FEC ID.
- **State offices:** every candidate on a loaded certified list (California's, `data/elections/2026-11-03.json`). Other states' governor and state races are added as their certified lists are.
- An FEC record with no name (or a House record with no district) is left out, never filled in: the builders skip it and drop one kept from an earlier run, and the `candidate-platforms` step skips any entry without a name or state. (One such record, H6AZ08210, stopped that step every day from October 12 to October 22, 2026.)
- Once included, a candidate keeps their page. If the FEC stops listing them as active, the entry stays with `listed: false` and the date they were last listed.

## Order and cards

- With a certified list: the candidates on the ballot in ballot order (`ballotOrder()` in `functions/_lib/elections.js`), then "Also filed with the FEC (not on the November ballot)", alphabetically.
- With a state's own certified list (below): its candidates as the state lists them, then "Also filed with the FEC in 2026", alphabetically, with a note that these filers' names don't match exactly one name on the list.
- Without: alphabetically by last name as filed.
- Every card is the same: name, party as filed (or party preference and ballot designation as certified), "Incumbent" where the source says so, and any office the candidate holds or held in ThePillory's records. No money on the cards.

## Incumbency (`seatOf()`, `raceIncumbency()`)

On race pages, the ballot preview and candidate pages, one plain-text label, **"Incumbent"**, last on the card's details line, styled like every other part of that line, only on the candidate who holds that exact seat now:

- the state's certified list marks them as the incumbent (California marks its state races), or
- ThePillory's records tie them to the current official in that seat (`seatOf()`: the House member for the district by `district_code`, the state legislator for the district, the statewide officer with the same office, "State Controller" matching "Controller"): the same FEC ID, or the only candidate in the race whose name matches that official (`officialFor()`). Two candidates matching the same official: neither is labeled.

Nobody else gets a label (never "Challenger"); their cards show what the official list gives them (party, ballot designation) and their links as before. The order never changes. The incumbent's card adds **"Votes and record ›"** to their official page when the records tie them (the list's mark alone gives the label, not a link). The FEC's own incumbent flag isn't used.

**Open seats:** when the seat has exactly one current holder in the records and none of the candidates is them, the race starts with "Open seat: the current officeholder, [Name], isn't running for this seat." (`openSeatLine()`, linked to their page), on the race page and in the ballot preview, and the statewide list on the ballot preview adds "Open seat: [Name] isn't running for this seat". For a U.S. Senate race, the holder is the state's senator whose class is up that year (class 2 in 2026, 3 in 2028, 1 in 2030; `senate_class`, migration 0043, from congress-legislators by the weekly `senate-classes` step, `senateClassUp()`): only when exactly one senator has that class and neither senator is a candidate, so a state with only a special election that year (no senator in the class that's up) shows no line. Never after Election Day, and never when the holder isn't in the records. `workers/sync/test/incumbency.test.mjs`.

## Labels (`standing()`)

| When | Label |
|---|---|
| Before the primary (FEC list only), or on a certified list before the election | Candidate · Not yet in office (line: "Filed for [office], [year]" or "Running for…" on a certified list) |
| FEC list only, after the office's primary (and runoff or convention) has passed (`nominations()` in `functions/_lib/election-window.js`, from `data/elections/dates.json`) | Filed for [office], [year] · "[State] chose its nominees in the primary on [date]. Whether this filer is on the November ballot: see the state's official candidate list." The FEC list doesn't say who won a primary, so nobody is called a candidate then. The race page says the list isn't the ballot and links the address lookup; search results say "Filed with the FEC" |
| A certified list exists and they aren't on it | Filed for [office], [year] · Not on the November ballot |
| A state's own certified list exists and their filing's name matches no name on it | Filed for [office], [year] · "This filing's name doesn't match a name on [State]'s certified candidate list for November" |
| The FEC no longer lists them as active | Filed for [office], [year] · last listed [date] |
| After the election, on the certified ballot | Ran for [office], [year] |
| After the election, FEC list only (no primary results) | Filed for [office], [year] |
| Holds the office (an incumbent, or a winner once the sync loads them) | In office · [office], linked to the official page |

The general election date comes from `data/elections/dates.json`. Winners get their official page when the sync loads new officeholders; the candidate page stays.

## Certified lists: other states (`data/elections/certified-2026/<st>.json`)

**The FEC filing list never stands for the ballot once a state's primary has passed.** Each state's own official list of who's on the November ballot does, once ThePillory reads it. `tools/build_certified_lists.py` (daily, in the "Refresh election data" workflow) reads:

| State | Source | What's read |
|---|---|---|
| NC | State Board of Elections, `Candidate_Listing_2026.csv` | The rows for the 11/03/2026 election; names as on the ballot |
| NJ | Division of Elections, Certification of General Election Nominees (U.S. Senate & House) and each Amended Certification | The latest certification for each race; an amendment the state links but doesn't serve leaves that race out (in October 2026: the Senate and the 9th and 10th districts) |
| FL | Division of Elections candidate download (`extractCanList.asp`, 2026 General Election) | U.S. Senate and House candidates with the status Qualified; write-in candidates (not printed on the ballot) left out |

Only names, parties as written and the incumbent mark (where the list has one) are kept; never the addresses, phone numbers or email addresses some lists include. A list that doesn't read cleanly isn't written (the earlier file stays). California's certified list comes with its full election (`data/elections/2026-11-03.json`).

Not read yet: Texas (the list is behind a JavaScript app), Pennsylvania (a form), Illinois (the page errors); New York, Ohio, Georgia and Michigan refuse GitHub's servers. Their races keep the address lookup and the link to the state's official list.

Pages (`functions/_lib/certified.js`): the ballot preview and race pages show a race's certified candidates with the source and the date read, "Names and parties as the state lists them; the order on your ballot may differ." A race the file doesn't cover keeps the address lookup. A certified name links to an FEC filing (candidate page, Votes and Funding) only when exactly one filer in the same race has the same last name and a matching first name or nickname (`sameCandidate()`, `matchFec()`), and that filer matches no other name; the same person filed under two FEC IDs is linked to neither. Otherwise the name shows without a link, never a guess.

## Other offices held

`officesHeld()`: by FEC ID through `fec_candidates` (members of Congress), otherwise, only for a candidate the filing marks as this race's incumbent, by name among the state's current officials when exactly one has that first and last name (`officialFor()` in `functions/_lib/civic.js`). A name alone never links a candidate to an office: the Votes tab says "No office matched yet". The address ballot preview doesn't link candidates to officials at all (the Civic Information API gives a name only).

## Data: `data/candidates/<year>/<st>.json`

Built by `tools/build_candidates.mjs` in the "Refresh candidate data" workflow (`.github/workflows/candidates.yml`, twice a day, `FEC_API_KEY`). Each run reads up to `--max-requests` (800) FEC requests, one every 3.7 seconds (the FEC allows about 1,000 an hour), candidates read longest ago first; a "slow down" (429) is waited out up to three times, then the run stops cleanly and saves what it read:

- totals: `/candidate/<id>/totals/?cycle=&election_full=false`, read with `parseTotals()` from `workers/sync/src/funding/fec.js` (the same as officials);
- organizations: Schedule A line 11C (`F3-11C`, PACs and other committees) for the principal committee, summed by giving committee with `aggregatePacs()`, the 25 largest kept;
- campaign website: the principal committee's `website` from its FEC record (Form 1), refreshed every 30 days. Nothing else from the committee record is stored (no email, phone, address or treasurer).

The principal committee ID comes from the FEC candidate search (`principal_committees`, designation P) in `tools/build_federal_races.py`.

## Statements, California money and Form 700s

The same sections, in the same order, for every candidate on a loaded certified list; what's missing is one plain line, never a blank.

- **Candidate statement** (`statementSection()` in `functions/_lib/candidates.js`): the statement from the state's official voter guide, word for word, with its source and link, open at the top of About (`#statement`). Race cards and the ballot preview show "Read their statement ›" or "No statement in the voter guide". California's statements come with `data/elections/2026-11-03.json` (the Secretary of State's guide for statewide races; the county's Voter Information Pamphlet for Calaveras's races). A candidate without one says "No statement in the state's Official Voter Information Guide." Washington's and the other states' loaded pamphlets carry measures only, so their candidates have no statement section yet.
- **California campaign money** (Funding tab, `stateFundingTab()`, the same as legislators): totals raised and spent, organizations by name, industries, employers and independent expenditures for and against, from the Cal-Access export (`tools/build_ca_campaign.py`, weekly). Legislative and Board of Equalization candidates are matched by seat (`file.seats`), statewide candidates by office code and name from the certified list (`file.candidates`); either only when exactly one entry matches the name (`matchCandidate()`: a nickname in parentheses or quotes and a fixed short-name list, the same for everyone) and no other candidate in the contest matches the same entry. Stored under `ca-cand:<contest>:<name>` (`candidateKey()`) by the sync's `executive-funding` step. No match: "Not loaded yet", with the Cal-Access search linked.
- **Form 700** (More → Disclosures, `stateForm700()`): the FPPC search for the candidate's name and office, in what's left of `FPPC_PER_RUN` after officials; a statement row's ID is `fppc:<index>@<key>`. None found: "No Form 700 filed for [office] under this name was found in the FPPC's search."
- **Campaign website:** only from an official filing: the FEC Form 1 for federal candidates. California's certified list has none; the builder prints the Cal-Access Form 410 columns that could hold one, and none is shown until a filing lists it.

## Platform tab

The sync Worker's `candidate-platforms` step (`workers/sync/src/promises/candidates-sync.js`, after `issues-pages`):

- `data/candidates/<year>/names.json` (every candidate with a page: ID, name, state, office, district; written by the builder with `writeNameIndex()`) is what the Reps tab's search reads;
- reads `data/candidates/<year>/websites.json` (every listed candidate with a campaign website from their FEC filing; written by the builder) from `SITE_URL`;
- searches each site with the officials' finder (`findOnSite()`: the home page's Issues / Priorities / Platform links, then `/issues` and `/priorities`; the page counts only when its own heading says so);
- picks a short excerpt with the officials' instructions (`excerptInstructions("candidate")`: one to three consecutive sentences, at most 450 characters, the passage that sums up the page, chosen the same way for everyone) and keeps it only when `checkExcerpt()` finds it on the page word for word;
- stores it in `candidate_platforms` (migration 0022). Never-searched candidates first, then the longest ago; again every `CANDIDATE_PLATFORMS_RECHECK_DAYS` (30), errors after 3 days; `CANDIDATE_PLATFORMS_DAILY` (25) sites a day, each with at most one AI call. No searches after `CANDIDATE_PLATFORMS_UNTIL` (Election Day, 2026-11-03).

The tab shows "In their own words" (the excerpt, the date, a link to the whole page, "Excerpt picked automatically and checked word for word against the page"), or what the search found: an issues page with no excerpt yet, "No issues page found" with the campaign website, not searched yet, or no website in the filing. A person can hide an excerpt, have it picked again, or remove a wrong page at `/admin/review/promise/candidates/`; a removed page goes into `promise_pages_removed` and is never found again. Commitments tracked (promises) stay for officials.

## Next

- 2027–2028 candidates: run the builder with `--year 2028` once `data/elections/federal-2028/` exists.

## Tests

`workers/sync/test/candidates.test.mjs`.
