#!/usr/bin/env python3
"""Build ThePillory's static pages.

    python3 tools/build.py

Writes static HTML into the folders listed in GENERATED_DIRS (each page is
<folder>/index.html), assets/search-index.js, the _redirects file for old URLs,
and functions/_lib/generated.js (the page shell the Pages Functions share).
Those are wiped and rewritten on every run, so never hand-edit them: change
this file or tools/data.py, rebuild, and commit the output.

Everything shown is real: the Constitution (data/constitution.json), plain
facts about the site and the governing bodies (tools/data.py), and honest
empty states. Officials, bills, votes and meetings come from D1, rendered by
the Pages Functions. The only example content is one labeled example issue
on /about/how-it-works/.

Standard library only; no install step.
"""

import html
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# The full Constitution (National Archives transcription), shared with the sync
# Worker and the analysis pipeline. See tools/check_constitution.py.
CONSTITUTION = json.loads((ROOT / "data" / "constitution.json").read_text(encoding="utf-8"))["provisions"]
PROVISION = {p["id"]: p for p in CONSTITUTION}
ASSET_VERSION = "45"  # bump when assets/pillory.css or assets/app.js change

# Folders this script owns. Everything else (/, /reps/, /bodies/, /laws/ and
# /laws/bills/, /meetings/, /votes/, /admin/) is rendered from D1 by Pages Functions.
GENERATED_DIRS = ["about", "issues", "laws", "report", "search", "you"]

# Old URLs (sample pages, the old landing and public pages) and where they go
# now. Written to /_redirects as 301s. Old URLs under /laws/ and /meetings/
# are redirected by their Pages Functions instead (functions/laws, functions/meetings).
REDIRECTS = [
    ("/index.html", "/"),
    ("/home", "/"),
    ("/feed", "/"),
    ("/feed/", "/"),
    ("/how-it-works.html", "/about/how-it-works/"),
    ("/how-it-works", "/about/how-it-works/"),
    ("/principles.html", "/about/principles/"),
    ("/principles", "/about/principles/"),
    ("/join", "/about/how-it-works/"),
    ("/join/", "/about/how-it-works/"),
    ("/issue", "/issues/"),
    ("/issue/", "/issues/"),
    ("/issues/public-comment-limit/", "/issues/"),
    ("/issues/road-repaving/", "/issues/"),
    ("/issues/broadband-scoring/", "/issues/"),
    ("/issues/town-halls/", "/issues/"),
    ("/record/*", "/issues/"),
    ("/evidence/*", "/issues/"),
    ("/report/evidence/", "/report/"),
    ("/report/perspective/", "/report/"),
    ("/report/constitution/", "/report/"),
    ("/report/review/", "/report/"),
    ("/report/submitted/", "/report/"),
    ("/you/jury/", "/you/"),
    ("/you/privacy/", "/you/#privacy"),
    ("/about/funding/", "/about/"),
    ("/about/advisory-group/", "/about/"),
    ("/agency", "/about/"),
    ("/agency/*", "/about/"),
    ("/constitution", "/laws/constitution/"),
    ("/constitution/", "/laws/constitution/"),
]

e = html.escape


def _read_topics():
    """The topic list, and the industry-to-topic table, from the one copy in
    workers/sync/src/topics/list.js (the pages and the sync use it too)."""
    import re
    src = (ROOT / "workers" / "sync" / "src" / "topics" / "list.js").read_text(encoding="utf-8")
    topics = [{"slug": m.group(1), "name": m.group(2)} for m in re.finditer(r'\{ slug: "([a-z-]+)", name: "([^"]+)"', src)]
    table = re.search(r"INDUSTRY_TOPICS = \{(.*?)\n\};", src, re.S).group(1)
    mapping = {m.group(1): re.findall(r'"([a-z-]+)"', m.group(2)) for m in re.finditer(r"^\s*(\w+): \[([^\]]*)\]", table, re.M)}
    ind = (ROOT / "workers" / "sync" / "src" / "funding" / "industry.js").read_text(encoding="utf-8")
    names = dict(re.findall(r'^\s*(\w+): "([^"]+)",$', re.search(r"INDUSTRIES = \{(.*?)\n\};", ind, re.S).group(1), re.M))
    assert 15 <= len(topics) <= 20 and mapping and all(k in names for k in mapping), "topics/list.js or industry.js changed shape"
    return topics, mapping, names


TOPIC_LIST, INDUSTRY_TOPIC_MAP, INDUSTRY_NAMES = _read_topics()


def _read_icons():
    """Line icons, from the one copy in functions/_lib/icons.js."""
    import re
    src = (ROOT / "functions" / "_lib" / "icons.js").read_text(encoding="utf-8")
    paths = {m.group(1): m.group(2) for m in re.finditer(r'^\s*"?([a-z-]+)"?: \'(.*)\',$', src, re.M)}
    assert {"home", "reps", "laws", "you", "plus", "search"} <= set(paths), "functions/_lib/icons.js changed shape"
    return paths


ICON_PATHS = _read_icons()


def icon(name):
    return ('<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{ICON_PATHS[name]}</svg>')
TOPIC_NAME = {t["slug"]: t["name"] for t in TOPIC_LIST}
LEVEL_NAME = {"county": "County", "state": "State", "federal": "Federal"}

# The empty state for reports and issues, everywhere they would appear.
EMPTY_REPORTS = (
    '<section class="card empty-state stack-sm">'
    '<p>No reports yet. Reporting opens when accounts launch.</p>'
    '<a class="inline-link" href="/about/how-it-works/">How it works</a>'
    "</section>"
)

FOOTER = """<footer class="app-footer" aria-label="About ThePillory">
  <a href="/about/">About</a>
  <a href="/about/how-it-works/">How it works</a>
  <a href="/about/principles/">Principles</a>
  <a href="/about/methodology/">Methodology</a>
  <a href="/elections/">Elections</a>
  <a href="/topics/">Topics</a>
  <p class="app-footer-domain">thepillory.co</p>
</footer>"""


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

def provision_short(pid):
    return PROVISION[pid]["label"].replace(", Section ", ", Sec. ")


def clause_chip(ref, link=False):
    pid, aspect = ref
    text = f"{provision_short(pid)} · {aspect}"
    if link:
        return f'<a class="chip chip--parch" href="/laws/constitution/#{pid}">{e(text)}</a>'
    return f'<span class="chip chip--parch">{e(text)}</span>'


def card(href, label, title, who, chips, foot_left="", foot_right="", level=None, h="h3", example=False):
    lvl = f' data-level="{level}"' if level else ""
    top = (f'<div class="card-top"><p class="label">{e(label)}</p><span class="example-tag">Example</span></div>' if example
           else f'<p class="label">{e(label)}</p>')
    foot = f'<div class="issue-foot"><span>{foot_left}</span><span>{foot_right}</span></div>' if (foot_left or foot_right) else ""
    tag, attrs = ("a", f' class="card issue-card" href="{href}"') if href else ("div", ' class="card issue-card"')
    return f"""
<{tag}{attrs}{lvl}>
  {top}
  <{h}>{e(title)}</{h}>
  <p class="secondary small">{e(who)}</p>
  <div class="chips">{chips}</div>
  {foot}
</{tag}>"""


def body_card(b, h="h3"):
    return card(f"/bodies/{b['slug']}/", f"{LEVEL_NAME[b['level']]} · Governing body", b["name"], b["about"],
                clause_chip(b["clause"]), level=b["level"], h=h)


def link_row(href, title, meta="", right=""):
    meta_html = f'<div class="list-meta">{e(meta)}</div>' if meta else ""
    return f"""
<a class="list-row link-row" href="{href}">
  <div><div class="list-title">{e(title)}</div>{meta_html}</div>
  <span class="row-end">{right}<span class="chev" aria-hidden="true">›</span></span>
</a>"""


def section(label, inner, cls="card stack"):
    return f"""
<section class="{cls}">
  <h2 class="label">{e(label)}</h2>
  {inner}
</section>"""


# ---------------------------------------------------------------------------
# Page shell
# ---------------------------------------------------------------------------

TABS = [
    ("home", "Home", "/"),
    ("reps", "Reps", "/reps/"),
    ("report", "Report", "/report/"),
    ("laws", "Laws", "/laws/"),
    ("you", "You", "/you/"),
]

WORDMARK = 'The<span class="wordmark-accent">Pillory</span>'

SEARCH = """
<form class="search" action="/search/" role="search" autocomplete="off">
  <label class="visually-hidden" for="q">Search reps, governing bodies, bills, meetings, and the Constitution</label>
  <input class="input search-input" id="q" name="q" type="search"
    placeholder="Search reps, bills, meetings, the Constitution" aria-controls="search-results" aria-expanded="false" />
  <div class="search-results" id="search-results" hidden></div>
</form>"""

# One header on every page: the wordmark (home) and search. On tablets and
# computers the wordmark moves into the top navigation bar.
def site_header():
    return f"""<header class="site-header">
  <div class="site-header-row">
    <a class="wordmark" href="/" aria-label="ThePillory, home">{WORDMARK}</a>
    <button class="search-toggle" type="button" aria-controls="q" aria-expanded="false" aria-label="Search">{icon("search")}</button>
  </div>
  {SEARCH.strip()}
</header>"""


PAGES = {}


def tabbar(current, is_root):
    links = []
    for key, label, href in TABS:
        cls = "tab tab--report" if key == "report" else "tab"
        attr = ""
        if key == current:
            cls += " is-current"
            attr = ' aria-current="page"' if is_root else ' aria-current="true"'
        glyph = f'<span class="tab-icon--report">{icon("plus")}</span>' if key == "report" else icon(key)
        links.append(f'<a class="{cls}" href="{href}"{attr}>{glyph}<span>{e(label)}</span></a>')
    return f"""
<nav class="tabbar" aria-label="Main">
  <div class="tabbar-row">
    <a class="wordmark tabbar-brand" href="/" aria-label="ThePillory, home">{WORDMARK}</a>
    <div class="tabbar-inner">
      {"".join(links)}
    </div>
  </div>
</nav>"""


SITE_DESCRIPTION = "Evidence-first civic accountability. Verified residents, protected identities, nonpartisan."
SITE_URL = "https://thepillory.co"
# Bump when anything in assets/logo/ or site.webmanifest changes: browsers keep
# favicons and home-screen icons far longer than other files.
ICON_VERSION = 3


