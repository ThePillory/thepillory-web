# ThePillory: sitemap

What's live now, and what opens when accounts launch. Everything live shows
real data (from D1 or official sources) or an honest empty state. There are no
sample pages. See docs/site-audit.md for the page-by-page audit.

## Live now

### Tab 1: Home (`/`)
- **The hub**, at thepillory.co itself, for every visitor (the old `/?hub=1` redirects here):
  - First-visit intro (dismissible; How it works, Principles)
  - Your briefing link, once your districts are known > `/briefing/`
  - Headline and subtitle
  - Find your representatives: address or ZIP (`/api/districts`; nothing stored; district IDs kept in the browser)
  - Or explore the map > Explore
  - Happening now: Congress / California toggle (`?now=state`), latest final-passage votes with status, summary, constitutional chip, review label, totals, "See how your rep voted" > Bill
  - Take part: Calaveras comment deadlines > Meeting (#weigh-in); Contact your representatives > Reps. (Federal agency comment periods from Regulations.gov: to do)
  - Communities: Calaveras County (Live) > Calaveras briefing; Bring ThePillory to your county (waitlist, real counts)
  - Understand: The Constitution, How a bill becomes law, How to read a vote, How ThePillory works
- **Your briefing** (`/briefing/`), once your districts are known (the lookup opens it):
  - In Calaveras County: the Calaveras briefing (also `/calaveras/` for everyone): first-visit intro, County / State / Federal filter, This week (meetings and hearings) > Meeting / Calendar (`/meetings/`), Issues near you (empty state), Your reps' latest votes > All votes (`/votes/`)
  - Elsewhere: your reps, your reps' latest votes, Happening now; a note that state and local coverage comes as communities launch

### Explore (from Home)
- **United States** (`/explore/`): map (live community / people waiting / federal data only), smaller-state buttons, state picker (`?st=`), Live communities, Most requested next (waitlist counts)
- **State** (`/explore/<st>/`): map with layer toggles (`?layer=county|cd|sldu|sldl`; legislative layers only where the Census has them), Find a county (filter), every district as a list, Statewide (U.S. Senators, House members, state legislators where loaded, statewide offices: not loaded), the legislature (California: latest floor votes)
- **County** (`/place/<st>/<county>/`): breadcrumb; live: Live badge, Open briefing, Make this my place; others: Bring ThePillory here (waitlist); who represents it (County / State / Federal, "covers part of this county"); live: upcoming meetings, issues; recent votes; Funding; nearby counties
- **District** (`/district/<type>/<st>-<id>/`, type `congressional`, `state-senate`, `assembly`, `state-house`, `house-of-delegates`, `general-assembly`, `legislature`): representative, counties it covers (entirely or partly), recent votes, Funding

### Tab 2: Reps (`/reps/`)
- Find your representatives (address or ZIP), your reps once known, governing bodies, members of Congress by state (`/reps/?state=CA`)
- Governing body (`/bodies/<slug>/`): members (Congress: yours, then by state); the Board of Supervisors also lists its meetings
- Rep (`/reps/<slug>/`): Overview, Promises (not tracked yet), Votes, Funding (members of Congress: FEC; `?cycle=` for the earlier period), Issues (empty state)
  - Vote > Bill (under Laws)

### Tab 3: + Report (`/report/`)
- Reporting opens when accounts launch; links to what you can do now

### Tab 4: Laws (`/laws/`)
- Bill (`/laws/bills/<id>/`): summary, constitutional analysis (card or full), how your reps voted, Follow the money (lobbying reports; your reps' votes beside contributions from the industries that lobbied), "Something wrong?", "Request full analysis"
- The Constitution (`/laws/constitution/`): full text, one anchor per provision

### Tab 5: You (`/you/`)
- Accounts aren't open yet
- About (`/about/`): How it works (`/about/how-it-works/`, with the site's one labeled example), Principles (`/about/principles/`), Methodology (`/about/methodology/`), How a bill becomes law (`/about/how-a-bill-becomes-law/`), How to read a vote (`/about/how-to-read-a-vote/`)

### Every page
- One header: ThePillory wordmark and search (`/search/`: reps, governing bodies, bills, meetings, the Constitution)
- One nav: Home, Reps, + Report, Laws, You (bottom on phones, top from 768px)
- Footer: About · How it works · Principles · Methodology

### Private
- Review queue (`/admin/review/`) and county waitlist counts (`/admin/waitlist/`), behind Cloudflare Access

## Opens when accounts launch
- Join & verify (identity once, address > districts)
- + Report flow: Details > Evidence > Perspective > Constitution > Review > Submitted
- Issue: evidence, constitutional baseline, responsible rep or body, agency response, record history, published record
- Rep: promises with sources
- You: following and notifications, my reports, civic jury, verification and districts, privacy dashboard
- Agency portal (private link): verify office > view issue > post response
