# Site audit: real data, sample data, or nothing (2026-09-30)

Before the cleanup, every page and section, what it showed, and what happens to it.

- **Real**: loaded from an official source (D1, the county portal, `data/constitution.json`) or plain facts about the site.
- **Sample**: invented content for layout (tools/data.py), including `[bracket]` placeholders.
- **Nothing**: a placeholder page or section with no content ("Content to come", "form to come").

## Tabs and pages rendered from the database (Pages Functions)

| Page | Section | Before | After |
|---|---|---|---|
| `/home/` Home briefing | Header, filter | Real | Real; now served at `/` |
| | This week (meetings, hearings) | Real (D1) | Real |
| | Issues near you | Sample (3 issue cards, "Example") | Empty state: "No reports yet. Reporting opens when accounts launch." |
| | Your reps' latest votes | Real (D1) | Real |
| `/meetings/` calendar | All | Real (D1) | Real |
| `/meetings/<id>/` real meeting | Details, how to weigh in, agenda watch, full agenda, after the meeting | Real (D1, AI summaries labeled) | Real. "Follow meeting", "I'm affected", "File a report" and "Corroborate" buttons removed (they led to sample or unbuilt pages) |
| | Related issue links | Real links to sample issues | Removed until real issues exist |
| `/votes/` | All | Real (D1) | Real |
| `/reps/` | Governing bodies | Real (institutions and plain descriptions) | Real |
| | Officials | Real (D1) | Real |
| `/reps/<slug>/` | Overview, votes | Real (D1) | Real |
| | Promises | Nothing (honest note) | Unchanged honest note |
| | Issues | Real links to sample issue cards | Empty state |
| `/bodies/<slug>/` | Members | Real (D1) | Real |
| | Meetings | Sample (3 sample meetings) | Real meetings from D1 (Board of Supervisors); honest note elsewhere |
| | Sample laws, Issues | Sample | Removed |
| `/laws/` | Bills with votes | Real (D1) | Real |
| | The Constitution link | Real | Real |
| | Sample laws | Sample (3) | Removed |
| `/laws/bills/<id>/` | Summary, analysis, votes | Real (D1; analysis labeled) | Real |
| | Related issues | Real links to sample issues | Removed until real issues exist |
| `/admin/review/` | All | Real (D1) | Real |
| | Suggested issue links | Real links to sample issues | Hidden while there are no real issues |
| `/api/search-officials` | Officials, bills | Real (D1) | Real, plus meetings |

## Static pages (tools/build.py)

| Page | Before | After |
|---|---|---|
| `/` landing (hand-written `index.html`) | Mixed: real description, sample issue cards, "private beta" and Join buttons | Replaced by the Home briefing, with a dismissible first-visit intro linking How it works |
| `/how-it-works.html` | Real (describes the planned process) | Moved to `/about/how-it-works/`, with one clearly labeled example issue |
| `/principles.html` | Real, one `[text to come]` placeholder | Moved to `/about/principles/`; the placeholder principle removed |
| `/join/` sign-up flow | Sample (a mock verification flow with `[Verification partner]`, `[District]`) | Removed; redirects to How it works |
| `/issues/` and 4 issue pages | Sample | `/issues/` is the empty state; issue pages redirect to it |
| `/record/<slug>/` (4) | Nothing (placeholders) | Removed; redirect to `/issues/` |
| `/evidence/<slug>/` (8) | Sample | Removed; redirect to `/issues/` |
| `/meetings/<sample>/` (3) | Sample | Removed; redirect to `/meetings/` |
| `/laws/<sample law>/` (3) | Sample | Removed; redirect to `/laws/` |
| `/laws/constitution/` | Real full text; sample "browse" list of 5 clause pages; "How the baseline works" | Real full text with a table of contents; the explainer kept |
| `/laws/constitution/<clause>/` (5) | Sample (issue and law links) around real text | Removed; redirect to the same provision in the full text |
| `/report/` + 5 step pages | Nothing (placeholders) | One honest page: reporting opens when accounts launch; steps redirect to it |
| `/you/` | Sample (following, notifications, "my reports") | About links and an honest note that accounts aren't open |
| `/you/jury/`, `/you/privacy/` | Nothing | Removed; redirect to `/you/` |
| `/about/` | Nothing | A real About page: what The Pillory is, with How it works, Principles, Methodology |
| `/about/methodology/` | Real; "Reports and issues: Content to come" | Real; the reports section says reporting isn't open yet |
| `/about/funding/`, `/about/advisory-group/` | Nothing | Removed; redirect to `/about/` |
| `/agency/` | Nothing | Removed; redirects to `/about/` |
| `/search/` | Real search box; sample issues, laws, meetings and clauses in the index | Index: governing bodies and every provision of the Constitution (static), plus officials, bills and meetings from D1 |
| `/feed/`, `/issue/`, `/constitution/` | Redirects | Redirects (to `/`, `/issues/`, `/laws/constitution/`) |

## Navigation

| Element | Before | After |
|---|---|---|
| Tab bar: Home | `/home/` | `/` |
| Tab bar: + Report | Placeholder form | Honest page |
| Wordmark | `/` (the landing page) | `/` (the briefing) |
| Public site nav (Home, How it works, Principles, App, Join) | On the 3 public pages | Removed with those pages |
| Footer | None on app pages | About · How it works · Principles · Methodology on every page |