def head_tags(title):
    """Icons, manifest, and link-share (Open Graph) tags for every page."""
    return f"""    <meta name="description" content="{SITE_DESCRIPTION}" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="/assets/logo/icon.svg?v={ICON_VERSION}" type="image/svg+xml" />
    <link rel="icon" href="/assets/logo/favicon-32.png?v={ICON_VERSION}" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/assets/logo/apple-touch-icon.png?v={ICON_VERSION}" sizes="180x180" />
    <link rel="manifest" href="/site.webmanifest?v={ICON_VERSION}" />
    <meta property="og:site_name" content="ThePillory" />
    <meta property="og:title" content="{e(title)}" />
    <meta property="og:description" content="{SITE_DESCRIPTION}" />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="{SITE_URL}/assets/logo/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="ThePillory: a serif P in a seal beside the wordmark, with the line Evidence-first civic accountability" />
    <meta name="twitter:card" content="summary_large_image" />
"""


def shell(title, main, *, nav="", back_html="", after="", title_is_html=False):
    """The full HTML document around a page's main content.

    Shared by the static pages (render) and, through functions/_lib/generated.js,
    by the Pages Functions that render D1-backed pages, so both stay identical.
    """
    t = title if title_is_html else e(title)
    body_cls = ["has-tabbar"]
    if after:
        body_cls.append("has-action-bar")
    header = site_header()
    scripts = (f'<script src="/assets/search-index.js?v={ASSET_VERSION}"></script>\n'
               '    <script src="/api/search-officials"></script>\n'
               f'    <script src="/assets/app.js?v={ASSET_VERSION}"></script>')
    head = head_tags(f"{t} – ThePillory") if title_is_html else head_tags(f"{title} – ThePillory")
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{t} – ThePillory</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/assets/pillory.css?v={ASSET_VERSION}" />
    <script>document.documentElement.classList.add("js")</script>
{head}  </head>

  <body class="{' '.join(body_cls)}">
    <main class="app">
{header}
{back_html}
{main}
{FOOTER}
    </main>
{after}{nav}
    {scripts}
  </body>
</html>
"""


def render(path, title, main, *, tab=None, root=False, back=None, after=""):
    """Write <path>/index.html.

    tab:  which bottom tab this page belongs to ("home", "reps", ...).
    root: True for the tab's own landing page.
    back: (label, href) for the back link on deeper pages.
    """
    back_html = f'<a class="back-link" href="{back[1]}">← {e(back[0])}</a>' if back else ""
    doc = shell(title, main, nav=tabbar(tab, root), back_html=back_html, after=after)
    marker = "    <main class=\"app\">"
    PAGES[path] = doc.replace(marker, "    <!-- Generated by tools/build.py. Edit it and rebuild; "
                                      "don't edit this file by hand. -->\n" + marker, 1)


def full_constitution():
    """Every article and amendment, with an anchor for each provision ID."""
    kids = {}
    for p in CONSTITUTION:
        kids.setdefault(p["parent"], []).append(p)

    def body(p, depth):
        if p["leaf"]:
            label = "" if depth == 0 else f'<p class="label">{e(p["label"].split(", ", 1)[-1])}</p>'
            return f'<div class="provision" id="{p["id"]}">{label}<p class="constitution-text">{e(p["text"])}</p></div>'
        inner = "".join(body(k, depth + 1) for k in kids.get(p["id"], []))
        if depth == 0:
            return inner
        return f'<div class="provision-group" id="{p["id"]}"><h4 class="label">{e(p["label"].split(", ", 1)[-1])}</h4>{inner}</div>'

    tops = [p for p in CONSTITUTION if p["parent"] is None and p["id"] != "preamble"]
    blocks = "".join(
        f'<section class="parchment stack-sm" id="{p["id"]}" aria-labelledby="h-{p["id"]}">'
        f'<h3 id="h-{p["id"]}">{e(p["label"])}</h3>{body(p, 0)}</section>'
        for p in tops
    )
    return f"""<section class="stack" id="full-text">
  <div class="stack-sm">
    <h2 class="label">Full text</h2>
    <p class="small secondary">As transcribed by the <a href="https://www.archives.gov/founding-docs/constitution">National Archives</a>, with its original spelling. Every quote on ThePillory comes from this text.</p>
  </div>
  {blocks}
</section>"""


def build_methodology():
    topic_names = "; ".join(t["name"] for t in TOPIC_LIST)
    industry_map = "; ".join(f"{INDUSTRY_NAMES[k]} → {', '.join(TOPIC_NAME[t] for t in ts)}" for k, ts in INDUSTRY_TOPIC_MAP.items())
    main = """
<header class="page-head">
  <h1>Methodology</h1>
  <p class="subtitle">How ThePillory maps laws and issues to the Constitution, and how reports are reviewed.</p>
</header>

<section class="card stack" id="analysis">
  <h2>Constitutional analysis of bills and executive orders</h2>
  <p>ThePillory maps the Constitution; it doesn't rule on it. For bills our officials have voted on, and for executive orders of the President and the Governor, an AI tool writes an analysis showing which parts of the Constitution a bill touches. Automatic checks and a second AI tool check every analysis, and a person reviews any that are flagged, plus a random share of the rest. Nothing here is a verdict on whether a bill is constitutional, and nothing here is legal advice.</p>
  <ol class="numbered">
    <li>
      <span class="step-num" aria-hidden="true">1</span>
      <div class="stack-sm">
        <h3>Which bills get analyzed</h3>
        <p class="small secondary">Bills with a final-passage vote in Congress or the California Legislature, and any bill an issue on this site links to. (Once residents can follow bills, followed bills will count too.) First, a quick AI check (Claude Haiku) reads each bill's title and sets aside ceremonial and routine measures, such as commemorations, awareness days, post office and building namings, and honorary resolutions. Each one set aside is logged with the reason, the bill page says why, and a person can reverse it. The same check rates how much each bill bears on this county (California, rural counties, federal lands, water, wildfire, roads and similar), so the daily limit goes to what matters most here. It judges by subject only, never by party or sponsor.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">2</span>
      <div class="stack-sm">
        <h3>Two levels: a short card, or a full analysis</h3>
        <p class="small secondary">Most bills get a <strong>short card</strong>: a two to three sentence summary, the one to three most relevant provisions of the Constitution with one sentence each, and one sentence each for where the bill aligns, where it may be in tension, and why a departure might still serve the public. A <strong>full analysis</strong> covers every provision the bill touches, contested readings and what the analysis can't tell you. It's written when an issue on this site links to the bill, or when a resident asks for one with "Request full analysis" on the bill page. Both start from the bill's own words: the latest text on Congress.gov or the California Legislature's site, or the official summary, labeled "limited", when the text isn't available. For a short card of a very long bill, the AI tool reads the official summary, the bill's list of sections and its opening pages rather than every page, and the card is labeled "limited" with exactly what it was based on; a full analysis reads the whole bill.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">3</span>
      <div class="stack-sm">
        <h3>An AI tool writes it, and automatic checks correct it</h3>
        <p class="small secondary">Claude, an AI model made by Anthropic, writes the card or analysis from the bill text and the full text of the Constitution. Its instructions: no verdicts on constitutionality, no party labels or partisan language, the strongest version of each view, and "uncertain" rather than a guess. Each card or analysis also has one line beginning "Supporters argue that" and one beginning "Critics argue that": the strongest argument each side makes, attributed to that side rather than to ThePillory, of similar length, naming no person, party or group. Then every passage quoted from the Constitution is compared with the National Archives text and replaced with the exact words if it doesn't match, and every court case is looked up in CourtListener, a free public database of court opinions. Cases that can't be found under the same name are removed, with every sentence that relies on them. Each change is logged.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">4</span>
      <div class="stack-sm">
        <h3>A second AI tool reviews it</h3>
        <p class="small secondary">A separate Claude call reads the analysis against the bill text and answers five questions. Is the summary accurate and complete for what the bill does? Is any side's argument noticeably weaker or less charitable than the other's? Is opinion stated as fact, or is there loaded or partisan language? Are the chosen provisions relevant, with nothing obviously missing? Does anything claim more certainty than the sources support? Each problem it finds is rated <strong>major</strong> (a factual error, unfair treatment of one side, or opinion stated as fact, including any verdict on constitutionality) or <strong>minor</strong> (completeness, phrasing or style, including panels of uneven length that each state their view fairly). When any problem is found, the first AI tool gets one chance to fix what the reviewer named; the revision goes through the same automatic checks and is reviewed again. With no major problem, the analysis is published, labeled <strong>"AI-drafted, auto-checked"</strong>; any minor notes left are shown in a small note with it. With a major problem, it stays off the public page and goes to a person with the reviewer's reasons and both versions.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">5</span>
      <div class="stack-sm">
        <h3>Readers can flag problems</h3>
        <p class="small secondary">Every published analysis has "Something wrong?". Choose a reason (inaccurate, unfair to one side, missing perspective, or other) and add a note if you like. No account is needed. Any report sends the analysis to a person; until they resolve it, it stays up, marked <strong>"Under review"</strong>. To keep the forms free of spam, they use Cloudflare Turnstile and a daily limit per visitor. We don't store your address, only a one-way code that changes every day.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">6</span>
      <div class="stack-sm">
        <h3>People check the system, too</h3>
        <p class="small secondary"><strong>Executive orders</strong> go through every step above the same way, from the order's own text (the Federal Register's, or the Governor's signed order), with the same instructions in the order's words and the same layout for every President and Governor; there's no relevance check, since every order is substantive. A random 10% of the analyses the AI reviewer passes also go to a person as spot checks. The review page keeps a running count of how often the person agrees with the AI reviewer, so we can see whether it can be trusted. A person can edit any part, approve, reject, or ask for a new draft. Analyses a person approves show "Reviewed by" with their name and the date. Earlier versions and every edit are kept.</p>
      </div>
    </li>
  </ol>
</section>

<section class="card stack" id="agenda-watch">
  <h2>Meetings and agenda watch</h2>
  <p>Meeting times, places, agendas, staff reports, minutes and video links come from Calaveras County's official meeting portal, for the Board of Supervisors and the Planning Commission. State committee hearings come from Open States and show when one of Calaveras County's two state legislators sits on the committee.</p>
  <ul class="plain-list small">
    <li><strong>How to weigh in:</strong> the comment instructions and deadline are copied word for word from the official agenda. When a short deadline is shown (for example "Written comments by Mon, Oct 12, 4:00 pm"), it is worked out only from the agenda's own plain wording, such as "no later than 4:00 pm on the day before the meeting".</li>
    <li><strong>Agenda watch:</strong> an AI tool (Claude, made by Anthropic) writes two or three neutral sentences about each item, from the official agenda only, rates each item's public impact by its subject and scale, and flags at most five items per agenda, the ones with the most impact, under budget, land use, fees and taxes, public safety, or public access and meetings. Consent-calendar items, which are routine by design, are flagged only when they adopt a budget, a tax or fee, an ordinance or an emergency. Every other item is in the full agenda with its summary. These summaries are labeled "AI-drafted from the official agenda" and link to the source. A sentence that states a number, amount or date the agenda item doesn't contain is removed automatically. People review the summaries.</li>
    <li><strong>Links to issues:</strong> the AI tool may suggest that an agenda item relates to an issue. A suggestion is shown only after a person approves it.</li>
    <li><strong>Votes:</strong> how each supervisor voted will be added from the published minutes.</li>
  </ul>
