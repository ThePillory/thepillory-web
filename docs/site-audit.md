# Site audit: real data, sample data, or nothing (2026-09-30, hub phase)

Every page and section before this change, and after. The earlier cleanup (the previous version of this file, in git history) already removed every sample page, so nothing below is sample data.

- **Real**: from an official source (D1, loaded from Congress.gov, senate.gov, Open States and the county portal; `data/constitution.json`; Census Bureau files) or plain facts about the site.
- **Sample**: invented content. The only example left is the labeled example issue on How it works.
- **Empty**: an honest empty state.

## Before this change

| Page | Section | Shows | Note |
|---|---|---|---|
| `/` | Calaveras briefing: intro, filter, This week, Issues near you, Your reps' latest votes | Real; Issues empty | No hub; everyone saw the Calaveras briefing |
| `/reps/` | Governing bodies, officials | Real | Calaveras's 7 officials only |
| `/reps/<slug>/` | About, Promises, Votes, Funding, More (Issues inside More) | Real; Promises only once approved (docs/promises.md); Issues empty | |
| `/bodies/<slug>/` | Members, meetings | Real | Calaveras's members only ("Shown here: …") |
| `/laws/`, `/laws/bills/<id>/` | Bills, analysis, votes | Real | Positions of Calaveras's officials only; no vote totals |
| `/votes/` | Final-passage votes | Real | Calaveras's officials only |
| `/meetings/`, `/meetings/<id>/` | Calendar, meeting | Real | |
| `/laws/constitution/` | Full text | Real | |
| `/issues/`, `/report/` | | Empty | "No reports yet. Reporting opens when accounts launch." |
| `/you/`, `/about/…` | | Real | One labeled example issue on How it works |
| `/search/` | | Real | |
| Header | | | Wordmark only on Home (its own header); other pages had search only |
| How a bill becomes law, How to read a vote | | Nothing | Didn't exist |
| Waitlist | | Nothing | Didn't exist |

## After

| Page | Section | Shows |
|---|---|---|
| Every page | Header (wordmark and search), nav (Home, Reps, + Report, Laws, You), footer (About, How it works, Principles, Methodology) | Real; same on every page |
| `/` hub | Headline, U.S. map (waitlist counts from D1), Find your representatives, Who represents you | Real (Census boundaries, Census Geocoder, Census ZIP files; executive officials from executive.json, whitehouse.gov and the hand-entered state file) |
| | Happening now (Congress / California) | Real: latest final-passage votes from D1, totals, public analyses only; "No plain-language summary yet" and "Not yet mapped to the Constitution" where none exist |
| | Take part: Calaveras comment deadlines | Real (agenda wording); empty state when none in 30 days |
| | Take part: Contact your representatives | Real (links to reps' pages and official sites) |
| | Communities: Calaveras (Live), waitlist | Real; counts from D1 ("No one is on the list yet" at zero) |
| | Understand | Real (explainers with linked official sources) |
| `/` briefing (districts known) | Calaveras: the county briefing. Elsewhere: your reps, their votes, Happening now | Real; empty states until data loads |
| `/calaveras/` | The county briefing | Real; Issues empty |
| `/reps/` | Lookup, your reps, bodies, by state | Real: all members of Congress and CA legislators |
| `/bodies/<slug>/` | Members (Congress: yours, then by state) | Real |
| `/laws/bills/<id>/` | Votes with totals; your reps' positions when known | Real |
| `/votes/` | Your reps' votes, or all final-passage votes with totals | Real |
| `/about/how-a-bill-becomes-law/`, `/about/how-to-read-a-vote/` | Explainers | Real, neutral, sources linked |
| `/admin/waitlist/` | Counts by county | Real (behind Cloudflare Access) |
| `/issues/`, `/report/`, rep Issues (under More) | | Empty state |
| `/about/how-it-works/` | One example issue | Sample, labeled "Example", hypothetical |

Not built yet (said plainly where relevant): reporting and accounts, promises, supervisors' votes from minutes, state and local coverage outside California and Calaveras, and federal agency comment periods (Regulations.gov; a TODO in `functions/index.js`).
