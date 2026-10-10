# ThePillory: sitemap

What's live now, and what opens when accounts launch. Everything live shows
real data (from D1 or official sources) or an honest empty state. There are no
sample pages. See docs/site-audit.md for the page-by-page audit.

## Live now

### Tab 1: Home (`/`)
- **The hub**, at thepillory.co itself, for every visitor (the old `/?hub=1` redirects here). **It's the one template for every state** (`functions/_lib/home.js`): with the visitor's state known it is that state's page, and `/states/<name>/` (`/states/washington/`, `/states/new-york/`; `/states/wa/` redirects) is the same page for that state, with the same sections in the same order. A section with no data for a state yet stays, with "Coming soon for [State]". Outside the US: the same page without Your state and the state map:
  - Headline and subtitle
  - "Showing [State] · Change" when the visitor's state is known (picked, from saved districts, or Cloudflare's approximate state for the connection; never stored): Change > a state picker (`POST /api/state`), and "Use my connection's location instead" after picking
  - U.S. map (the visitor's state "You're here", mid blue with an outline; live community states navy, waitlist states light navy; taps only, no zooming or dragging): a state > `/states/<name>/`; small-state buttons; "1 live community · [#] counties waiting" (real counts); Explore the full map > Explore
  - Ballot preview card, from 45 days before the state's next election through Election Day only: one line with the date and countdown ("Election Day: Tue, Nov 3 · 24 days") and a standard-size "Preview [State]'s ballot" button > `/ballot/<st>/`
  - Find your representatives: address or ZIP (`/api/districts`; nothing stored; district IDs kept in the browser)
  - Your state (when known): In Congress (U.S. Senators > rep pages, House members > `/reps/?state=XX`, the senators' latest final-passage votes > Bill); statewide (Governor > rep page, statewide offices); the legislature (members by chamber; recent bills once its votes are loaded > Bill, or "coming soon" with "Coming soon for [State]" with Join the list > #communities); statewide ballot measures for the next election (California and Washington: each measure > Measure; elsewhere "Coming soon for [State]" and the state's election office via USA.gov); Counties (the state's live communities as county links, Calaveras County > `/calaveras/` in California; elsewhere "Coming soon"; Every county > #map); Find your reps > #find; Map > #map
  - Your briefing link, once your districts are known > `/briefing/` (on another state's page instead: one line at the bottom, "Your place: [County, ST] · Your briefing", and Find your representatives without the "Showing:" line)
  - Elections (here, near the top, until Election Day; then after Who represents you): the next election > Election; Your ballot (once your districts are known: your district contests, courts, statewide offices and propositions, local count) > Your ballot; otherwise Find your ballot; How to vote > `/elections/#how-to-vote`
  - First-visit intro (dismissible; How it works, Principles)
  - The nation (the same spot on every state's page): the President, Vice President, the Cabinet > `/bodies/us-executive/`; Congress: U.S. Senate > `/bodies/us-senate/?state=XX`, U.S. House > `/bodies/us-house/?state=XX` (the state's members first, then "Your members" from saved districts only when they're in another state, then Members by state; without a state, as before); the Supreme Court ("Coming soon", with supremecourt.gov)
  - [State] map (`#map`; the former `/explore/<st>/`, which redirects here): map with layer toggles (`?layer=county|cd|sldu|sldl#map`; taps only), Every county (collapsed, with a filter), every district as a list, the state's statewide offices (collapsed, `#h-statewide`), the legislature's latest final votes (collapsed, `#h-leg`)
  - Happening now: Congress / California toggle (`?now=state`; on Your briefing, the visitor's state once its votes are loaded), latest final-passage votes with status, summary, constitutional chip, review label, totals, "See how your rep voted" > Bill
  - Topics: every topic as a chip > the topic's page for your county when known (`/place/<st>/<county>/topics/<topic>/`), otherwise `/topics/<topic>/`
  - Take part: Calaveras comment deadlines > Meeting (#weigh-in) (California; elsewhere "Coming soon for [State]"); Contact your representatives > Reps. (Federal agency comment periods from Regulations.gov: to do)
  - Communities: Calaveras County (Live) > Calaveras briefing; Bring ThePillory to your county (waitlist, real counts)
  - Understand: The Constitution, How a bill becomes law, How to read a vote, How ThePillory works, Public finances by term > `/finances/`
- **Your briefing** (`/briefing/`), once your districts are known (the lookup opens it):
  - In Calaveras County: the Calaveras briefing (also `/calaveras/` for everyone): first-visit intro, County / State / Federal filter, This week (meetings and hearings) > Meeting / Calendar (`/meetings/`), Issues near you (empty state), Your reps' latest votes > All votes (`/votes/`)
  - Elsewhere: your reps, your reps' latest votes, Happening now; a note that state and local coverage comes as communities launch
- **Meeting** (`/meetings/<id>/`): status (Upcoming, Took place, Cancelled), body, date and time, place; a one-line summary (items on the agenda, how many agenda watch flagged); How to weigh in (before the meeting); Agenda watch; collapsed: Full agenda (by kind of item, topics, official documents) and After the meeting (minutes, video); Add to calendar

### Explore (from Home)
- **United States** (`/explore/`): map (live community / people waiting / federal data only), smaller-state buttons, state picker (`?st=`), Live communities, Most requested next (waitlist counts)
- **State** (`/states/<name>/`): the home page's template for that state (see the hub above). `/explore/<st>/` redirects to its "[State] map" section (`#map`).
- **County** (`/place/<st>/<county>/`): breadcrumb; contents bar; summary (its congressional and legislative districts, as chips); live: Live badge, Open briefing, Make this my place; others: Bring ThePillory here (waitlist); On the ballot (California: statewide, every overlapping district's contest with "covers part of this county", Board of Equalization, courts, and local contests and measures where live; Your ballot shown in browsers with saved districts); collapsed: who represents it (County / State / Federal, "covers part of this county"), live: upcoming meetings and issues, Topics (chips > the county's topic pages), recent votes, Funding, nearby counties; the Time Machine year bar (> `?year=`)
- **County in a past year** (`/place/<st>/<county>/?year=YYYY`, 1993 to last year): Viewing YEAR banner with Back to today, year bar, Federal (President, Vice President, senators, the House members for the districts that covered the county that year), the Cabinet (Senate confirmations through that year, from 2001), California (Governor, statewide officers and legislators from the Statement of Vote), final-passage votes that year, executive orders signed that year, FEC totals for the two-year period, Not available for YEAR
- **County topics** (`/place/<st>/<county>/topics/`, `…/topics/<topic>/`): summary with counts, then collapsed, side by side, as facts: bills with a final-passage vote and how the county's reps voted, county meeting items (live), executive actions, officials' own words, campaign money from industries tied to the topic; year bar; `?year=` shows the topic's bills voted on and executive orders signed that year, with what isn't available
- **District** (`/district/<type>/<st>-<id>/`, type `congressional`, `state-senate`, `assembly`, `state-house`, `house-of-delegates`, `general-assembly`, `legislature`): representative, On the ballot (California: this seat's contest, or that it isn't on the certified list), counties it covers (entirely or partly), recent votes, Funding

### Elections (from Home, county and district pages)
- **Elections** (`/elections/`): upcoming elections, Your ballot, How to vote (official links only), other states > USA.gov's state election offices
- **Election** (`/elections/<id>/`): statewide offices, propositions, contests by district (U.S. House, State Senate, Assembly, Board of Equalization), courts, local contests and measures (live counties), How to vote, sources
- **Contest** (`/elections/<id>/contest/<contest>/`): candidates in ballot order, the same card for each (ballot designation, party preference as listed, FEC filing for U.S. House, Holds office now > Platform / Votes / Funding, the candidate statement word for word); results after the polls close; sources. Court pages (`contest/supreme-court/`, `contest/court-of-appeal-<n>/`): each retention question as worded
- **Measure** (`/elections/<id>/measure/<measure>/`): official title and summary (or the ballot question, impartial analysis and tax rate statement for a local measure), what a yes and a no vote mean, arguments and rebuttals word for word with their signers, results after the polls close, official sources
- **Your ballot** (`/elections/<id>/ballot/`, private): from the districts cookie; without it, the address or ZIP lookup, which returns here
- **The Supreme Court** (`/bodies/us-supreme-court/`; from "The nation" on every state's page, Reps > Governing bodies, and Laws > This term at the Supreme Court): the justices by seniority > Justice; This term > `/court/term/`; latest decisions > Decision
- **Justice** (`/justices/<slug>/`): About (nominated by, confirmed by the Senate with the roll call, oath, the official biography word for word) · Record (each decision where the syllabus names them, their position and what they wrote, newest first, Load more > Decision) · Disclosures (each year's report, gifts and reimbursements, CourtListener) · More
- **This term** (`/court/term/`): cases to be decided (argument date, the question presented collapsed); decisions this term > Decision
- **Decision** (`/court/cases/<term>/<docket>/`): summary, Touches the Constitution chips, the opinion (PDF); Who wrote and who joined (> Justice); the question presented; the Constitution in the Court's words
- **Candidates** (`/races/2026/<st>/`: every race in the state > Race; `/races/2026/<st>/<race>/`: every candidate in the race, the same card each, in ballot order where the certified list gives it, otherwise alphabetical, then "Also filed with the FEC" and "No longer listed as active", and How candidates are included; `/candidates/<FEC id>/` and `/candidates/ca/<contest>/<name>/`: the official layout, labeled "Candidate · Not yet in office" (or "Ran for" / "Filed for"; see docs/candidates.md): About (the race, the election date, as filed, sources), Platform (not loaded yet; campaign website), Votes (any office held > rep page), Funding (FEC totals, organizations by name), More (candidate statement, how candidates are included)). Linked from the ballot preview, each state page's Elections ("Candidates in [State]") and search
- **Ballot preview** ("Preview [State]'s ballot"; "Your ballot preview" after an address) (`/ballot/`, any state; from 45 days before the state's next election through Election Day, a card just below the map on Home and each state page: one line with the date and countdown and a "Preview [State]'s ballot" button; otherwise a link in Home's "Your state" and Elections and on the state page; always on `/elections/`): `/ballot/` > the visitor's state, or a list of states (`?pick=1`). `/ballot/<st>/` (private): "[State]'s ballot", the address field and a "Preview [State]'s ballot" button, the confirm line, federal races from FEC filings (U.S. Senate when a seat is up; U.S. House once the district is saved; incumbents > Votes / Funding; each > FEC filing), On ThePillory (California: Your ballot, the whole ballot; Washington: each measure), official sources (the state's election office via USA.gov, Vote.gov, How to vote where loaded), a different state > `/ballot/?pick=1`. With an address (POST, never cached): every contest and measure in ballot order (officials > rep page; measures > Measure and the official text), where to vote, early voting, drop-off, the official links for the address; no data: said plainly, with the state's sample ballot lookup

### Tab 2: Reps (`/reps/`)
- Find your representatives (address or ZIP), your reps once known, Executive branch (the President, Vice President and Cabinet; California's statewide offices), governing bodies, members of Congress by state (`/reps/?state=CA`)
- Governing body (`/bodies/<slug>/`): members (Congress: yours, then by state; the executive branches, `us-executive` and `ca-executive`, in full, in order); the Board of Supervisors also lists its meetings
- Rep (`/reps/<slug>/`): the record in one line under the name (counts and the latest recorded vote, or orders and bills signed), then one row of five equal tabs for every official, About · Platform · Votes · Funding · More (old `#promises` links open Platform) (fits a 360px phone; a link to a section inside a tab, like `#disclosures`, opens that tab)
  - About: record at a glance; collapsed Office and Source; the year bar. More: each part collapsed. Platform: "In their own words" (a word-for-word excerpt from the official's listed Issues or Priorities page, refreshed monthly, and statements their office submitted, labeled "Submitted by the official"), then "Commitments tracked" (published promises: quote, date, source, "AI-identified, auto-checked" or "Reviewed by", status and its history, "Under review" when a reader flagged it, and "Something wrong?" posting to `/reps/<slug>/promises/<id>/flag`) once at least one is published; see docs/promises.md
  - Members of Congress, California legislators and county supervisors: Votes (final passage, or all), Funding (FEC for members of Congress; `?cycle=` for the earlier period), More (Committees for California legislators, from Open States; Issues, empty state)
  - The President: Votes is bills signed and vetoed (`?show=`); Funding (FEC and the inaugural committee); More holds Executive orders (Federal Register), Nominations (civilian, `?status=`), Disclosures (OGE) and Issues
  - The Governor: Votes is bills signed and vetoed (leginfo); Funding (Cal-Access); More holds Executive orders (gov.ca.gov), Disclosures (Form 700) and Issues
  - The Vice President and California's other statewide officers (elected): Votes says none are recorded for the office; Funding (the ticket's FEC money, or Cal-Access); More holds Disclosures and Issues
  - The Cabinet (appointed): Votes and Funding say they don't apply to appointed officials, linking to Disclosures under More (OGE reports and ethics agreements)
  - About: the Time Machine year bar. `/reps/<slug>/?year=YYYY`: the office held that year (or that they didn't hold it), votes that year (final passage or all), executive orders that year (Presidents), FEC totals for the period, every term on record, Not available for YEAR. Past officeholders (Presidents and Vice Presidents since 1993, California's members of Congress since 2001) have pages only with `?year=`; their bare address redirects to their last year in office
  - Vote > Bill (under Laws)

### Tab 3: Report (`/report/`, the round blue button)
- Reporting opens when accounts launch; links to what you can do now

### Summary first, depth on tap (every detail page)
- The top fits one phone screen: status, title, a two-sentence summary (and where it comes from), "Touches the Constitution" chips that open the clause on the Constitution page
- A small contents bar at the top of long pages jumps between sections; everything past the top is a collapsed section that opens on tap (a link to a section opens it)
- List pages: one compact line per item (type, title, status, the first clause a checked analysis maps), filter chips, "Load more"

### Tab 4: Laws (`/laws/`)
- The list: a Bills / Orders / Constitution switch (`?show=orders`, `?show=constitution`), filter chips (bills: Congress, California, Became law, Vetoed, Any recorded vote, `?filter=`; orders: President, Governor; Constitution: the clauses checked analyses map most, `?clause=<id>`), one compact line per item, "Load more" (`?offset=`); More in Laws: On the ballot, the Constitution, Laws by subject, Public finances by term
- Topics (`/topics/`, `/topics/<topic>/`): summary (the topic, and counts of each kind of record), then collapsed: bills in Congress and California, executive actions, officials' own words; links to a county's topic page
- On the ballot: the next election > Election (between the Constitution and the bills)
- Time Machine: Public finances by term > Federal finances (`/finances/`: debt-to-GDP chart with term lines, jump chips, one card per presidential term with debt, receipts, outlays, surplus or deficit, net interest, spending by category, Congress during the term, marked events, what isn't available) and California's budget (`/finances/california/`: one card per governor's term, General Fund revenues, spending and ending balance, the Legislature's seats)
- Topics in a past year (`/topics/<topic>/?year=YYYY`)
- Bill (`/laws/bills/<id>/`): status (final action or latest final-passage vote), title, two-sentence summary (a person's, else the official summary's "This bill …" sentences, else the checked analysis's, labeled), Constitution chips; Your reps (their final-passage votes and one vote bar; or Find your representatives); collapsed: All votes (a picker of every recorded vote, final passage by default (`?vote=`); totals with a breakdown by party and, for Congress, by state; every member's position, 20 at a time with Load more, a name search and Position / Party / State filters, each row linking to the member > the roll-call page `/laws/bills/<id>/rollcall/?vote=`), Constitution (each clause quoted, "Supporters argue" and "Critics argue", how it was checked, Read the full analysis > `/laws/bills/<id>/analysis/` with "Something wrong?" and "Request full analysis"), Money (Follow the money), History (recorded votes and the final action, with the recorded action and source), Full text (official text and summary)
- Executive order (`/laws/orders/<id>/`, `fr-<document number>` or `ca-gov-<post id>`; the same layout for every President and Governor): status (signed; revoked, per the Federal Register's notes), title, two-sentence summary (from the checked analysis, labeled), Constitution chips, who issued it; Authority it claims (word for word from the order's text); In the courts (CourtListener opinions and case filings that mention the order, as docketed); collapsed: Constitution (as for bills, full analysis > `/laws/orders/<id>/analysis/`), History, Full text
- Votes (`/votes/`, from Reps): one compact line per final-passage vote (your reps' positions once your districts are known), Congress / California chips, Load more
- The Constitution (`/laws/constitution/`): full text, one anchor per provision

### Tab 5: You (`/you/`)
- Elections: Your ballot, Elections
- Accounts aren't open yet
- About (`/about/`): How it works (`/about/how-it-works/`, with the site's one labeled example), Principles (`/about/principles/`), Methodology (`/about/methodology/`), How a bill becomes law (`/about/how-a-bill-becomes-law/`), How to read a vote (`/about/how-to-read-a-vote/`)

### Every page
- One header: ThePillory wordmark and search (`/search/`: reps, governing bodies, bills, meetings, the Constitution)
- One nav: Home, Reps, Report (round blue button), Laws, You, each with an icon (bottom on phones, top from 768px)
- Footer: About · How it works · Principles · Methodology

### Chips
- Topic chips on bill pages, each meeting agenda item (and "Topics on this agenda"), executive orders and Platform excerpts on officials' pages

### Private
- Review queue (`/admin/review/`) and county waitlist counts (`/admin/waitlist/`), behind Cloudflare Access

## Opens when accounts launch
- Join & verify (identity once, address > districts)
- Report flow: Details > Evidence > Perspective > Constitution > Review > Submitted
- Issue: evidence, constitutional baseline, responsible rep or body, agency response, record history, published record
- Rep: promises with sources
- You: following and notifications, my reports, civic jury, verification and districts, privacy dashboard
- Agency portal (private link): verify office > view issue > post response