</section>

<section class="card stack" id="states">
  <h2>Every state</h2>
  <p>Congress and California are covered in full. For every other state, the District of Columbia and Puerto Rico, the records come in two parts.</p>
  <ul class="plain-list small">
    <li><strong>Who holds each office:</strong> each state's current legislators, with their districts, and its governor and the statewide officers Open States lists, from Open States' public data on its people, refreshed weekly. Some states have statewide offices Open States doesn't list yet; those aren't shown.</li>
    <li><strong>Your state legislators:</strong> matched by district name between the Census Bureau's district maps and Open States. A few seats can't be matched to one mapped district (New Hampshire's floterial seats, at-large seats, and Maine's two tribal representatives); they're on the state's page.</li>
    <li><strong>Bills and votes:</strong> loaded state by state from Open States' public session files, the states visitors look up most first, then kept current daily. Each vote shows the exact motion, the result, the totals as recorded and each current member's position, and links to the official record. Until a state is loaded, its pages say its bills and votes are coming soon.</li>
    <li><strong>What's counted to decide the order:</strong> how many times someone looked up their representatives in each state, counted per state and day. No address, ZIP code or visitor is kept, only the count. Sign-ups for the county waitlist count too.</li>
    <li><strong>Money:</strong> campaign finance for state officials covers California only for now; other states' pages say so.</li>
  </ul>
</section>

