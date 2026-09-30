# The Pillory: sitemap

What's live now, and what opens when accounts launch. Everything live shows
real data (from D1 or official sources) or an honest empty state. There are no
sample pages. See docs/site-audit.md for the page-by-page audit.

## Live now

### Tab 1: Home (`/`, the briefing)
- First-visit intro (dismissible) > How it works
- County / State / Federal filter (applies to every section)
- This week: upcoming meetings and hearings > Meeting; See all meetings > Calendar (`/meetings/`)
  - Meeting: details, add to calendar, how to weigh in, agenda watch, full agenda, after the meeting
- Issues near you: empty state until reporting opens (`/issues/`)
- Your reps' latest votes > All votes (`/votes/`)

### Tab 2: Reps (`/reps/`)
- Governing body (`/bodies/<slug>/`): members; the Board of Supervisors also lists its meetings
- Rep (`/reps/<slug>/`): Overview, Promises (not tracked yet), Votes, Issues (empty state)
  - Vote > Bill (under Laws)

### Tab 3: + Report (`/report/`)
- Reporting opens when accounts launch; links to what you can do now

### Tab 4: Laws (`/laws/`)
- Bill (`/laws/bills/<id>/`): summary, constitutional analysis (card or full), how your reps voted, "Something wrong?", "Request full analysis"
- The Constitution (`/laws/constitution/`): full text, one anchor per provision

### Tab 5: You (`/you/`)
- Accounts aren't open yet
- About (`/about/`): How it works (`/about/how-it-works/`, with the site's one labeled example), Principles (`/about/principles/`), Methodology (`/about/methodology/`)

### Every page
- Search (`/search/`): reps, governing bodies, bills, meetings, the Constitution
- Footer: About · How it works · Principles · Methodology

### Private
- Review queue (`/admin/review/`, behind Cloudflare Access)

## Opens when accounts launch
- Join & verify (identity once, address > districts)
- + Report flow: Details > Evidence > Perspective > Constitution > Review > Submitted
- Issue: evidence, constitutional baseline, responsible rep or body, agency response, record history, published record
- Rep: promises with sources
- You: following and notifications, my reports, civic jury, verification and districts, privacy dashboard
- Agency portal (private link): verify office > view issue > post response
