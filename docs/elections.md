# Elections

What's on the ballot, from official sources only. Pages: `functions/elections/[[path]].js` (plus the Elections section on Home, and "On the ballot" on county and district pages); shared code: `functions/_lib/elections.js`; data: `data/elections/<id>.json`.

## Where the data comes from

`tools/build_elections.py` builds `data/elections/<id>.json` (standard library plus `pdftotext` from poppler-utils). It runs in GitHub Actions, "Refresh election data" (`.github/workflows/elections.yml`), daily at 13:41 UTC and on demand, and commits the file when it changes. The official sites aren't reachable from everywhere, so don't expect it to run on a laptop or in a sandbox.

| What | Source |
|---|---|
| Contests, candidates, ballot designations, party preference, incumbent mark | Secretary of State, Certified List of Candidates (PDF) |
| Supreme Court and Court of Appeal retention questions, with each district's counties | The same list, at its end |
| Ballot order | The Secretary of State's randomized alphabet (its press release for the election); the method is on sos.ca.gov/elections/randomized-alphabet |
| Statewide candidate statements | Official Voter Information Guide, one page per office |
| Propositions: official title and summary (Attorney General), what a yes and a no vote mean, the summary of the Legislative Analyst's fiscal estimate, and each argument and rebuttal with its signers | Official Voter Information Guide: each proposition's page, its Official Title and Summary page (`title-summary.htm`) and its Arguments and Rebuttals page |
| Calaveras local contests | County's Qualified Candidates List (PDF), contests marked "On Ballot: Yes" |
| Calaveras candidate statements, Measure A (question, impartial analysis, tax rate statement, arguments) | County's Voter Information Pamphlet (PDF) |
| U.S. House candidates' FEC filings | api.open.fec.gov (`FEC_API_KEY` secret, or DEMO_KEY), matched by last name and district |
| Results | api.sos.ca.gov/returns/ (read by the pages, never stored), only after `polls_close_utc` |

Rules the builder keeps:
- Every contest and measure keeps its `source_url`.
- No candidate contact details: the county's candidate list has addresses and phone numbers, which are never read into the file; lines in a statement giving an email or phone are left out, the same for every candidate, and the statement's note says so.
- Text from a PDF is extracted as printed (paragraphs rejoined) and the PDF stays linked as the official version.
- The pamphlet is laid out with two statements per page; headings are one or two centered lines, and names come with or without "AGE:". A statement is attached only to a contest whose list has that candidate. The log lists anything not matched.

To add a county: an entry in `COUNTIES` and `HOW_TO_VOTE` in the builder (its candidate list, pamphlet, results page, elections page and Board of Equalization district), and check the log after a run. To add an election: a new `ELECTION` block, then add its id to `ELECTIONS` in `functions/_lib/elections.js` (newest first).

## Washington's statewide measures

`tools/build_wa_measures.py` builds `data/elections/2026-11-03-wa.json` in the same shape as California's file, with only the three statewide measures (no candidates or local contests; `measuresOnly()` in `functions/_lib/elections.js` shows those elections as a list of measures, and "Your ballot" points to the statewide list, since it's the same on every ballot). It runs in the same daily workflow, after California. Sources, all from the Secretary of State's site:

| What | Source |
|---|---|
| Ballot title (statement of subject, concise description, the question) and the explanatory statement ("The Law as It Presently Exists", "The Effect of the Proposed Measure if Approved") | The Attorney General's letter to the Secretary for each measure (PDF) |
| Fiscal impact statement, its summary | The Voters' Pamphlet (one English edition; its statewide section is the same in every county's). The separate fiscal PDFs drop letters where their font uses ligatures ("e ect"), so they're linked, never read |
| Arguments for and against, each side's rebuttal, who wrote them | Each measure's Voters' Pamphlet page (two columns: supporters left, opponents right). Each side's "Contact:" line is left out |
| How to vote | VoteWA (register, track your ballot, where to vote) and the Voters' Guide |