<section class="card stack" id="executive">
  <h2>The executive branch</h2>
  <p>The President, the Vice President and the Cabinet, and California's Governor and the other offices California elects statewide. Each record says where it comes from and links to it.</p>
  <ul class="plain-list small">
    <li><strong>Who holds each office:</strong> the President and Vice President, with their terms, from the congress-legislators project's public executive data; the Cabinet exactly as whitehouse.gov lists it, checked daily; California's statewide officers entered by hand from each office's official website, with the date they were checked.</li>
    <li><strong>Executive orders:</strong> the President's from the Federal Register, with each order's number, signing date and official title, exactly as published, and the Register's notes (for example "Revoked by"). The Governor's from the Office of the Governor's website: its "Executive orders" posts, with the signed order linked when the post links it. The titles of those posts are the Governor's Office's own headlines, shown as published. Each order's page quotes, word for word from its text, <strong>the authority it claims</strong> ("By the authority vested in me …"); that is what the order says about itself, not a finding that it has that authority. A signed order that's a scanned image, with no readable text, says so.</li>
    <li><strong>In the courts:</strong> court opinions and case filings on CourtListener, a free public database of court records, that mention an order by its number, newest first. A case is listed because something filed in it mentions the order; that doesn't mean the order is what the case is about. Filings are described exactly as the court docketed them (for example a motion for a preliminary injunction, or an order granting one). ThePillory doesn't summarize cases or call outcomes.</li>
    <li><strong>Bills signed and vetoed:</strong> for Congress, each bill's actions on Congress.gov; for California, each bill's history on California Legislative Information (leginfo). An outcome is recorded only from the action that states it ("Signed by President.", "Vetoed by Governor.", "Became Public Law No: …"). When a bill became law and the record shows no signature, ThePillory says exactly that and doesn't assume one. The President or Governor named is whoever held the office on that date.</li>
    <li><strong>Nominations:</strong> civilian nominations the President sent to the Senate, from Congress.gov, with each one's latest action as Congress.gov records it.</li>
    <li><strong>Money and disclosures:</strong> every office the same way, whatever the officeholder's party. The President: campaign money from the Federal Election Commission, like members of Congress, the inaugural committee, and financial disclosure reports. The Vice President: the ticket's campaign money (the FEC records it under the President's campaign committee), the inaugural committee, and financial disclosure reports. Cabinet members are appointed, so they have no campaign money; their financial disclosure reports and ethics agreements are shown instead. California's statewide officers: their state campaign committees, contributions and independent expenditures, and their Form 700 statements. See <a class="inline-link" href="#funding">Campaign funding</a> and <a class="inline-link" href="#disclosures">Financial disclosures</a>.</li>
  </ul>
  <p>No scores, grades or commentary: counts of what's on the record, and the record itself.</p>
</section>

<section class="card stack" id="promises">
  <h2>Platform and promises</h2>
  <p>A promise is a <strong>specific, checkable commitment</strong> an official made: an action, a vote or a deadline, with an object, that anyone could later check happened or didn't. General values, priorities and positions are not promises.</p>
  <ul class="plain-list small">
    <li><strong>Quoted exactly,</strong> with the date and a link to the source. The quote is checked word for word against the source before it's published; a quote that doesn't match is dropped, never corrected.</li>
    <li><strong>The same sources for everyone of the same office:</strong> official press releases, inaugural addresses, and State of the Union and State of the State addresses; for county supervisors, official meeting agendas and minutes. Every official with a Platform page is tracked: their own office website’s “Issues” or “Priorities” page is found automatically, by following links from the site’s home page the same way for everyone (Calaveras County’s representatives first, then California, then everyone else), and a person can add a campaign page or remove a wrong one. When no page is found, the Platform tab says so, with a link to the official’s website.</li>
    <li id="ai-identified"><strong>“AI-identified, auto-checked.”</strong> Documents with no sentence committing to an action are set aside first, by a simple word check (will, plan to, by a date), the same for everyone; addresses are read first. An AI model reads the rest with the same instructions for every official and finds up to ten promises a day. Each one is then checked in code, and published only if it passes every check: the quote is in the source word for word; it commits the official to act; it names a specific action, vote or deadline (signing, vetoing or voting on a measure, introducing a bill, or a concrete action with a date, an amount or a named measure; “fight for”, “protect” or “make the state safer” alone are dropped); the note ThePillory adds is plain and neutral; and a deadline is kept only when the quote states it. What passes is published at once, labeled “AI-identified, auto-checked”. What doesn't is never shown.</li>
    <li><strong>Statuses:</strong> every promise starts at No action yet, then In progress, Kept or Broken. A status changes only with evidence and a source, and every change stays listed under the promise with its date, evidence and source. When the AI finds a passage in a later official document showing a promise moving, it's checked the same way (the passage word for word, a neutral note, a forward step): In progress and Kept are published with their evidence, labeled “AI-identified, auto-checked”; Broken is shown only after a person checks the evidence.</li>
    <li><strong>People check the work.</strong> About one in ten auto-published promises, picked at random, goes to a person for a spot check, the same rate as constitutional analyses. Anyone can report a promise with “Something wrong?” (no account needed); it stays up, marked “Under review”, until a person decides. A person can confirm a promise, which then shows “Reviewed by” with their name and the date, or take it down; nothing is deleted, and every decision is kept.</li>
    <li><strong>In their own words.</strong> At the top of each official’s Platform tab: a short excerpt, word for word, from their own Issues or Priorities page, with a link to the whole page. It’s picked automatically with the same instructions for every official (the page’s own summary of what they say they’ll work on, never the passage most likely to make them look good or bad), checked word for word against the page, and refreshed monthly; a reviewer can choose another passage or hide it, and the page shows who chose it. Statements an official’s office sends in are shown in full, exactly as sent, labeled “Submitted by the official”. Commitments tracked appear below once at least one promise is published.</li>
    <li><strong>Added by a person.</strong> A reviewer can also record a promise from a meeting video, an interview or another public record, with the time in the video where it was said. The same checks apply, and it shows "Reviewed by" with their name.</li>
    <li><strong>Neutral wording.</strong> ThePillory adds only a short, plain note on what would show the promise done. No characterization of the official, no predictions.</li>
  </ul>
</section>

<section class="card stack" id="funding">
  <h2>Campaign funding and lobbying</h2>
  <p><strong>Money and votes are shown side by side, as facts.</strong> ThePillory never says or implies that money caused a vote. A contribution and a vote can sit next to each other in the record for many reasons, and the data can't tell you why someone voted as they did. Every number says what it counts, the period it covers, and where it comes from.</p>
  <ul class="plain-list small">
    <li><strong>Campaign funding (members of Congress):</strong> from the Federal Election Commission (FEC), for the current and the previous two-year period (for example 2025–2026), as of each campaign's latest report. Totals cover all of a member's authorized campaign committees. PAC contributions are every contribution from PACs and other political committees (FEC line 11C) to the member's principal campaign committee, summed by committee. Outside spending is independent expenditures for or against the member: groups spending on their own, not money given to the campaign. Members are matched to their FEC records through the public congress-legislators project; a member without an FEC record (often a newly appointed senator) says so.</li>
    <li><strong>Where the money came from:</strong> small donors are people who gave $200 or less in the period (the FEC doesn't itemize them); larger donors gave more than $200; then PACs, party committees, and the candidate's own money and loans. The chamber comparison is the average of the members of the same chamber whose filings for that period are loaded. A senator's fundraising depends on where they are in a six-year term, so compare senators with care.</li>
    <li><strong>Industries are approximate.</strong> The FEC doesn't assign industries. ThePillory sorts a PAC's name, or the employer a donor named, into a category by fixed keyword rules (for example "bank" or "credit union" → Finance, insurance and banking). The rules are the same for everyone. A name that matches no rule stays "Not classified" rather than guessed, and each page says what share of the money matched. Another member's leadership PAC or campaign is its own category, from the FEC record.</li>
    <li><strong>Individual donors are never named.</strong> No donor below $2,000, or above it, is listed by name; individual giving is shown only as totals, by size, and by the employers donors named, and an employer only when three or more people named it. "Retired", "None" and similar answers aren't employers.</li>
    <li><strong>Federal law restricts the use of this data.</strong> Information about individual contributors in FEC reports may not be sold or used to ask for contributions or for any commercial purpose (52 U.S.C. 30111(a)(4)). ThePillory offers no download or export of donor information.</li>
    <li id="donors-not-disclosed"><strong>"Donors not disclosed":</strong> some groups that spend on ads for or against a candidate file with the FEC as independent spenders, not as political committees; many are nonprofits. They report what they spend (FEC Form 5), but they have to report only the donors who gave specifically to pay for those ads, and they often report none. ThePillory labels their spending "Donors not disclosed". It means the public record doesn't show who paid for that spending. It doesn't mean anything was done wrong, and it doesn't say who the donors are. Super PACs and other political committees report their donors to the FEC, so they aren't labeled. The label describes the spender only: a committee can itself receive money from groups that don't disclose theirs. A spender's type comes from its FEC record.</li>
    <li><strong>People spending their own money</strong> on ads for or against a candidate are shown as "An individual, spending their own money (name not shown)", because ThePillory doesn't name individuals in money data.</li>
    <li><strong>Inaugural committees:</strong> the committee that raised money for the President's inauguration, from its reports to the FEC (Form 13). Inaugural committees have no federal limit on donation size, and they report every donation of $200 or more after the inauguration. Each report's total is shown as the report states it; because a later report can repeat earlier amounts, they aren't added together. The itemized donations in the main report are summed: organizations by name, individuals only as a count and a total, never by name. The breakdown is shown only when it adds up to the report's own total (within 5%).</li>
    <li><strong>Lobbying:</strong> from the federal Lobbying Disclosure Act database (lda.gov), for bills in Congress with a final-passage vote. Lobbying reports describe their issues in their own words, so a bill's reports are found by searching for its number ("H.R. 4" and "H.R.4") during that Congress's two years. Each mention is then checked: "H.R. 4" isn't "H.R. 40", and because bill numbers restart every Congress, a mention next to another Congress, or followed by a different bill's title, is set aside. A report that writes the number another way can be missed. Each organization links to its report.</li>
    <li><strong>Lobbying amounts cover the whole report.</strong> A report's income (a lobbying firm) or expenses (an organization lobbying for itself) covers every issue it lists, not just one bill, so the total on a bill page overstates spending on that bill. An amended report replaces the one it amends.</li>
    <li><strong>On a bill page, for your reps:</strong> each rep's recorded vote is shown beside contributions, in the same two-year period, from the industries of the organizations that lobbied on the bill. This shows a relationship in the data, not a cause.</li>
    <li><strong>California's Governor, statewide officers and all 120 legislators:</strong> from the Secretary of State's Cal-Access export, rebuilt weekly. A campaign statement (Form 460) counts as an official's when it's filed by a candidate or a committee the candidate controls and names the official as the candidate (for legislators, for the seat they hold), since January 2023 for statewide officers and January 2025 for legislators. An amended statement replaces the one it amends. Totals are by two-year period: what each statement reports as contributions received and expenditures made, added up. Contributions itemized on Schedule A ($100 or more) are shown the same way as for members of Congress: individuals only as totals and by employer (an employer is listed only when 3 or more people named it), never by name, at any amount; committees, parties, businesses and other organizations by name; industries approximate, by the same keyword rules. Refunds are subtracted, and transfers between an official's own committees aren't counted. <strong>Independent expenditures</strong> for and against an official come from Form 496 reports, which are filed for $1,000 or more spent in the 90 days before an election; spending outside that window isn't included. California replaces Cal-Access with a new system (CARS) after the November 2026 election; the data will move to it then.</li>
    <li><strong>The county:</strong> not shown yet. Calaveras County's campaign statements since 2021 are on its public filing portal; county funding will be added from it.</li>
  </ul>
</section>

<section class="card stack" id="topics">
  <h2>Topics</h2>
  <p>Topics tie records about the same subject together: bills and how a place's representatives voted, county meeting items, executive actions, what officials say on their own Issues pages, and campaign money from industries tied to the subject. <strong>They're shown side by side as facts.</strong> A topic page never says that one record caused another, or why anyone voted, acted or gave as they did.</p>
  <ul class="plain-list small">
    <li><strong>One fixed list of topics,</strong> the same for every place, official and party: {topic_names}.</li>
    <li><strong>AI-tagged, with a reason.</strong> A small AI model reads each bill's title (and its plain summary or the relevance check's one-line description), each county agenda item's title (and its AI summary), each executive order's title, and each Platform excerpt, and gives it up to three topics, each with one short, plain sentence saying why. Items that are only procedure or ceremony (a roll call, the pledge, approving minutes, an honorary resolution) get none. The instructions are the same for every item and official, and judge by subject only; a reason with loaded or judging wording is replaced by a plain one. Bills the relevance check set aside as ceremonial or routine aren't tagged.</li>
    <li><strong>Correctable.</strong> A person can correct any item's topics on the review page. The old tags stay in the item's history, the new ones show the person's name, and the AI doesn't tag that item again. A Platform excerpt is tagged again when its text changes.</li>
    <li><strong>Funding by topic</strong> uses a fixed table from the campaign-funding industries to topics: {industry_map}. Other industries (lawyers and lobbyists, issue groups, leadership PACs, government, media, tribal governments, and money not classified) aren't tied to a topic, and topics without a related industry show no money. Industries are approximate (keyword rules on names, see Campaign funding), and an industry tied to a topic says nothing about what a contribution was for. Members of Congress: contributions in the current two-year period from PACs and donors' employers (FEC). California officials: their latest two-year period's itemized contributions (Cal-Access).</li>
    <li><strong>For a place,</strong> a topic page lists the latest bills on the topic with a final-passage vote and how each of the county's representatives voted (every district that overlaps the county, so a county split between districts shows each), county meeting items for live communities, the President's and the Governor's executive actions, excerpts from the officials' own pages, and the money above.</li>
  </ul>
</section>

<section class="card stack" id="time-machine">
  <h2>The Time Machine</h2>
  <p>A year slider on county, official and topic pages shows the page as it was in an earlier year, back to 1993. A banner on every past-year view names the year, with one tap back to today. Who held an office is shown as a fact, with party as plain text, the same for everyone. Each past-year view ends with a list of what isn't available for that year, instead of leaving blanks.</p>
  <ul class="plain-list small">
    <li><strong>Presidents, Vice Presidents and members of Congress:</strong> every term from the Biographical Directory of the United States Congress (through the congress-legislators project, which also lists Presidents and Vice Presidents). A county's members of the House come from the districts that covered it that year, from the Census Bureau's county-to-district files: the 108th Congress's districts for 2003 to 2012 (a state that redrew its lines later in that decade isn't reflected), the districts drawn after the 2010 census for 2013 to 2022, and those drawn after the 2020 census since. District lines before 2003 aren't in these files.</li>
    <li><strong>The Cabinet:</strong> Senate confirmations from Congress.gov's nomination records, from the 107th Congress (2001) on. For each department, a year shows the latest confirmation on or before December 31. The records don't show departures, acting secretaries or recess appointments, so a person listed may have left during the year.</li>
    <li><strong>California:</strong> Governors from the California State Library's list. The other statewide officers and legislators are the winners in each general election's Statement of Vote from the Secretary of State (the candidate with the most votes in each contest), from 2002 on; an office elected in November is shown from the following January, and a State Senate seat (a four-year term) from the latest election that included it. Appointments, special elections and vacancies aren't in these records. California's legislative districts for a county come from the Census Bureau's files from 2013 on.</li>
    <li><strong>County officials:</strong> no online county record of past supervisors has been found, so county offices aren't shown for past years.</li>
    <li><strong>Votes:</strong> House roll calls from the Clerk of the House and Senate roll calls from the Senate, loaded back to 2001 a little each day, newest first, with each member's position as recorded and the whole chamber's totals. California floor votes are loaded for the current session only.</li>
    <li><strong>Executive orders:</strong> the Federal Register, from 1994, with titles exactly as published.</li>
    <li><strong>Campaign money:</strong> each campaign's totals by two-year period as reported to the FEC (raised, spent and cash on hand). Contributors by industry are shown for the current period only, and California's Cal-Access money for the current period only.</li>
    <li><strong>Public finances by term</strong> (<a href="/finances/">federal</a>, <a href="/finances/california/">California</a>): every term is shown with the same measures and layout. The start is the fiscal year that ended before the term began; the end is the last fiscal year that ended during it (or the latest published, for a term in progress). Each measure shows both values, the change in dollars and in percent, the share of GDP, and the amount per person and per household. Sources: Treasury's Debt to the Penny and Historical Debt Outstanding (debt at the end of each fiscal year), OMB's Historical Tables 1.1 (receipts, outlays, surplus or deficit), 3.1 (outlays by function, including net interest) and 10.1 (GDP by fiscal year), Census Bureau population estimates (July 1) and households (Current Population Survey, Table HH-1); for California, the Department of Finance's Chart A (General Fund) and its population and housing estimates (January 1). Amounts are in dollars of each year, not adjusted for inflation.</li>
    <li><strong>Fiscal years:</strong> the federal fiscal year starts October 1 and California's July 1. A new administration takes office in January, partway through a fiscal year whose budget was largely set before it, so a term's first fiscal year mostly reflects earlier decisions. Both pages say so.</li>
    <li><strong>Party control</strong> of each chamber of Congress is shown as the House and Senate historians list it, for every Congress that overlaps a term; when the Senate's majority changed during a Congress, each change is listed. The California Legislature's seats come from the winners in each general election (seats filled otherwise aren't counted, and the page shows how many seats were read).</li>
    <li><strong>Marked events</strong> are plain factual markers kept only when the source states them: recessions as dated by the National Bureau of Economic Research, the authorizations for the use of military force enacted by Congress (Public Laws 107-40 and 107-243), and public health emergencies declared by the Department of Health and Human Services.</li>
    <li><strong>No cause and effect.</strong> Numbers sit beside who held office, which party led each chamber, and what happened in the world. ThePillory doesn't color anything by party, uses no evaluative labels, and never says that an officeholder caused a number.</li>
  </ul>
</section>

<section class="card stack" id="elections">
  <h2>Elections</h2>
  <p>What's on the ballot, from official sources only, with a link to each. Every candidate and measure is shown the same way, in ballot order. ThePillory doesn't endorse candidates or measures, and doesn't publish polls, predictions or race calls.</p>
  <ul class="plain-list small">
    <li><strong>Contests and candidates:</strong> the Secretary of State's Certified List of Candidates: each candidate's name, ballot designation and party preference exactly as certified, and the Supreme Court and Court of Appeal justices on the ballot, with each question as the list words it. Local contests come from the county elections office's list of qualified candidates, for counties where ThePillory is live (Calaveras so far). No candidate's address, phone or email is kept.</li>
    <li><strong>Ballot order:</strong> California orders candidates by a randomized alphabet the Secretary of State draws for each election, reading the last name first, then the first and middle names. Statewide offices rotate by Assembly district: the order drawn is used in Assembly District 1, and in each later district the first name moves to the bottom. Your ballot shows the order for your Assembly district. Congressional candidates rotate among the Assembly districts within the district, and a county can draw its own order for a legislative district that crosses county lines, so for those offices your sample ballot may differ; the page says so. A surname with more than one word is read as the last word unless it starts with a word like "de", "van" or "le", because the certified list doesn't mark where a surname begins. For Calaveras County's local contests, the order computed this way matches the county's own list in every contest.</li>
    <li><strong>Candidate statements:</strong> word for word from the state Official Voter Information Guide (statewide offices) and the county's Voter Information Pamphlet (the county's contests, and the district offices on its ballot). A statement from a PDF is copied as printed, with the PDF linked as the official version. Lines giving a candidate's email or phone are left out, the same for every candidate, and the page says so. A candidate without a statement says where we looked.</li>
    <li><strong>Officeholders:</strong> a candidate who already holds an office ThePillory follows links to their Platform, Votes and Funding. They're matched by name: the last name and the first name (or the nickname the ballot gives) must both match one official, or no link is shown.</li>
    <li><strong>Federal candidates:</strong> each U.S. House candidate links to their filing with the Federal Election Commission, matched by last name and district; a candidate without a match says so.</li>
    <li><strong>Ballot measures:</strong> the official title and summary, what a yes and a no vote mean, and the arguments and rebuttals for and against, word for word, each with who signed it, from the Official Voter Information Guide. Local measures show the question as it appears on the ballot, County Counsel's impartial analysis, the tax rate statement and the arguments, from the county's pamphlet. Where no argument was filed, the page says so.</li>
    <li><strong>How to vote:</strong> links to the Secretary of State's and the county's own pages for registration, deadlines, vote centers and drop boxes, rather than repeating details that could change.</li>
    <li><strong>Your ballot:</strong> built from the district numbers saved in your browser (never your address). Local contests are for part of a county (a supervisor district, a city, or a school, fire or water district), so they're listed as "on some ballots in the county". Your official sample ballot is the final word.</li>
    <li><strong>Results:</strong> after the polls close at 8 p.m. on Election Day, from the Secretary of State's results feed, with the share of precincts reporting and the time of the update as the feed states them. Before then the feed carries test numbers, which are never shown. Local results link to the county elections office. Counts continue until each county certifies; ThePillory doesn't call races.</li>
    <li><strong>Washington:</strong> the three statewide measures, from the Secretary of State's official documents: the ballot title and explanatory statement written by the Office of the Attorney General, the summary of the fiscal impact statement written by the Office of Financial Management (as the Voters' Pamphlet prints it), and each side's argument and rebuttal from the Voters' Pamphlet, with who wrote them (contact lines left out). Every paragraph is checked word for word against its source before it's published. Candidates and local measures in Washington are in the official Voters' Guide, which each page links.</li>
    <li><strong>The ballot preview, every state ("Preview [State]'s ballot"):</strong> before you enter an address, your state's U.S. Senate race (when a seat is up, by the Federal Election Commission's list of 2026 races) and, once your district is known, your U.S. House race: the candidates who have filed with the FEC and passed its $5,000 threshold, listed alphabetically with their names and parties as filed. That list is not the certified ballot (some candidates lose a primary or withdraw), and the page says so. A candidate who holds the office links to their Votes and Funding, matched by their FEC candidate ID. Your state's election office (as USA.gov lists it) and Vote.gov are linked for registration, the sample ballot, where to vote and deadlines. With an address, the page asks Google's Civic Information API, which carries what state and county election offices publish through the Voting Information Project, for every contest, candidate and measure on that ballot, with polling places, early-voting sites and drop-off locations. Contests are in ballot order and candidates in the order the official data lists them, each with the party as listed, every one in the same layout; a candidate's contact details aren't shown. A name links to an official on ThePillory only when exactly one official in the state has that first and last name, and a measure links to ThePillory's page only by its number. When there's no data for an address yet, the page says so and links the state's official sample ballot lookup. Always confirm your ballot with your county election office.</li>
    <li><strong>Refreshed daily</strong> during election season from the same sources (the "Refresh election data" workflow).</li>
  </ul>
