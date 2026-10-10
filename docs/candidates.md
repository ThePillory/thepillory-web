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
- Once included, a candidate keeps their page. If the FEC stops listing them as active, the entry stays with `listed: false` and the date they were last listed.

## Order and cards

- With a certified list: the candidates on the ballot in ballot order (`ballotOrder()` in `functions/_lib/elections.js`), then "Also filed with the FEC (not on the November ballot)", alphabetically.
- Without: alphabetically by last name as filed.
- Every card is the same: name, party as filed (or party preference and ballot designation as certified), "Incumbent" where the source says so, and any office the candidate holds or held in ThePillory's records. No money on the cards.

## Labels (`standing()`)

| When | Label |
|---|---|
| Before the election, on the ballot or in a state with only the FEC list | Candidate · Not yet in office (line: "Filed for [office], [year]" or "Running for…" on a certified list) |
| A certified list exists and they aren't on it | Filed for [office], [year] · Not on the November ballot |
| The FEC no longer lists them as active | Filed for [office], [year] · last listed [date] |
| After the election, on the certified ballot | Ran for [office], [year] |
| After the election, FEC list only (no primary results) | Filed for [office], [year] |
| Holds the office (an incumbent, or a winner once the sync loads them) | In office · [office], linked to the official page |

The general election date comes from `data/elections/dates.json`. Winners get their official page when the sync loads new officeholders; the candidate page stays.

## Other offices held

`officesHeld()`: by FEC ID through `fec_candidates` (members of Congress), otherwise by name among the state's officials (current and former) only when exactly one has that first and last name (`officialFor()` in `functions/_lib/civic.js`); the Votes tab says when a link was matched by name.

## Data: `data/candidates/<year>/<st>.json`

Built by `tools/build_candidates.mjs` in the "Refresh candidate data" workflow (`.github/workflows/candidates.yml`, twice a day, `FEC_API_KEY`). Each run reads up to `--max-requests` (800) FEC requests, one every 3.7 seconds (the FEC allows about 1,000 an hour), candidates read longest ago first; a "slow down" (429) is waited out up to three times, then the run stops cleanly and saves what it read:

- totals: `/candidate/<id>/totals/?cycle=&election_full=false`, read with `parseTotals()` from `workers/sync/src/funding/fec.js` (the same as officials);
- organizations: Schedule A line 11C (`F3-11C`, PACs and other committees) for the principal committee, summed by giving committee with `aggregatePacs()`, the 25 largest kept;
- campaign website: the principal committee's `website` from its FEC record (Form 1), refreshed every 30 days. Nothing else from the committee record is stored (no email, phone, address or treasurer).

The principal committee ID comes from the FEC candidate search (`principal_committees`, designation P) in `tools/build_federal_races.py`.

## Platform tab

The sync Worker's `candidate-platforms` step (`workers/sync/src/promises/candidates-sync.js`, after `issues-pages`):

- reads `data/candidates/<year>/websites.json` (every listed candidate with a campaign website from their FEC filing; written by the builder) from `SITE_URL`;
- searches each site with the officials' finder (`findOnSite()`: the home page's Issues / Priorities / Platform links, then `/issues` and `/priorities`; the page counts only when its own heading says so);
- picks a short excerpt with the officials' instructions (`excerptInstructions("candidate")`: one to three consecutive sentences, at most 450 characters, the passage that sums up the page, chosen the same way for everyone) and keeps it only when `checkExcerpt()` finds it on the page word for word;
- stores it in `candidate_platforms` (migration 0022). Never-searched candidates first, then the longest ago; again every `CANDIDATE_PLATFORMS_RECHECK_DAYS` (30), errors after 3 days; `CANDIDATE_PLATFORMS_DAILY` (25) sites a day, each with at most one AI call.

The tab shows "In their own words" (the excerpt, the date, a link to the whole page, "Excerpt picked automatically and checked word for word against the page"), or what the search found: an issues page with no excerpt yet, "No issues page found" with the campaign website, not searched yet, or no website in the filing. A person can hide an excerpt, have it picked again, or remove a wrong page at `/admin/review/promise/candidates/`; a removed page goes into `promise_pages_removed` and is never found again. Commitments tracked (promises) stay for officials.

## Next

- 2027–2028 candidates: run the builder with `--year 2028` once `data/elections/federal-2028/` exists.

## Tests

`workers/sync/test/candidates.test.mjs`.