Rules the builder keeps:
- **Word for word or nothing:** every paragraph it writes is checked against its source document (line breaks evened out); a paragraph that isn't there stops the build, and the file stays as it was.
- Text with a damaged ligature (`Ư`, `Ɵ`, "e ect") stops the build.
- "Rebuttal of argument against" is the supporters' rebuttal and "Rebuttal of argument for" the opponents', so each side's argument and rebuttal sit together, as on California's pages. The pamphlet's "Written by" applies to both.
- Paragraphs are rejoined from the PDF's lines: a paragraph ends on a short line or at a page break after a full sentence; a "Label:" line starts one; a campaign's heading (nearly every word capitalized) is its own paragraph. Tests: `tools/test_build_wa_measures.py`.

The measure URLs are listed in `MEASURES` in the builder. For the next election, add its documents there (they're linked from the Secretary of State's "Proposed ballot measure information" page and the Voters' Guide).

## Open your ballot (every state)

`/ballot/` sends a visitor to their state's page (`functions/_lib/visitor-state.js`), or lists every state; `/ballot/<st>/` is `functions/ballot/[[path]].js`.

**Where the entry point sits follows the election calendar** (`functions/_lib/election-window.js`). From `WINDOW_DAYS` (45) before the next election in the visitor's state through Election Day, it's the home page's top card, directly under "Showing [State] · Change", with the date and a countdown ("Election Day: Tue, Nov 3 · 25 days"; "tomorrow", "today"), and a button on the state page. The rest of the time it's a regular link in "Your state", the Elections section and the state page. Each state's own dates come from `data/elections/dates.json`, built daily by `tools/build_federal_races.py` from the FEC's election dates: primaries, runoffs, special elections and the general election, so a state with a different primary or a December runoff gets its own window. A special election counts only for the visitor's own U.S. House district (when their districts are saved). Runoffs say they're held only for races no one won outright. "Today" is the state's own date (its main time zone).

**Before an address** (one page for the state, private because it reads the districts cookie):
- **California** uses the Secretary of State's Certified List of Candidates instead of the FEC list: only the candidates on the November ballot, in ballot order, with party preference and ballot designation as certified (a top-two primary leaves two per race, where the FEC list still has everyone who filed).
- **Federal races** elsewhere from `data/elections/federal-2026/<st>.json`, built daily by `tools/build_federal_races.py` in "Refresh election data" (`FEC_API_KEY` secret; FEC's DEMO_KEY is too rate-limited for 52 places). The U.S. Senate race only when the FEC's list of 2026 races (`/v1/elections/search/`) has one for the state (a regular or special election); candidates are the FEC's statutory candidates (`candidate_status=C`: registered and past $5,000) active in 2026, alphabetical, name and party as filed. The House race shows once the visitor's district is saved. The page says plainly that this isn't the certified ballot.
- **Incumbents** link to `/reps/<slug>/#votes` and `#funding` through `fec_candidates` (the FEC candidate ID), never by name.
- **Official links:** the state's election office from USA.gov's directory (`data/states/election-offices.json`, built weekly by `tools/build_election_offices.py` in "Refresh state officials"; it writes nothing if it finds fewer than 50) and Vote.gov's home page (its per-state paths couldn't be checked). California and Washington add their How to vote links from their election files.
- **ThePillory's own pages:** California's Your ballot and whole ballot; Washington's measures.
- Puerto Rico has no general election in 2026 (it votes in presidential years), and its page says so.

**With an address** (`POST /ballot/<st>/`, field `address`): `voterInfo()` in `functions/_lib/civic.js` calls Google's Civic Information API `voterinfo` with `returnAllAvailableData=true` and the `GOOGLE_CIVIC_API_KEY` secret (set on the Pages project). `ballotFromVoterInfo()` keeps contests in `ballotPlacement` order, candidates in the order listed (name and party only: no phone, email, site or social accounts), referendums (title, subtitle, brief, official link), polling places, early-voting sites, drop-off locations and the state's and county's official links (http(s) only). Only the city and state of the address are shown.
- `officialFor()` links a candidate to an official in the same state only when exactly one has that first and last name; `measureFor()` links a measure to ThePillory's page by its number (California's "Proposition N"; Washington's measure number).
- Errors (`CivicError`: `address`, `not-found`, `unavailable`, `no-key`) carry the HTTP status, never the request. An answer with no contests counts as no data: the page says so and links the state's official sample ballot lookup, with any polling places the answer did have.
- **The address is never stored or logged**, and the answer is sent `Cache-Control: private, no-store`. POST keeps it out of URLs and logs. Each connection may make `LOOKUPS_PER_DAY` (20) lookups a day: `ballot_lookups` (migration 0021) keeps only the daily-rotating visitor hash and the time. Before the sync applies the migration, there's no limit.
- Every page carries "Always confirm your ballot with your county election office." and the neutrality line.

## Ballot order

California orders candidates by a randomized alphabet drawn for each election (Elections Code 13112): last name first, letter by letter, then first and middle names. `ballotOrder()` applies it:
- **Statewide offices** rotate by Assembly district (13111): as drawn in AD 1, and in each later district the first name moves to the bottom. Your ballot uses the visitor's AD.
- **U.S. House** rotate among the ADs within the district, starting with its lowest-numbered AD; ThePillory doesn't have the AD list per congressional district, so it shows the drawn order and says the sample ballot may differ.
- **Legislature**: the drawn order, but a county can draw its own order where a district crosses county lines; the page says so.
- **Local contests** keep the county's list order. The tests check that it equals the computed order for every county contest (it does).
- A multi-word surname is read as the last word unless it starts with a particle (de, van, le, …), because the certified list doesn't mark it.

## Neutrality

Every candidate in a contest gets the same card with the same fields in ballot order: name, ballot designation, party preference as listed (partisan offices), the FEC filing (U.S. House), "Holds office now" with Platform, Votes and Funding links when the name matches exactly one official in D1, and the statement word for word or the same "no statement" line. Measure pages lead with the neutral official content: the official title and summary, what a Yes and a No vote mean, and the Legislative Analyst's fiscal estimate (with a link to the full analysis). The campaign arguments come after, collapsed, under the note "Written by each campaign, printed word for word from the official voter guide. Not written or checked by ThePillory or any government agency." They're in the guide's order in two matching panels: the supporters' argument with the opponents' rebuttal to it, then the opponents' argument with the supporters' rebuttal. Each part is labeled ("Supporters' argument", "Opponents' rebuttal", "Opponents' argument", "Supporters' rebuttal"), shown in full with who signed it, and a part the guide doesn't print says so.

On the official arguments page each column is an argument followed by the rebuttal to it, so a rebuttal is written by the other side. `arguments()` in `tools/build_elections.py` splits each column at every heading (an earlier version read a column as one argument, which merged each rebuttal, and its signers, into the argument above it). The pages write commas and hyphens as numeric entities (`&#44;`, `grid&#45;50`) and put some bulleted lists outside paragraphs; the parser decodes the first and keeps each list item as its own paragraph, marked "•". No endorsements, polls, predictions or race calls; results show the feed's numbers in ballot order with its "reporting" line and time.

## Results

`sosResults()` reads the Secretary of State's feed only once `pollsClosed()` (8 p.m. Pacific on Election Day), kept at the edge for two minutes; before then the feed carries test numbers. County contests and judicial retention link to the county's and the Secretary of State's results pages.

## Tests

`node --test workers/sync/test/ballot.test.mjs`: the Civic answer as shown (ballot order, no contact details, no street address), name and measure matching, errors without the address, and the pages (redirect and picker, FEC races with incumbents' links, a lookup's page private and never cached, no data said plainly, the daily limit). `node workers/sync/test/elections.test.mjs`: name parsing, ballot order and rotation, the real file's county order, which contests are on a ballot, officeholder matching, results gating, and the pages (same card for every candidate, arguments and signers, Your ballot private).
