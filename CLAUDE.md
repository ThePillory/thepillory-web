# The Pillory: read this first

## What it is

The Pillory is an **evidence-first civic accountability platform**:

- **Verified residents, one voice each.** People verify once (identity plus address → districts). Everyone else sees only "Verified resident · [County]".
- **Protected identities.** Names, addresses and IDs are never shown to other users, and never to the officials or agencies in a report.
- **Evidence first.** Reports are facts plus evidence. A resident's perspective is kept in its own, clearly separate section.
- **Constitution as the baseline.** Issues and laws are mapped to the clauses they touch, with three panels: *Where it aligns*, *Where it may be in tension*, *Why this might still serve the public*. The Pillory maps the Constitution; it doesn't rule on it.
- **Nonpartisan.** No party labels anywhere, and nothing that suggests a political side.

The information architecture lives in **[docs/sitemap.md](docs/sitemap.md)**. Check it before adding or moving screens.

## How the site is built and deployed

- Plain static HTML, CSS and JS. No framework and no npm.
- Cloudflare Pages deploys the repo root as-is: merging to `main` updates the live site, and every PR gets a preview URL.
- Pages live in folders (`/reps/index.html`), so URLs are clean (`/reps/`).

### Hand-written vs generated

| Hand-written (edit directly) | Generated (never edit by hand) |
|---|---|
| `index.html`, `how-it-works.html`, `principles.html`, `join/` | `feed/`, `issues/`, `meetings/`, `evidence/`, `reps/`, `bodies/`, `laws/`, `report/`, `you/`, `about/`, `agency/`, `record/`, `search/`, and the `constitution/` and `issue/` redirects |
| `assets/pillory.css`, `assets/app.js` | `assets/search-index.js` |

The app screens come from **`tools/data.py`** (all sample data) and **`tools/build.py`** (the page templates). After changing either one:

```sh
python3 tools/build.py   # standard library only; wipes and rewrites the generated folders
```

Commit the regenerated files with your change. The build fails loudly if data references a slug that doesn't exist.

One exception to "hand-written": the home page's sample issue cards sit between `<!-- build:home-issues … -->` markers in `index.html`, and the build refills them from `tools/data.py`. Edit the rest of `index.html` by hand, but not inside those markers.

Bump `ASSET_VERSION` in `tools/build.py` **and** the `?v=` on the hand-written pages' stylesheet link whenever `pillory.css` or `app.js` changes, so browsers don't serve a stale copy.

## App structure

- **Five tabs** (`.tabbar`): Feed, Reps, **+ Report** (center, navy pill), Laws, You. The bar is fixed to the bottom on phones and becomes a top nav at 768px and wider.
- **Global search** sits at the top of every app page and searches reps, bodies, laws, issues, constitutional sections and meetings (`assets/search-index.js`). Enter opens `/search/?q=`.
- **Back labels:** every page below a tab root has `← <parent name>`, for example `← [Supervisor, District 1]`. Pass `back=(label, href)` to `render()`.
- **Two-way links:** each connection is written once in `tools/data.py`, and `build.py` derives the reverse link (issue ↔ rep, law, clause, body, meeting, evidence, promise). Keep it that way. Don't hand-write one-way links.

## Sample data rules

- Everything is static sample data. There is no backend, login or verification yet.
- **No real names.** Use role placeholders: `[Supervisor, District 1]`, `[U.S. Representative, District]`.
- **No party labels** or anything that suggests a political side. Keep wording neutral: facts, sources, statuses.
- Anything in `[brackets]` is a visible placeholder. Keep it visible. Don't invent specifics.
- The sample place is Calaveras County, California.
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
- **Layout:** app screens are a centered column, max 480px. The public pages (Home, How it works, Principles) use a 680px reading column (`.site`).
- **Checks:** before shipping, look at phone (360–390px) and desktop (1280px) widths, with no horizontal scroll.

## Logo

The logo is the **Seal P**: a serif "P" (Newsreader 600) inside a double ring, like an official stamp on a public record. It sits beside "The Pillory" in Newsreader 600. The "P" is stored as vector outlines, so the icons don't depend on the web font loading. Everything lives in `assets/logo/`:

- `mark.svg`: the seal on its own. CSS draws it before every `.wordmark` through `.wordmark::before` (a mask filled with navy), so the wordmark HTML stays plain text. Bump the `?v=` on the mask URL in `pillory.css` if the file changes.
- `icon.svg` and `favicon-32.png`: the browser-tab icon, a parchment seal on a rounded navy tile.
- `icon-square.svg`: the source for the home-screen icons (`apple-touch-icon.png` at 180px, `icon-192.png`, `icon-512.png`). It's a full-bleed square, because phones round the corners themselves.
- `og-image.png` (1200×630): the image shown when a link is shared.

The PNGs were rendered from the SVGs in headless Chromium. If the SVGs change, re-render the PNGs to match. Every page's `<head>` carries the icon, manifest (`/site.webmanifest`) and Open Graph tags; generated pages get them from `head_tags()` in `tools/build.py`. Only navy and parchment are used for the logo; avoid red and blue together, which reads as partisan.