</section>

<section class="card stack" id="candidates">
  <h2>Candidates</h2>
  <p>Pages for candidates who aren't in office yet, with the same layout for every candidate: the race, the election date, Platform, Votes, Funding and More. ThePillory doesn't endorse candidates, and doesn't publish polls, predictions, rankings or contact details.</p>
  <ul class="plain-list small">
    <li><strong>How candidates are included:</strong> every candidate the Federal Election Commission lists as an active statutory candidate for the U.S. Senate or House this cycle (registered, and past the $5,000 threshold), by one rule for everyone; nobody is added or left out by hand. Where ThePillory has a state's certified candidate list (California now; other states as their lists are added), its candidates are included too, including candidates for Governor, the other statewide offices and the Legislature.</li>
    <li><strong>Order:</strong> in a race, candidates on a certified list are shown in official ballot order; everyone else is listed alphabetically by last name. Every candidate gets an identical card.</li>
    <li><strong>Labels:</strong> before the election, "Candidate · Not yet in office", with "Filed for [office], [year]" where there's only the FEC's list (it doesn't record primary results). Where a certified list shows who is on the November ballot, a filer who isn't on it is labeled "Filed for [office], [year]". After the election, winners take office and get an official page; their candidate page stays. Everyone else keeps their page, marked "Ran for [office], [year]" where they were on a certified ballot, otherwise "Filed for [office], [year]". A candidate the FEC stops listing as active keeps their page, with the date they were last listed.</li>
    <li><strong>Other offices:</strong> a candidate who holds or held an office ThePillory records (for example, a state legislator running for Congress) links to that office's record and votes. The link is made by FEC ID for members of Congress, otherwise only when exactly one official in the state has the same first and last name, and the page says it was matched by name.</li>
    <li><strong>Money:</strong> the same totals and the same rules as officials' Funding tabs: money raised and spent in the two-year period, cash on hand, where it came from, and contributions from PACs and other committees, by name. Individual donors are never named.</li>
    <li><strong>Campaign website:</strong> as listed in the campaign committee's FEC filing (Form 1). Nothing else from that filing is shown: no email, phone, address or treasurer.</li>
    <li><strong>Platform:</strong> the issues or priorities page on that website, found the same way as officials' pages, and a short excerpt from it, one to three sentences picked automatically by the same instructions for every candidate and official and checked word for word against the page in code, with a link to the whole page. Sites are searched a few dozen a day, in turn, and again monthly. A person can hide an excerpt or remove a wrong page.</li>
    <li><strong>Refreshed daily:</strong> the FEC list in the "Refresh election data" workflow; money and websites in the "Refresh candidate data" workflow, a few hundred candidates a run, oldest first, within the FEC's hourly limit. Races on the November 3, 2026 ballot come first; 2027 and 2028 candidates are added as they file.</li>
  </ul>
</section>

<section class="card stack" id="scotus">
  <h2>The Supreme Court</h2>
  <p>The justices, their decisions and this term's cases, from the Court's own records, with a link to each. The same layout for every justice. ThePillory doesn't label justices, score them, group them or predict outcomes.</p>
  <ul class="plain-list small">
    <li><strong>The justices:</strong> the Court's list of current justices and their official biographies (word for word, leaving out family details), and the Senate's record of each nomination and confirmation vote, linked to the roll call.</li>
    <li><strong>Decisions:</strong> each opinion the Court has published on supremecourt.gov since the oldest term its site lists, with the one-line summary the site gives. Who wrote and who joined each opinion comes from the opinion's own syllabus (its last paragraph), word for word; a sentence that can't be read reliably is left out rather than guessed. Unsigned (per curiam) opinions have no such paragraph and aren't counted in a justice's record.</li>
    <li><strong>The Constitution:</strong> each provision the opinion of the Court names by a name that points to one provision (such as "First Amendment" or "Commerce Clause"), with the first sentence that names it, quoted exactly. A name that could mean two provisions isn't linked.</li>
    <li><strong>This term:</strong> the Court's Granted &amp; Noted list (argument dates) and each case's question presented, word for word from the Court's docket.</li>
    <li><strong>Financial disclosures:</strong> the justices' annual reports, gifts and reimbursements as CourtListener (Free Law Project) transcribes them, each linked to the filed report. Organizations are named; a person is listed as "An individual".</li>
    <li><strong>Refreshed daily</strong> (the "Refresh Supreme Court data" workflow).</li>
  </ul>
</section>

<section class="card stack" id="disclosures">
  <h2>Financial disclosures</h2>
  <p>Officials' own reports of their finances, listed with a link to each document. ThePillory lists these records; it doesn't summarize, score or interpret what's in them.</p>
  <ul class="plain-list small">
    <li><strong>Federal (the President, the Vice President, the Cabinet):</strong> from the Office of Government Ethics (OGE). Senior officials file public financial disclosure reports (OGE Form 278e) listing their assets, income, debts, outside positions and agreements, and periodic reports of transactions. Nominees sign an ethics agreement saying how they'll avoid conflicts of interest, for example by selling assets or stepping aside from certain matters, and later certify that they did. OGE's records are searched by the official's last name, and a record is kept only when the first name matches too. Each record shows its type, the position it was filed for, and the date OGE added it. OGE releases some documents only on request (its Form 201), so those link to the request form.</li>
    <li><strong>California (the Governor, the statewide offices and legislators):</strong> each official's Statement of Economic Interests (Form 700), from the Fair Political Practices Commission's Form 700 search. A statement is listed when the filer's first and last name match and it was filed for the official's office (for a legislator, the State Assembly or State Senate; statements filed only for a board the official sits on aren't listed). The FPPC's links to statements expire, so ThePillory asks the FPPC for a fresh link when you open one.</li>
  </ul>
</section>

<section class="card stack-sm">
  <h2>What a full analysis contains</h2>
  <p class="small">A short card has the first four parts, briefly: the summary, the one to three most relevant provisions, one sentence for each panel, and contested readings only when a question is genuinely contested.</p>
  <ul class="plain-list small">
    <li><strong>What the bill does:</strong> a short, plain summary without judgment words.</li>
    <li><strong>Provisions it touches:</strong> each quoted from the Constitution, with one sentence on why.</li>
    <li><strong>Where it aligns</strong> and <strong>where it may be in tension</strong> with that text, written as questions a careful reader could raise, not conclusions. Every panel, including the next one, is written the same way ("One view is that …"), with the same hedging and similar length.</li>
    <li><strong>Why this might still serve the public:</strong> where a policy departs from the baseline, the case for it, including whether it would need a constitutional amendment under Article V.</li>
    <li><strong>How different approaches read it:</strong> for contested questions only, how a reading based on original meaning, one based on precedent, and one based on evolving interpretation would each see it, side by side.</li>
    <li><strong>Cases cited:</strong> only cases verified in CourtListener, each linked to the opinion.</li>
    <li><strong>What it can't tell you:</strong> the limits of the analysis. When only part of a long bill's text (or only its official summary) was read, the summary says so, and nothing describes sections that weren't read.</li>
  </ul>
</section>

<section class="card stack-sm">
  <h2>The Constitution's text</h2>
  <p class="small secondary">ThePillory quotes the Constitution and its 27 amendments only from one stored copy of the National Archives transcription, which keeps the original spelling (such as "chuse" and "Controul"). The <a href="/laws/constitution/#full-text">full text</a> is on the Constitution page, and an automatic check compares it with the Archives whenever it changes.</p>
</section>

<section class="card stack-sm">
  <h2>Reports and issues</h2>
  <p class="small">Reporting isn't open yet: it opens when accounts launch. When it does, this section will explain how reports are reviewed, corroborated, and given a confidence level. <a class="inline-link" href="/about/how-it-works/">How it works</a></p>
  <p class="small secondary">How reports are reviewed, corroborated, and given a confidence level.</p>
</section>"""
    main = main.replace("{topic_names}", e(topic_names)).replace("{industry_map}", e(industry_map))
    render("about/methodology", "Methodology", main, tab="you", back=("About", "/about/"))


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

def build_issues():
    """/issues/: every report and issue. None yet: reporting opens when accounts launch."""
    main = f"""
<header class="page-head">
  <h1>Issues near you</h1>
  <p class="subtitle">Reports from verified residents, with evidence, grouped into issues.</p>
</header>
{EMPTY_REPORTS}"""
    render("issues", "Issues near you", main, tab="home", back=("Home", "/"))


def build_report():
    """The + Report tab: reporting isn't open yet."""
    main = """
<header class="page-head">
  <h1>Report</h1>
  <p class="subtitle">Tell your community what happened, with the evidence to back it up.</p>
</header>
<section class="card empty-state stack-sm">
  <p>No reports yet. Reporting opens when accounts launch.</p>
  <p class="small secondary">Reports will come from verified residents, one voice each, with names and addresses never shown. Each report states the facts, attaches evidence, and keeps the resident's perspective in its own section.</p>
  <a class="inline-link" href="/about/how-it-works/">How it works</a>
</section>
<section class="card stack-sm">
  <h2 class="label">What you can do now</h2>
  <p class="small">See how your officials vote, read the constitutional analysis of the bills they vote on, and comment at Calaveras County meetings.</p>
  <div>
    <a class="list-row link-row" href="/#take-part"><div><div class="list-title">Comment deadlines and ways to take part</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
    <a class="list-row link-row" href="/reps/"><div><div class="list-title">Your reps</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
    <a class="list-row link-row" href="/laws/"><div><div class="list-title">Bills and the Constitution</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
  </div>
</section>"""
    render("report", "Report", main, tab="report", root=True)


def build_you():
    about = "".join([
        link_row("/about/", "About ThePillory"),
        link_row("/about/how-it-works/", "How it works"),
        link_row("/about/principles/", "Principles"),
        link_row("/about/methodology/", "Methodology", "How analyses and summaries are made and checked"),
        link_row("/about/how-a-bill-becomes-law/", "How a bill becomes law"),
        link_row("/about/how-to-read-a-vote/", "How to read a vote"),
    ])
    main = f"""
<header class="page-head">
  <h1>You</h1>
  <p class="subtitle">Your account, and about ThePillory.</p>
</header>
<section class="card empty-state stack-sm">
  <p>Accounts aren't open yet.</p>
  <p class="small secondary">When they launch, you'll verify once that you're a real resident. Then you can report, corroborate, and follow reps, bills and meetings. Other people will only ever see "Verified resident · [County]", never your name, address or ID.</p>
</section>
<section class="card stack-sm">
  <h2 class="label">Your districts</h2>
  <p class="small">To see your own reps and briefing, look up your districts with an address or ZIP code. Only the district numbers are kept, in this browser. <a class="inline-link" href="/#find">Find your representatives</a></p>
</section>
<section class="card stack-sm" id="privacy" aria-labelledby="h-privacy">
  <h2 class="label" id="h-privacy">Privacy</h2>
  <ul class="plain-list small stack-xs">
    <li>We use your approximate state, based on your connection, to show relevant information. It is not stored.</li>
    <li>Only your state is taken from your connection, never your county or district. A state you choose on the home page is saved only in this browser.</li>
    <li>An address or ZIP code you look up is used only to find your districts. It isn't stored or logged; only the district numbers are kept, in this browser.</li>
    <li>To decide which states' records to load first, ThePillory counts lookups per state and day. No address, ZIP code or visitor is kept, only the count.</li>
    <li>An address you enter for a ballot preview is sent to Google's Civic Information API for that one lookup, to find your ballot and where to vote. ThePillory doesn't store or log it, and the page with your ballot isn't saved anywhere. To keep the lookup working for everyone, each connection may make a limited number a day; only a daily-changing code for the connection is counted, never the address.</li>
  </ul>
</section>
{section("Elections", link_row("/ballot/", "Preview your state's ballot", "Your federal races, then your whole ballot for your address") + link_row("/elections/2026-11-03/ballot/", "Your ballot in California", "The contests and measures for your districts") + link_row("/elections/", "Elections", "What's on the ballot, and how to vote"))}
{section("About", f'<div>{about}</div>')}"""
    render("you", "You", main, tab="you", root=True)


def build_about():
    links = "".join([
        link_row("/about/how-it-works/", "How it works"),
        link_row("/about/principles/", "Principles"),
        link_row("/about/methodology/", "Methodology", "How analyses and summaries are made and checked"),
        link_row("/about/how-a-bill-becomes-law/", "How a bill becomes law"),
        link_row("/about/how-to-read-a-vote/", "How to read a vote"),
    ])
    main = f"""
<header class="page-head">
  <h1>About ThePillory</h1>
  <p class="subtitle">A fact-based civic accountability platform, built for communities that value facts over noise.</p>
</header>
<section class="card stack-sm">
  <h2 class="label">What's here now</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>Your officials and their votes:</strong> every member of Congress and every California legislator, with every recorded vote and its totals, each linked to the official record. Find yours with an address or ZIP code.</li>
    <li><strong>Bills and the Constitution:</strong> for the bills they vote on, which parts of the Constitution a bill touches, quoted word for word. ThePillory maps the Constitution; it doesn't rule on it.</li>
    <li><strong>Calaveras County, live:</strong> Board of Supervisors and Planning Commission agendas, how to comment, plain-language summaries of each item, and the county's supervisors. More counties open as communities launch.</li>
  </ul>
</section>
<section class="card stack-sm">
  <h2 class="label">What opens with accounts</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>Verified participation, protected identities:</strong> real people, one voice each. Identities are protected by default.</li>
    <li><strong>Evidence-first reports and corroboration:</strong> documents, links, photos, records. Claims without evidence don't travel far.</li>
    <li><strong>Private inputs, public accountability:</strong> individual actions stay private while patterns emerge.</li>
  </ul>
</section>
<section class="card"><div>{links}</div></section>
<p class="small secondary">Nonpartisan: no party labels anywhere, and nothing that suggests a political side.</p>"""
    render("about", "About", main, tab="you", back=("You", "/you/"))


def example_issue_card():
    i = D.EXAMPLE_ISSUE
    return card(None, f"{LEVEL_NAME[i['level']]} · {i['category']}", i["title"], i["responsible"], clause_chip(i["clause"]),
                f"Status: <strong>{e(i['status'])}</strong>", f"Confidence: <strong>{e(i['confidence'])}</strong>",
                level=i["level"], example=True)


HOW_STEPS = [
    ("Join and verify", "Participants verify uniqueness and residency. Real people, one voice each. Identities are protected by default."),
    ("Make a claim", "Claims are tied to a place, category, and timeframe. No vague accusations or drive-by posts."),
    ("Attach evidence", "Documents, links, photos, records. Claims without evidence don't travel far."),
    ("Community actions", "Others can corroborate with evidence, support with context, or identify as affected, all without public pile-ons."),
    ("Aggregate signal", "Individual inputs stay private while patterns emerge: consistency, volume, quality, confidence."),
    ("Publish accountability", "When thresholds are met, the output becomes a structured, shareable record for media, officials, or institutions."),
]


def build_how_it_works():
    steps = "".join(f"""
    <li>
      <span class="step-num" aria-hidden="true">{n}</span>
      <div class="stack-sm">
        <h2>{e(title)}</h2>
        <p class="small secondary">{e(text)}</p>
      </div>
    </li>""" for n, (title, text) in enumerate(HOW_STEPS, 1))
    i = D.EXAMPLE_ISSUE
    main = f"""
<header class="page-head">
  <h1>How it works</h1>
  <p class="subtitle">How residents' reports will become a public, evidence-first record.</p>
</header>
<section class="panel-navy stack-sm small" id="now">
  <p><strong>Live now:</strong> your officials and their votes, bills mapped to the Constitution, and county meeting agendas. <strong>Opens when accounts launch:</strong> verification, reports and corroboration (steps 1 to 6 below).</p>
</section>
<ol class="numbered card">{steps}
</ol>
<section class="stack-sm" id="example">
  <h2 class="label">What a report will look like</h2>
  <p class="small secondary">An example only. It's hypothetical, and not a report about any real official or agency.</p>
  {example_issue_card()}
  <p class="small">Facts, as a resident would file them: {e(i["facts"])}</p>
</section>
<p class="small"><a class="inline-link" href="/about/principles/">Principles</a> · <a class="inline-link" href="/about/methodology/">Methodology</a></p>"""
    render("about/how-it-works", "How it works", main, tab="you", back=("About", "/about/"))


# ---------------------------------------------------------------------------
# Explainers (Understand, on the hub). Plain, neutral, and sourced: every
# source below was checked to load when the page was written.

def sources_block(items):
    rows = "".join(f'<li><a class="inline-link" href="{href}" target="_blank" rel="noopener">{e(label)} ↗</a></li>'
                   for label, href in items)
    return f"""
<section class="card stack-sm" id="sources">
  <h2 class="label">Sources</h2>
  <ul class="plain-list small stack-sm">{rows}</ul>
</section>"""


def steps_list(steps):
    return "".join(f"""
    <li>
      <span class="step-num" aria-hidden="true">{n}</span>
      <div class="stack-sm">
        <h3>{e(title)}</h3>
        <p class="small secondary">{text}</p>
      </div>
    </li>""" for n, (title, text) in enumerate(steps, 1))


def constitution_link(pid, text=None):
    return f'<a class="inline-link" href="/laws/constitution/#{pid}">{e(text or PROVISION[pid]["label"])}</a>'


def build_bill_becomes_law():
    federal = [
        ("A member introduces it",
         "A senator or representative introduces a bill in their own chamber. Bills for raising revenue must start in the House "
         f"({constitution_link('art-1-sec-7-cl-1', 'Article I, Section 7')})."),
        ("A committee studies it",
         "The bill goes to one or more committees. A committee can hold hearings, change the text (a &ldquo;markup&rdquo;), "
         "and send the bill to the full chamber, or never act on it. Most bills stop here."),
        ("The chamber debates and votes",
         "In the House, the terms of debate are usually set by a resolution from the Rules Committee. "
         "In the Senate, debate can continue until senators vote to end it (cloture), which on most bills takes three-fifths of the Senate. "
         "The vote to pass the bill is the <strong>final passage</strong> vote."),
        ("The other chamber does the same",
         "Both chambers must pass the same text. When they pass different versions, they settle the differences by amending "
         "each other's version or through a conference committee, and then vote again."),
        ("The President acts",
         "The President signs the bill into law or vetoes it. Congress can override a veto with a two-thirds vote in each chamber. "
         "A bill the President neither signs nor returns within ten days (Sundays excepted) becomes law, unless Congress has adjourned "
         f"and so prevented its return ({constitution_link('art-1-sec-7-cl-2', 'Article I, Section 7, Clause 2')})."),
    ]
    california = [
        ("Introduction and committee",
         "An Assemblymember or state senator introduces the bill. It goes to a policy committee, and to a fiscal committee if it would cost money."),
        ("Floor vote in the first house",
         "The full Assembly or Senate votes on it. Most bills need a majority of the whole house: 41 of 80 in the Assembly, 21 of 40 in the Senate. "
         "Some bills, such as urgency measures, need two-thirds."),
        ("The second house",
         "The bill goes through committee and a floor vote in the other house. If that house amends it, the first house votes on whether to accept the changes (concurrence)."),
        ("The Governor acts",
         "The Governor signs or vetoes the bill. The Legislature can override a veto with a two-thirds vote in each house."),
    ]
    main = f"""
<header class="page-head">
  <h1>How a bill becomes law</h1>
  <p class="subtitle">The path a bill takes in Congress and in the California Legislature, and where the votes on ThePillory fit in.</p>
</header>
<section class="card stack">
  <h2>In Congress</h2>
  <ol class="numbered">{steps_list(federal)}
  </ol>
</section>
<section class="card stack">
  <h2>In the California Legislature</h2>
  <ol class="numbered">{steps_list(california)}
  </ol>
</section>
<section class="card stack-sm">
  <h2 class="label">Where ThePillory fits in</h2>
  <p class="small">Each bill page shows the recorded votes on the bill, with the totals and the official record for each, and how the bill maps to the Constitution. Final-passage votes show first; procedural, amendment, committee and nomination votes are one tap away and clearly labeled. <a class="inline-link" href="/about/how-to-read-a-vote/">How to read a vote</a></p>
</section>
{sources_block([
    ("The Legislative Process (U.S. House of Representatives)", "https://www.house.gov/the-house-explained/the-legislative-process"),
    ("How Our Laws Are Made (House Document 110-49, GovInfo)", "https://www.govinfo.gov/app/details/CDOC-110hdoc49"),
    ("The Senate Legislative Process (U.S. Senate)", "https://www.senate.gov/legislative/common/briefing/Senate_legislative_process.htm"),
    ("Filibuster and Cloture (U.S. Senate)", "https://www.senate.gov/about/powers-procedures/filibusters-cloture.htm"),
    ("Legislative Process (California State Assembly)", "https://www.assembly.ca.gov/resources/legislative-process"),
    ("Legislative Process (California State Senate)", "https://www.senate.ca.gov/citizens-guide/legislative-process"),
])}"""
    render("about/how-a-bill-becomes-law", "How a bill becomes law", main, tab="you", back=("About", "/about/"))


VOTE_TYPES = [
    ("Final passage",
     "The vote on passing the bill itself, or agreeing to a resolution, in that chamber. In the House it may read &ldquo;On Passage&rdquo; or "
     "&ldquo;On Motion to Suspend the Rules and Pass&rdquo; (a faster route that needs two-thirds). In the Senate, &ldquo;On Passage of the Bill&rdquo;. "
     "These show by default on ThePillory."),
    ("Cloture",
     "A Senate vote to end debate so the Senate can move to a vote. On most matters it takes three-fifths of the senators duly chosen and sworn "
     "(60 when there are no vacancies); on nominations, a majority. A cloture vote is about ending debate, not about passing the bill."),
    ("Motions",
     "Procedural steps: a motion to proceed (Senate) takes up a bill for debate; a motion to table sets a question aside; a motion to recommit (House) "
     "sends a bill back to committee; ordering the previous question (House) ends debate. A vote on a motion isn't a vote on the bill itself."),
    ("Amendments",
     "Votes on changing a bill's text before the final vote."),
    ("Nominations",
     "Senate votes on whether to confirm people the President nominates, such as judges and cabinet officers, under the Senate's power of advice and consent "
     f"({constitution_link('art-2-sec-2-cl-2', 'Article II, Section 2, Clause 2')})."),
    ("Committee votes",
     "In the California Legislature, committees vote on whether to send a bill on. These are recorded too, and labeled."),
]


def build_read_a_vote():
    types = "".join(f"""
<section class="card stack-sm">
  <h2>{e(t)}</h2>
  <p class="small">{x}</p>
</section>""" for t, x in VOTE_TYPES)
    main = f"""
<header class="page-head">
  <h1>How to read a vote</h1>
  <p class="subtitle">What a recorded vote shows, and what kind of vote it is.</p>
</header>
<section class="card stack-sm">
  <h2 class="label">What each vote shows</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>The question:</strong> exactly what was voted on, in the official wording.</li>
    <li><strong>The result:</strong> as the chamber recorded it, such as &ldquo;Passed&rdquo; or &ldquo;Agreed to&rdquo;.</li>
    <li><strong>The totals:</strong> Yes, No, Present, and Not voting, for the whole chamber.</li>
    <li><strong>Each member's position:</strong> Yes (recorded as Yea or Aye), No (Nay or No), Present, or Not voting. The exact wording the record uses is kept with each position.</li>
    <li><strong>The official record:</strong> the Clerk of the House, the Senate, or the California Legislature, which lists every member.</li>
  </ul>
</section>
<h2 class="label">Kinds of votes</h2>
<div class="stack">{types}</div>
<section class="card stack-sm">
  <h2 class="label">Reading the totals</h2>
  <p class="small">How many votes a question needs depends on the question: most need a majority of those voting, some need two-thirds (such as overriding a veto) or three-fifths (such as Senate cloture). &ldquo;Not voting&rdquo; includes members who were absent. The result the chamber recorded is the official outcome.</p>
</section>
<section class="card stack-sm">
  <h2 class="label">On ThePillory</h2>
  <p class="small">Votes are shown as facts: the bill, the exact question, each position, the result, the date and the source. There are no scores, grades, or &ldquo;voted against&rdquo; summaries, and every position has the same style. <a class="inline-link" href="/about/how-a-bill-becomes-law/">How a bill becomes law</a></p>
</section>
{sources_block([
    ("Votes (Clerk of the U.S. House of Representatives)", "https://clerk.house.gov/Votes"),
    ("Roll Call Votes (U.S. Senate)", "https://www.senate.gov/legislative/votes_new.htm"),
    ("Voting in the Senate (U.S. Senate)", "https://www.senate.gov/about/powers-procedures/voting.htm"),
    ("Filibuster and Cloture (U.S. Senate)", "https://www.senate.gov/about/powers-procedures/filibusters-cloture.htm"),
    ("Glossary: cloture (U.S. Senate)", "https://www.senate.gov/reference/glossary_term/cloture.htm"),
    ("Glossary: motion to proceed (U.S. Senate)", "https://www.senate.gov/reference/glossary_term/motion_to_proceed.htm"),
    ("Glossary: table (U.S. Senate)", "https://www.senate.gov/reference/glossary_term/table.htm"),
    ("Glossary: motion to recommit (U.S. Senate)", "https://www.senate.gov/reference/glossary_term/motion_to_recommit.htm"),
    ("Nominations (U.S. Senate)", "https://www.senate.gov/legislative/nominations.htm"),
    ("The Legislative Process (U.S. House of Representatives)", "https://www.house.gov/the-house-explained/the-legislative-process"),
])}"""
    render("about/how-to-read-a-vote", "How to read a vote", main, tab="you", back=("About", "/about/"))


PRINCIPLES = [
    ("Facts first, then dialogue", "ThePillory presents evidence without emotion or spin, so people with different views can work from the same truth."),
    ("Evidence first", "Claims without evidence do not amplify. The system is designed to reward documentation, consistency, and verifiability over volume or emotion."),
    ("Protected identities", "Participants are verified for uniqueness and relevance, but identities are protected by default. Safety enables honesty."),
    ("No public pile-ons", "Individual actions remain private. Only aggregated signal becomes public. The goal is accountability, not spectacle."),
    ("Anti-manipulation by design", "One person, one voice. Astroturfing, brigading, and impersonation are structurally constrained rather than moderated after the fact."),
    ("Nonpartisan", "No party labels anywhere, and nothing that suggests a political side. ThePillory maps the Constitution; it doesn't rule on it."),
]


def build_principles():
    cards = "".join(f"""
<section class="card stack-sm">
  <h2>{e(t)}</h2>
  <p class="small secondary">{e(x)}</p>
</section>""" for t, x in PRINCIPLES)
    main = f"""
<header class="page-head">
  <h1>Principles</h1>
</header>
<div class="stack">{cards}</div>"""
    render("about/principles", "Principles", main, tab="you", back=("About", "/about/"))


def build_constitution():
    tops = [p for p in CONSTITUTION if p["parent"] is None and p["id"] != "preamble"]
    toc = "".join(f'<a class="chip chip--parch" href="#{p["id"]}">{e(p["label"])}</a>' for p in tops)
    preamble = PROVISION.get("preamble")
    main = f"""
<header class="page-head">
  <h1>The Constitution</h1>
  <p class="subtitle">The starting point for every analysis on ThePillory.</p>
</header>
{f'<section class="parchment stack-sm" id="preamble"><h2 class="label">Preamble</h2><p class="quote">{e(preamble["text"])}</p></section>' if preamble else ""}
<nav class="card stack-sm" aria-label="Articles and amendments">
  <h2 class="label">Jump to</h2>
  <div class="chips">{toc}</div>
</nav>
{full_constitution()}
<section class="card stack">
  <h2 class="label">How the baseline works</h2>
  <ol class="numbered">
    <li>
      <span class="step-num" aria-hidden="true">1</span>
      <div class="stack-sm">
        <h3>Every analysis links to the text</h3>
        <p class="small secondary">Each bill's analysis names the provisions it touches, quoted word for word from this text.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">2</span>
      <div class="stack-sm">
        <h3>Alignment is mapped, not ruled</h3>
        <p class="small secondary">Where it aligns and where it may be in tension, each with a source.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">3</span>
      <div class="stack-sm">
        <h3>Departures get a fair hearing</h3>
        <p class="small secondary">Why a different path might serve the public, including the case for amendment under Article V.</p>
      </div>
    </li>
  </ol>
  <a class="inline-link" href="/about/methodology/#analysis">How analyses are made</a>
</section>"""
    render("laws/constitution", "The Constitution", main, tab="laws", back=("Laws", "/laws/"))


def build_search():
    main = """
<header class="page-head">
  <h1>Search</h1>
  <p class="subtitle">Reps, governing bodies, bills, meetings, and the Constitution.</p>
</header>
<div id="search-page-results" class="stack" aria-live="polite"></div>"""
    render("search", "Search", main)


STATE_FULL = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "PR": "Puerto Rico", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}


def search_index():
    """Static search entries: the governing bodies and every provision of the
    Constitution. Officials, bills and meetings are added from D1 by
    /api/search-officials."""
    items = []
    for b in D.BODIES:
        items.append({"type": "Body", "title": b["name"], "sub": LEVEL_NAME[b["level"]] + " · Governing body",
                      "url": f"/bodies/{b['slug']}/", "k": b["short"]})
    items.append({"type": "Constitution", "title": "The Constitution", "sub": "Preamble, articles, and amendments",
                  "url": "/laws/constitution/", "k": "preamble constitution"})
    for p in CONSTITUTION:
        if not p["leaf"] or p["id"] == "preamble":
            continue
        text = p["text"]
        items.append({"type": "Constitution", "title": p["label"], "sub": text[:90] + ("…" if len(text) > 90 else ""),
                      "url": f"/laws/constitution/#{p['id']}", "k": text})
    # Topics (workers/sync/src/topics/list.js).
    items.append({"type": "Topics", "title": "Topics", "sub": "One subject at a time, side by side", "url": "/topics/", "k": "topic topics subject issue"})
    for t in TOPIC_LIST:
        items.append({"type": "Topics", "title": t["name"], "sub": "Topic", "url": f"/topics/{t['slug']}/", "k": t["name"]})
    # The Time Machine's finances pages (functions/finances/).
    items.append({"type": "Laws", "title": "Federal finances by presidential term", "sub": "Debt, spending, interest and the deficit by term", "url": "/finances/", "k": "budget debt deficit spending interest finances president time machine history"})
    items.append({"type": "Laws", "title": "California's budget by governor's term", "sub": "General Fund by term", "url": "/finances/california/", "k": "california budget general fund governor finances time machine history"})
    # Elections (data/elections/, from tools/build_elections.py): the election, its statewide offices and propositions.
    items.append({"type": "Elections", "title": "Elections", "sub": "What's on the ballot, Your ballot, How to vote", "url": "/elections/", "k": "election ballot vote voting register polling"})
    items.append({"type": "Laws", "title": "The Supreme Court", "sub": "The justices and their decisions", "url": "/bodies/us-supreme-court/", "k": "supreme court scotus justices justice court decisions opinions roberts thomas alito sotomayor kagan gorsuch kavanaugh barrett jackson"})
    items.append({"type": "Laws", "title": "This term at the Supreme Court", "sub": "Cases the Court will hear, and its decisions", "url": "/court/term/", "k": "supreme court term cases argument docket question presented"})
    for f in sorted((ROOT / "data" / "candidates" / "2026").glob("[a-z][a-z].json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if not any(c.get("listed") for c in d.get("candidates", {}).values()):
            continue
        name = STATE_FULL.get(d["state"], d["state"])
        items.append({"type": "Elections", "title": f"Candidates in {name}", "sub": "Every 2026 race, the same page for every candidate", "url": f"/races/2026/{d['state'].lower()}/", "k": f"candidates candidate race races challenger running election 2026 {name.lower()} {d['state'].lower()}"})
    items.append({"type": "Elections", "title": "Preview your state's ballot", "sub": "Every state: your federal races, then your whole ballot and where to vote", "url": "/ballot/", "k": "ballot sample my ballot polling place where to vote early voting candidates"})
    # Election files are named by date (2026-11-03.json); other files there (dates.json) aren't elections.
    for path in sorted((ROOT / "data" / "elections").glob("[0-9]*.json"), reverse=True)[:1]:
        e = json.loads(path.read_text(encoding="utf-8"))
        eid = e["election"]["id"]
        items.append({"type": "Elections", "title": e["election"]["name"], "sub": "Everything on the ballot", "url": f"/elections/{eid}/", "k": "ballot candidates propositions"})
        for c in e["contests"]:
            if c["scope"] == "statewide":
                items.append({"type": "Elections", "title": c["office"], "sub": f"{e['election']['name']} · {len(c['candidates'])} candidates",
                              "url": f"/elections/{eid}/contest/{c['id']}/", "k": " ".join(k["name"] for k in c["candidates"])})
        for m in e["measures"]:
            if m["scope"] == "statewide":
                items.append({"type": "Elections", "title": f"Proposition {m['number']}", "sub": m["title"].capitalize()[:90],
                              "url": f"/elections/{eid}/measure/{m['id']}/", "k": f"prop {m['number']} {m['title']}"})
    return ("// Generated by tools/build.py. Don't edit by hand.\n"
            "window.PILLORY_INDEX = " + json.dumps(items, ensure_ascii=False, indent=1) + ";\n")


def write_manifest():
    """site.webmanifest: the home-screen app's name and icons. The square icons
    keep the seal inside Android's safe zone, so they double as maskable."""
    v = f"?v={ICON_VERSION}"
    png = lambda n, purpose: {"src": f"/assets/logo/icon-{n}.png{v}", "sizes": f"{n}x{n}", "type": "image/png", "purpose": purpose}
    manifest = {
        "id": "/", "name": "ThePillory", "short_name": "ThePillory",
        "description": SITE_DESCRIPTION, "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": "#FFFFFF", "theme_color": "#FFFFFF",
        "icons": [png(192, "any"), png(512, "any"), png(192, "maskable"), png(512, "maskable"),
                  {"src": f"/assets/logo/icon.svg{v}", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}],
    }
    (ROOT / "site.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def write_redirects():
    lines = ["# Generated by tools/build.py: old URLs and where they go now. Don't edit by hand."]
    lines += [f"{src} {dst} 301" for src, dst in REDIRECTS]
    (ROOT / "_redirects").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Shared pieces for the Pages Functions (functions/) that render D1 pages
# ---------------------------------------------------------------------------

FUNCTIONS_EXPORT = ROOT / "functions" / "_lib" / "generated.js"


def export_for_functions():
    """Write functions/_lib/generated.js: the page shell and shared snippets.

    Pages Functions render the D1-backed pages (Home, Reps, bodies, Laws,
    meetings) in JavaScript. Rather than duplicate the templates, they import
    the exact shell and card HTML produced here.
    """
    page = shell("%%TITLE%%", "%%MAIN%%", nav="%%NAV%%", back_html="%%BACK%%", title_is_html=True)
    tabbars = {t: {"root": tabbar(t, True), "sub": tabbar(t, False)} for t, _, _ in TABS}
    bodies = [{
        "slug": b["slug"], "name": b["name"], "short": b["short"], "level": b["level"],
        "about": b["about"], "chip": clause_chip(b["clause"], link=True),
        "chip_span": clause_chip(b["clause"]), "card": body_card(b),
    } for b in D.BODIES]
    data = {
        "ASSET_VERSION": ASSET_VERSION,
        "PAGE": page,
        "TABBARS": tabbars,
        "LEVEL_NAME": LEVEL_NAME,
        "BODIES": bodies,
        # Issues residents have reported, by slug. None until reporting opens;
        # agenda watch and the admin review page read this.
        "ISSUES": {},
        "EMPTY_REPORTS": EMPTY_REPORTS,
    }
    out = ["// Generated by tools/build.py. Don't edit by hand; change tools/build.py or tools/data.py and rebuild.",
           "// Shared page shell and snippets for the Pages Functions."]
    for k, v in data.items():
        out.append(f"export const {k} = {json.dumps(v, ensure_ascii=False, indent=1)};")
    FUNCTIONS_EXPORT.parent.mkdir(parents=True, exist_ok=True)
    FUNCTIONS_EXPORT.write_text("\n".join(out) + "\n", encoding="utf-8")


def main():
    for b in D.BODIES:
        if b["clause"][0] not in PROVISION:
            sys.exit(f"build.py: body {b['slug']} cites unknown provision {b['clause'][0]}")
    if D.EXAMPLE_ISSUE["clause"][0] not in PROVISION:
        sys.exit("build.py: the example issue cites an unknown provision")
    build_issues()
    build_report()
    build_you()
    build_about()
    build_how_it_works()
    build_bill_becomes_law()
    build_read_a_vote()
    build_principles()
    build_methodology()
    build_constitution()
    build_search()

    for d in GENERATED_DIRS:
        shutil.rmtree(ROOT / d, ignore_errors=True)
    for path, doc in PAGES.items():
        if path.split("/")[0] not in GENERATED_DIRS:
            sys.exit(f"build.py: {path} is outside GENERATED_DIRS")
        out = ROOT / path / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(doc, encoding="utf-8")
    (ROOT / "assets" / "search-index.js").write_text(search_index(), encoding="utf-8")
    write_redirects()
    write_manifest()
    export_for_functions()
    print(f"Built {len(PAGES)} pages and {len(REDIRECTS)} redirects.")


if __name__ == "__main__":
    main()
