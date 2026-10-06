# ThePillory: read this first

## What it is

ThePillory is an **evidence-first civic accountability platform**:

- **Facts first, then dialogue.** ThePillory presents evidence without emotion or spin, so people with different views can work from the same truth. Every feature follows this: lead with the record and its source, keep wording plain and calm (no loaded adjectives, alarm or outrage framing), and keep opinion and discussion separate from the facts they respond to.
- **Verified residents, one voice each.** People verify once (identity plus address → districts). Everyone else sees only "Verified resident · [County]".
- **Protected identities.** Names, addresses and IDs are never shown to other users, and never to the officials or agencies in a report.
- **Evidence first.** Reports are facts plus evidence. A resident's perspective is kept in its own, clearly separate section.
- **Constitution as the baseline.** Issues and laws are mapped to the clauses they touch, with three panels: *Where it aligns*, *Where it may be in tension*, *Why this might still serve the public*. ThePillory maps the Constitution; it doesn't rule on it.
- **Nonpartisan.** No party labels anywhere, and nothing that suggests a political side.

The information architecture lives in **[docs/sitemap.md](docs/sitemap.md)**. Check it before adding or moving screens.

## How the site is built and deployed

- Plain static HTML, CSS and JS, plus a small amount of server code. No framework, and no npm in the site itself.
- Cloudflare Pages deploys the repo root as-is: merging to `main` updates the live site, and every PR gets a preview URL.
- Pages live in folders (`/reps/index.html`), so URLs are clean (`/reps/`).
- **Real officials and voting records** live in **Cloudflare D1** (database `pillory`, binding `DB`). See **[docs/data-sync.md](docs/data-sync.md)** for setup and operations.
  - `workers/sync/`: the sync Worker. A daily Cron Trigger plus a token-protected `/run` link pull from Congress.gov, senate.gov roll call XML, Open States, and `data/county-officials.json`. The schema is in `workers/sync/migrations/`. Every step logs to `sync_log`; errors are logged, never swallowed.
  - **Functions may import only pure modules from `workers/sync/src`** (no Anthropic SDK, no `.sql`): the Pages build doesn't install the Worker's npm packages, so an SDK import anywhere in the chain fails every deploy. Check with `mv workers/sync/node_modules /tmp/nm && npx wrangler pages functions build; mv /tmp/nm workers/sync/node_modules`.
  - **Coverage:** the President, Vice President and Cabinet; California's Governor and statewide officers; every current member of Congress and every California legislator, with every member's position on each recorded vote and the vote totals (`yea`, `nay`, `present`, `not_voting`). County coverage is Calaveras only; more counties open as communities launch.
  - `functions/`: Pages Functions that render the D1-backed pages: `/` (the hub; `/home/` redirects), `/briefing/` (the visitor's briefing), `/calaveras/` (the county briefing), `/reps/`, `/reps/<slug>/`, `/bodies/<slug>/`, the `/laws/` index, `/laws/bills/<id>/`, `/meetings/` and `/meetings/<id>/`, `/votes/`, `/explore/` and `/explore/<st>/` (maps), `/place/<st>/<county>/`, `/district/<type>/<st>-<id>/`, `/admin/review/`, `/admin/waitlist/`, `/api/search-officials`, `/api/districts` and `/api/waitlist`. They reuse the static page shell through `functions/_lib/generated.js`. If D1 isn't bound or is empty, they show a "Not loaded yet" state. **Never compute a page from the full `votes` or `vote_positions` tables on a visit** (millions of rows; that crashed the Laws page with error 1101): read what the sync precomputes (`bill_list`, `official_stats`, built by `workers/sync/src/summaries.js`), page long lists, load each section with `loadSection` so one failure shows a short note instead of failing the page, wrap every page handler in `guard`, and serve pages that are the same for everyone through `edgeCached` (5 minutes). See "How the pages stay fast" in [docs/data-sync.md](docs/data-sync.md).
- **Meetings:** the sync Worker reads Board of Supervisors and Planning Commission agendas from the county's Tyler Meeting Manager (JSON list plus the agenda PDF; paced and capped, and Board packets are linked, never downloaded; the former IQM2 portal reader is off by default) and state committee hearings from Open States. Comment instructions are copied verbatim from the agenda PDF. **Agenda watch** drafts per-item summaries and flags (AI, labeled "AI-drafted from the official agenda", `AGENDA_DAILY_LIMIT`); suggested issue links show only once approved.
- **The executive branch:** the President and Vice President (congress-legislators' `executive.json`), the Cabinet (as whitehouse.gov lists it), and California's Governor and statewide officers (entered by hand in `data/state-executive-officials.json`). The President's executive orders (Federal Register), bills signed and vetoed (Congress.gov actions) and civilian nominations (Congress.gov); the Governor's executive orders (gov.ca.gov) and bills signed and vetoed (leginfo bill history). Every bill page shows its **Final action**, recorded only from the action that states it; a law with no recorded signature says so rather than assuming one. See **[docs/executive.md](docs/executive.md)**.
- **Campaign funding and lobbying** (members of Congress and bills in Congress): FEC campaign finance and lda.gov lobbying reports, synced last in the daily run (`workers/sync/src/funding/`, paced). Shown on the rep **Funding** tab and the bill page's **Follow the money**. **The executive branch** (`executive-funding`): the President's FEC money, inaugural committee (Form 13; organizations by name, individuals only as totals) and OGE financial disclosures; the Vice President's ticket money and OGE disclosures; the Cabinet's OGE financial disclosure reports and ethics agreements (no campaign money); California's statewide officers' Cal-Access campaign totals (`data/ca-campaign.json`, built weekly in GitHub Actions) and FPPC Form 700s. Outside spending by groups that don't disclose their donors (FEC type I) is labeled "Donors not disclosed"; people spending their own money aren't named. The same rules for every official, whatever their party. Money and votes sit side by side as facts: never state or imply that money caused a vote ("bought", "paid for"), and give every number its context (what, period, source). Individual donors are never named, at any amount; no donor export. Industries are approximate (keyword rules). See **[docs/funding.md](docs/funding.md)**.
- **AI-drafted constitutional analysis** of bills runs in the same Worker after each sync (`workers/sync/src/analysis/`). See **[docs/analysis.md](docs/analysis.md)**. A cheap relevance check (claude-haiku-4-5) skips ceremonial and routine bills and ranks the rest by local relevance. Claude drafts a short card (or a full analysis when an issue links to the bill or someone asks), the checks fix or remove bad quotes and unverifiable cases, and an AI reviewer rates each problem major (factual error, unfair to one side, opinion stated as fact) or minor (completeness, phrasing, style). Problems get one automatic revision; a major problem left sends the draft to the review queue, while minor ones left are published as a small note under the analysis. A person works the queue at `/admin/review/` (behind Cloudflare Access; `functions/_lib/access.js` fails closed): AI flags (major only), reader flags, and 10% spot checks.

### Hand-written vs generated

**The site shows real data only.** No sample reps, bills, meetings, votes, issues or clause pages. Where there's no real data yet, a section shows a short, honest empty state (for reports and issues: "No reports yet. Reporting opens when accounts launch.", linking to How it works). The page-by-page audit is in **[docs/site-audit.md](docs/site-audit.md)**.

| Hand-written (edit directly) | Generated by `tools/build.py` (never edit by hand) |
|---|---|
| `assets/pillory.css`, `assets/app.js` | `about/` (About, How it works, Principles, Methodology, How a bill becomes law, How to read a vote), `issues/` (empty state), `report/`, `you/`, `search/`, `laws/constitution/`, `assets/search-index.js`, `_redirects`, `site.webmanifest` |
| `functions/**` (except `_lib/generated.js`), `workers/sync/**`, `data/county-officials.json`, `data/state-executive-officials.json` | `functions/_lib/generated.js` (page shell and shared snippets for the Functions) |
| `data/constitution.json` (National Archives text; check with `tools/check_constitution.py`), `tools/data.py` (the governing bodies, and the one example issue) | `data/zip/*.json`, `data/counties.json` (by `tools/build_zip_districts.py` from Census files, run in the "Refresh ZIP district data" GitHub workflow); `data/ca-campaign.json` (by `tools/build_ca_campaign.py` from the Cal-Access export, the weekly "Refresh California campaign data" workflow); `data/geo/` (map shapes, counties, district overlaps: `tools/build_geo.mjs`, run in the "Refresh map data" workflow) |

`tools/build.py` holds the page templates; `tools/data.py` holds only plain facts (the governing bodies) and the single example. After changing either one:

```sh
python3 tools/build.py   # standard library only; wipes and rewrites the generated folders
```

Commit the regenerated files with your change.

**Old URLs** (the former landing, How it works and Principles pages, and every removed sample page) redirect with 301s: `REDIRECTS` in `tools/build.py` writes `_redirects`, and the Laws and Meetings Functions redirect their own old paths. Add a redirect whenever a page moves.

Bump `ASSET_VERSION` in `tools/build.py` whenever `pillory.css` or `app.js` changes, so browsers don't serve a stale copy.

To test the sync and Functions locally with **fake** data: `workers/sync/test/run-local.sh` (needs Node and wrangler).

## App structure

- **One header and one nav on every page:** the wordmark and search at the top (`site_header()` in `tools/build.py`), and five tabs (`.tabbar`): Home, Reps, **+ Report** (center, navy pill), Laws, You. `/home/` and `/feed/` redirect to `/`.
- **Home (`/`, thepillory.co itself) is always the hub**: the headline, a U.S. map (tap a state for its `/explore/` page; no zooming or dragging, so scrolling always works; small-state buttons; live and waiting counts; "Explore the full map"), Find your representatives, Who represents you (the President, Vice President and Cabinet; California's Governor and statewide offices), a dismissible intro for first-time visitors (remembered in the browser), Happening now (Congress / California), Take part, Communities (Calaveras "Live", and the county waitlist), and Understand. Once a visitor's districts are known, the hub links to **their briefing at `/briefing/`**: the Calaveras County briefing (also at `/calaveras/`) in Calaveras, otherwise their reps, their reps' latest votes and Happening now. The old `/?hub=1` redirects to `/`. How it works and Principles live under About.
- **Districts stay in the visitor's browser.** The lookup (`/api/districts`) takes an address (U.S. Census Geocoder, 119th Congress districts) or a ZIP code (`data/zip/`), answers with district IDs only, and never stores or logs the address or ZIP. The browser keeps the IDs in the `pillory_districts` cookie (`functions/_lib/districts.js`); pages that read it are served `Cache-Control: private`. When the 120th Congress starts (January 2027), set `CENSUS_VINTAGE` and rerun the ZIP workflow with the new district files.
- **Explore by map** (`/explore/`, linked from the hub map as "Explore the full map"): a U.S. map (live community states navy, states with waitlist signups light navy), small-state buttons and a state picker; state maps with layer toggles (Counties, Congressional, and the state's legislative chambers); county pages (`/place/`: who represents it, every district that overlaps it with "covers part of this county", live communities' briefing and "Make this my place", otherwise the waitlist) and district pages (`/district/`). Shapes and overlaps come from Census Bureau files in `data/geo/` (built by `tools/build_geo.mjs`; one layer per file, loaded only when shown, cached a day via `_headers`), drawn by `assets/map.js`. **Every map has a list or search beside it**, so nothing on a map needs the map. Live communities are listed in `LIVE` (`functions/_lib/geo.js`).
- **Waitlist** ("Bring ThePillory to your county"): county and email in D1 (`waitlist`), Turnstile plus a per-visitor daily limit; the email is used only to announce that county's launch. The hub shows only the totals; `/admin/waitlist/` shows counts by county. About, How it works, Principles and Methodology live under About in the You tab and in the footer of every page. The bar is fixed to the bottom on phones and becomes a top nav at 768px and wider.
- **Global search** sits at the top of every page and searches reps, governing bodies, bills, meetings and every provision of the Constitution (`assets/search-index.js` plus `/api/search-officials` from D1). Enter opens `/search/?q=`.
- **Back labels:** every page below a tab root has `← <parent name>`, for example `← About`. Pass `back=(label, href)` to `render()`.
- **No dead ends.** Every link leads to real content or an honest empty state. Don't add buttons for features that don't exist yet (following, reporting, corroborating); say plainly that they open when accounts launch.
- **Links between records:** real officials link to bills through votes in D1. Once residents' issues exist, they link to bills only through `issue_bill_links` rows with `status = 'approved'`, and to agenda items only through approved `item_issue_links`.

## Real data rules (officials, bills, votes)

- **Every record has a source URL.** The D1 schema rejects rows without an http(s) `source_url`, and pages link to it.
- **Never invent or guess.** No names from memory, and no term dates or districts the source doesn't state; leave them blank. County supervisors and California's statewide officers are entered by hand in `data/county-officials.json` and `data/state-executive-officials.json` (see `data/README.md`).
- **Votes are facts.** Show the bill, the exact question, the position, the result, the date and the source. No grades, scores, or "voted against X" summaries. Final-passage votes show by default; procedural, amendment, committee and nomination votes sit behind a clearly labeled toggle. Positions use one neutral style whatever they are.
- **Party is plain text**, styled the same for every party. No red and blue.
- **No automatic issue-to-bill links.** Links start as `suggested` and appear only once `approved`, with `approved_by` recorded.
- **No sample content.** Nothing invented is shown as if it were real. The one example issue (How it works) is labeled "Example", says it's hypothetical, points only at a governing body, and nothing links to it.

## Constitutional analysis rules

- **ThePillory maps the Constitution; it doesn't rule on it.** No verdicts on constitutionality anywhere, from the AI or on the page. The three panels are *Where it aligns*, *Where it may be in tension*, *Why this might still serve the public*.
- **Quote the Constitution only from `data/constitution.json`**, word for word. Its IDs are stable: never renumber or reuse them.
- **AI drafts are public only once checked.** A draft the AI reviewer passes is labeled "AI-drafted, auto-checked", linked to the methodology. A flagged draft stays off public pages until a person decides. A person's approval shows "Reviewed by [name], [date]". Every version and edit is kept.
- **Reader flags** ("Something wrong?") need no account: Turnstile plus a per-visitor daily limit, and the visitor is a daily-rotating hash, never the address (`functions/_lib/turnstile.js`). A flagged analysis stays up, marked "Under review", until a person resolves it.
- **Only verified cases.** A case is shown only if CourtListener found it under the same name, linked to its opinion.
- Bump `PROMPT_VERSION` in `workers/sync/src/analysis/prompt.js` when the prompt or the JSON shape changes.

## Content rules

- Beyond the D1 data above and the Constitution, there is no backend, login or verification yet. Reports, issues, following and accounts open later; until then, say so plainly.
- **The one example issue** lives in `tools/data.py` (`EXAMPLE_ISSUE`) and appears only on How it works, labeled "Example".
- **No real names** in examples. Use role placeholders: `[Supervisor, District 1]`. Anything in `[brackets]` is a visible placeholder; keep it visible, and don't invent specifics.
- **No party labels** or anything that suggests a political side. Keep wording neutral: facts, sources, statuses.
- The live county is Calaveras County, California. Federal and California coverage is statewide and nationwide; other counties open as communities launch.
- Constitutional text must be quoted exactly.

## Design look

All styling is in **`assets/pillory.css`**, with tokens on `:root`. Reuse the classes there; don't add inline styles.

- **Fonts** (Google Fonts): Newsreader 600 for headings and titles; IBM Plex Sans 400/500/600 for everything else.
- **Colors:**
  - Page `#F5F2EA`; text `#1A1D21`; secondary text `#4A4F57`.
  - Cards `#FFFFFF` with a 1px `#DDD7CA` border and 12px radius.
  - Primary navy `#1E3A5F` (buttons, links, selected states); light navy `#E3EAF3`.
  - Parchment `#F3E8D3` with border `#D9C39B` and text `#6B4410`, for anything constitutional.
  - Tension red-brown `#8A3B12`.
- **Promise statuses:** Kept = navy, Broken = `#8A3B12`, In progress / No action = gray.
- **Card pattern** (`.card.issue-card`): small uppercase `LEVEL · CATEGORY` label, serif title, who's responsible, parchment constitutional chip, and a footer with status on the left and a second fact on the right.
- **Controls:** pill-shaped chips and toggles, and every tap target at least 44px tall. Section labels (`.label`) are small, uppercase, letter-spaced and secondary-colored.
- **Layout:** every screen is a centered app column, max 480px, with the tab bar and the footer.
- **Checks:** before shipping, look at phone (360–390px) and desktop (1280px) widths, with no horizontal scroll.

## Logo

The name is written **ThePillory**: one word, capital T and P, in every heading, title, meta tag, email and doc. The domain is written out in lowercase, `thepillory.co`, in the footer of every page (`FOOTER` in `tools/build.py`).

The logo is the **Seal P**: a serif "P" (Newsreader 600) inside a double ring, like an official stamp on a public record. It sits beside "ThePillory" in Newsreader 600. The "P" is stored as vector outlines, so the icons don't depend on the web font loading. Everything lives in `assets/logo/`:

- `mark.svg`: the seal on its own. CSS draws it before every `.wordmark` through `.wordmark::before` (a mask filled with navy), so the wordmark HTML stays plain text. Bump the `?v=` on the mask URL in `pillory.css` if the file changes.
- `icon.svg` and `favicon-32.png`: the browser-tab icon, a parchment seal on a rounded navy tile. The seal fills most of the tile so the P reads at 16px, and the parchment seal reads on light and dark tab bars alike. `favicon-32.png` and `/favicon.ico` (16, 32 and 48px, for browsers and tools that ask for it directly) are rendered from `icon.svg` unchanged: browsers pick different files for different tabs, so every file must look the same (no theme-only variants).
- `icon-square.svg`: the source for the home-screen icons (`apple-touch-icon.png` at 180px, `icon-192.png`, `icon-512.png`). It's a full-bleed square, because phones round the corners themselves, and the seal stays inside Android's safe zone, so the manifest lists the PNGs as maskable too.
- `og-image.png` (1200×630): the image shown when a link is shared.

The PNGs and `favicon.ico` were rendered from the SVGs in headless Chromium. If the SVGs change, re-render them to match and bump `ICON_VERSION` in `tools/build.py` (browsers keep icons far longer than other files). `site.webmanifest` is generated by `tools/build.py`. Every page's `<head>` carries the icon, manifest (`/site.webmanifest`) and Open Graph tags from one template, `head_tags()` in `tools/build.py`: static pages get it when they're built, and every Function (the hub, map, state, place and district pages included) gets it through `page()` in `functions/_lib/render.js`. Never write a `<head>` or send HTML any other way; `python3 tools/check_heads.py` (the "Page heads" workflow) fails if a page is missing the tags or a Function builds its own shell. Only navy and parchment are used for the logo; avoid red and blue together, which reads as partisan.
