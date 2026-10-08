# ThePillory: sitemap

What's live now, and what opens when accounts launch. Everything live shows
real data (from D1 or official sources) or an honest empty state. There are no
sample pages. See docs/site-audit.md for the page-by-page audit.

## Live now

### Tab 1: Home (`/`)
- **The hub**, at thepillory.co itself, for every visitor (the old `/?hub=1` redirects here):
  - Headline and subtitle
  - U.S. map (live community states navy, waitlist states light navy; taps only, no zooming or dragging): a state > `/explore/<st>/`; small-state buttons; "1 live community · [#] counties waiting" (real counts); Explore the full map > Explore
  - Find your representatives: address or ZIP (`/api/districts`; nothing stored; district IDs kept in the browser)
  - Your briefing link, once your districts are known > `/briefing/`
  - Elections (here, near the top, until Election Day; then after Who represents you): the next election > Election; Your ballot (once your districts are known: your district contests, courts, statewide offices and propositions, local count) > Your ballot; otherwise Find your ballot; How to vote > `/elections/#how-to-vote`
  - First-visit intro (dismissible; How it works, Principles)
  - Who represents you: the President, Vice President, the Cabinet > `/bodies/us-executive/`; California's Governor and statewide offices > `/bodies/ca-executive/` (other states: not covered yet); your members of Congress and state legislators > Your briefing
  - Happening now: Congress / California toggle (`?now=state`), latest final-passage votes with status, summary, constitutional chip, review label, totals, "See how your rep voted" > Bill
  - Topics: every topic as a chip > the topic's page for your county when known (`/place/<st>/<county>/topics/<topic>/`), otherwise `/topics/<topic>/`
  - Take part: Calaveras comment deadlines > Meeting (#weigh-in); Contact your representatives > Reps. (Federal agency comment periods from Regulations.gov: to do)
  - Communities: Calaveras County (Live) > Calaveras briefing; Bring ThePillory to your county (waitlist, real counts)
  - Understand: The Constitution, How a bill becomes law, How to read a vote, How ThePillory works
- **Your briefing** (`/briefing/`), once your districts are known (the lookup opens it):
  - In Calaveras County: the Calaveras briefing (also `/calaveras/` for everyone): first-visit intro, County / State / Federal filter, This week (meetings and hearings) > Meeting / Calendar (`/meetings/`), Issues near you (empty state), Your reps' latest votes > All votes (`/votes/`)
  - Elsewhere: your reps, your reps' latest votes, Happening now; a note that state and local coverage comes as communities launch

### Explore (from Home)
- **United States** (`/explore/`): map (live community / people waiting / federal data only), smaller-state buttons, state picker (`?st=`), Live communities, Most requested next (waitlist counts)
- **State** (`/explore/<st>/`): map with layer toggles (`?layer=county|cd|sldu|sldl`; legislative layers only where the Census has them), Find a county (filter), every district as a list, Statewide (U.S. Senators, House members, state legislators where loaded, statewide offices: not loaded), the legislature (California: latest floor votes)
- **County** (`/place/<st>/<county>/`): breadcrumb; live: Live badge, Open briefing, Make this my place; others: Bring ThePillory here (waitlist); On the ballot (California: statewide, every overlapping district's contest with "covers part of this county", Board of Equalization, courts, and local contests and measures where live; Your ballot shown in browsers with saved districts); who represents it (County / State / Federal, "covers part of this county"); live: upcoming meetings, issues; Topics (chips > the county's topic pages); recent votes; Funding; nearby counties
- **County topics** (`/place/<st>/<county>/topics/`, `…/topics/<topic>/`): side by side, as facts: bills with a final-passage vote and how the county's reps voted, county meeting items (live), executive actions, officials' own words, campaign money from industries tied to the topic
- **District** (`/district/<type>/<st>-<id>/`, type `congressional`, `state-senate`, `assembly`, `state-house`, `house-of-delegates`, `general-assembly`, `legislature`): representative, On the ballot (California: this seat's contest, or that it isn't on the certified list), counties it covers (entirely or partly), recent votes, Funding

### Elections (from Home, county and district pages)
- **Elections** (`/elections/`): upcoming elections, Your ballot, How to vote (official links only), other states > USA.gov's state election offices
- **Election** (`/elections/<id>/`): statewide offices, propositions, contests by district (U.S. House, State Senate, Assembly, Board of Equalization), courts, local contests and measures (live counties), How to vote, sources
- **Contest** (`/elections/<id>/contest/<contest>/`): candidates in ballot order, the same card for each (ballot designation, party preference as listed, FEC filing for U.S. House, Holds office now > Platform / Votes / Funding, the candidate statement word for word); results after the polls close; sources. Court pages (`contest/supreme-court/`, `contest/court-of-appeal-<n>/`): each retention question as worded
- **Measure** (`/elections/<id>/measure/<measure>/`): official title and summary (or the ballot question, impartial analysis and tax rate statement for a local measure), what a yes and a no vote mean, arguments and rebuttals word for word with their signers, results after the polls close, official sources
- **Your ballot** (`/elections/<id>/ballot/`, private): from the districts cookie; without it, the address or ZIP lookup, which returns here

### Tab 2: Reps (`/reps/`)
- Find your representatives (address or ZIP), your reps once known, Executive branch (the President, Vice President and Cabinet; California's statewide offices), governing bodies, members of Congress by state (`/reps/?state=CA`)
- Governing body (`/bodies/<slug>/`): members (Congress: yours, then by state; the executive branches, `us-executive` and `ca-executive`, in full, in order); the Board of Supervisors also lists its meetings
- Rep (`/reps/<slug>/`): one row of five equal tabs for every official, About · Platform · Votes · Funding · More (old `#promises` links open Platform) (fits a 360px phone; a link to a section inside a tab, like `#disclosures`, opens that tab)
  - About: office, source, record at a glance. Platform: "In their own words" (a word-for-word excerpt from the official's listed Issues or Priorities page, refreshed monthly, and statements their office submitted, labeled "Submitted by the official"), then "Commitments tracked" (approved promises: quote, date, source, status and its history) once at least one is approved; see docs/promises.md
  - Members of Congress, California legislators and county supervisors: Votes (final passage, or all), Funding (FEC for members of Congress; `?cycle=` for the earlier period), More (Committees for California legislators, from Open States; Issues, empty state)
  - The President: Votes is bills signed and vetoed (`?show=`); Funding (FEC and the inaugural committee); More holds Executive orders (Federal Register), Nominations (civilian, `?status=`), Disclosures (OGE) and Issues
  - The Governor: Votes is bills signed and vetoed (leginfo); Funding (Cal-Access); More holds Executive orders (gov.ca.gov), Disclosures (Form 700) and Issues
  - The Vice President and California's other statewide officers (elected): Votes says none are recorded for the office; Funding (the ticket's FEC money, or Cal-Access); More holds Disclosures and Issues
  - The Cabinet (appointed): Votes and Funding say they don't apply to appointed officials, linking to Disclosures under More (OGE reports and ethics agreements)
  - Vote > Bill (under Laws)

### Tab 3: + Report (`/report/`)
- Reporting opens when accounts launch; links to what you can do now

### Tab 4: Laws (`/laws/`)
- Topics (`/topics/`, `/topics/<topic>/`): every topic; one topic's bills in Congress and California, executive actions and officials' own words, with links to a county's topic page
- On the ballot: the next election > Election (between the Constitution and the bills)
- Bill (`/laws/bills/<id>/`): summary, Final action (signed, vetoed, law without a signature: date, law or chapter number, who acted, the recorded action, source), constitutional analysis (card or full), how your reps voted, Follow the money (lobbying reports; your reps' votes beside contributions from the industries that lobbied), "Something wrong?", "Request full analysis"
- The Constitution (`/laws/constitution/`): full text, one anchor per provision

### Tab 5: You (`/you/`)
- Elections: Your ballot, Elections
- Accounts aren't open yet
- About (`/about/`): How it works (`/about/how-it-works/`, with the site's one labeled example), Principles (`/about/principles/`), Methodology (`/about/methodology/`), How a bill becomes law (`/about/how-a-bill-becomes-law/`), How to read a vote (`/about/how-to-read-a-vote/`)

### Every page
- One header: ThePillory wordmark and search (`/search/`: reps, governing bodies, bills, meetings, the Constitution)
- One nav: Home, Reps, + Report, Laws, You (bottom on phones, top from 768px)
- Footer: About · How it works · Principles · Methodology

### Chips
- Topic chips on bill pages, each meeting agenda item (and "Topics on this agenda"), executive orders and Platform excerpts on officials' pages

### Private
- Review queue (`/admin/review/`) and county waitlist counts (`/admin/waitlist/`), behind Cloudflare Access

## Opens when accounts launch
- Join & verify (identity once, address > districts)
- + Report flow: Details > Evidence > Perspective > Constitution > Review > Submitted
- Issue: evidence, constitutional baseline, responsible rep or body, agency response, record history, published record
- Rep: promises with sources
- You: following and notifications, my reports, civic jury, verification and districts, privacy dashboard
- Agency portal (private link): verify office > view issue > post response
