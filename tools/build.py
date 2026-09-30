#!/usr/bin/env python3
"""Build The Pillory's static pages.

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
ASSET_VERSION = "17"  # bump when assets/pillory.css or assets/app.js change

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
    ("/you/privacy/", "/you/"),
    ("/about/funding/", "/about/"),
    ("/about/advisory-group/", "/about/"),
    ("/agency", "/about/"),
    ("/agency/*", "/about/"),
    ("/constitution", "/laws/constitution/"),
    ("/constitution/", "/laws/constitution/"),
]

e = html.escape
LEVEL_NAME = {"county": "County", "state": "State", "federal": "Federal"}

# The empty state for reports and issues, everywhere they would appear.
EMPTY_REPORTS = (
    '<section class="card empty-state stack-sm">'
    '<p>No reports yet. Reporting opens when accounts launch.</p>'
    '<a class="inline-link" href="/about/how-it-works/">How it works</a>'
    "</section>"
)

FOOTER = """<footer class="app-footer" aria-label="About The Pillory">
  <a href="/about/">About</a>
  <a href="/about/how-it-works/">How it works</a>
  <a href="/about/principles/">Principles</a>
  <a href="/about/methodology/">Methodology</a>
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
    ("report", "+ Report", "/report/"),
    ("laws", "Laws", "/laws/"),
    ("you", "You", "/you/"),
]

SEARCH = """
<form class="search" action="/search/" role="search" autocomplete="off">
  <label class="visually-hidden" for="q">Search reps, governing bodies, bills, meetings, and the Constitution</label>
  <input class="input search-input" id="q" name="q" type="search"
    placeholder="Search reps, bills, meetings, the Constitution" aria-controls="search-results" aria-expanded="false" />
  <div class="search-results" id="search-results" hidden></div>
</form>"""

PAGES = {}


def tabbar(current, is_root):
    links = []
    for key, label, href in TABS:
        cls = "tab tab--report" if key == "report" else "tab"
        attr = ""
        if key == current:
            cls += " is-current"
            attr = ' aria-current="page"' if is_root else ' aria-current="true"'
        links.append(f'<a class="{cls}" href="{href}"{attr}>{e(label)}</a>')
    return f"""
<nav class="tabbar" aria-label="Main">
  <div class="tabbar-row">
    <a class="wordmark tabbar-brand" href="/">The Pillory</a>
    <div class="tabbar-inner">
      {"".join(links)}
    </div>
  </div>
</nav>"""


SITE_DESCRIPTION = "Evidence-first civic accountability. Verified residents, protected identities, nonpartisan."
SITE_URL = "https://thepillory.co"


def head_tags(title):
    """Icons, manifest, and link-share (Open Graph) tags for every page."""
    return f"""    <meta name="description" content="{SITE_DESCRIPTION}" />
    <meta name="theme-color" content="#F5F2EA" />
    <link rel="icon" href="/assets/logo/icon.svg" type="image/svg+xml" />
    <link rel="icon" href="/assets/logo/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/assets/logo/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta property="og:site_name" content="The Pillory" />
    <meta property="og:title" content="{e(title)}" />
    <meta property="og:description" content="{SITE_DESCRIPTION}" />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="{SITE_URL}/assets/logo/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="The Pillory: a serif P in a seal beside the wordmark, with the line Evidence-first civic accountability" />
    <meta name="twitter:card" content="summary_large_image" />
"""


def shell(title, main, *, nav="", back_html="", top="", app=True, after="",
          title_is_html=False):
    """The full HTML document around a page's main content.

    Shared by the static pages (render) and, through functions/_lib/generated.js,
    by the Pages Functions that render D1-backed pages, so both stay identical.
    """
    t = title if title_is_html else e(title)
    body_cls = []
    if app:
        body_cls.append("has-tabbar")
    if after:
        body_cls.append("has-action-bar")
    search = SEARCH if app else ""
    scripts = ""
    if app:
        scripts = (f'<script src="/assets/search-index.js?v={ASSET_VERSION}"></script>\n'
                   '    <script src="/api/search-officials"></script>\n'
                   f'    <script src="/assets/app.js?v={ASSET_VERSION}"></script>')
    head = head_tags(f"{t} – The Pillory") if title_is_html else head_tags(f"{title} – The Pillory")
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{t} – The Pillory</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/assets/pillory.css?v={ASSET_VERSION}" />
{head}  </head>

  <body class="{' '.join(body_cls)}">
    <main class="app">
{top}{search}
{back_html}
{main}
{FOOTER if app else ""}
    </main>
{after}{nav}
    {scripts}
  </body>
</html>
"""


def render(path, title, main, *, tab=None, root=False, back=None, top="",
           app=True, after=""):
    """Write <path>/index.html.

    tab:  which bottom tab this page belongs to ("home", "reps", ...).
    root: True for the tab's own landing page.
    back: (label, href) for the back link on deeper pages.
    app:  False for public/standalone pages (no tabs, no search).
    """
    back_html = f'<a class="back-link" href="{back[1]}">← {e(back[0])}</a>' if back else ""
    doc = shell(title, main, nav=tabbar(tab, root) if app else "", back_html=back_html,
                top=top, app=app, after=after)
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
    <p class="small secondary">As transcribed by the <a href="https://www.archives.gov/founding-docs/constitution">National Archives</a>, with its original spelling. Every quote on The Pillory comes from this text.</p>
  </div>
  {blocks}
</section>"""


def build_methodology():
    main = """
<header class="page-head">
  <h1>Methodology</h1>
  <p class="subtitle">How The Pillory maps laws and issues to the Constitution, and how reports are reviewed.</p>
</header>

<section class="card stack" id="analysis">
  <h2>Constitutional analysis of bills</h2>
  <p>The Pillory maps the Constitution; it doesn't rule on it. For bills our officials have voted on, an AI tool writes an analysis showing which parts of the Constitution a bill touches. Automatic checks and a second AI tool check every analysis, and a person reviews any that are flagged, plus a random share of the rest. Nothing here is a verdict on whether a bill is constitutional, and nothing here is legal advice.</p>
  <ol class="numbered">
    <li>
      <span class="step-num" aria-hidden="true">1</span>
      <div class="stack-sm">
        <h3>Which bills get analyzed</h3>
        <p class="small secondary">Bills with a final-passage vote by one of the officials who represent Calaveras County, and any bill an issue on this site links to. (Once residents can follow bills, followed bills will count too.) First, a quick AI check (Claude Haiku) reads each bill's title and sets aside ceremonial and routine measures, such as commemorations, awareness days, post office and building namings, and honorary resolutions. Each one set aside is logged with the reason, the bill page says why, and a person can reverse it. The same check rates how much each bill bears on this county (California, rural counties, federal lands, water, wildfire, roads and similar), so the daily limit goes to what matters most here. It judges by subject only, never by party or sponsor.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">2</span>
      <div class="stack-sm">
        <h3>Two levels: a short card, or a full analysis</h3>
        <p class="small secondary">Most bills get a <strong>short card</strong>: a two to three sentence summary, the one to three most relevant provisions of the Constitution with one sentence each, and one sentence each for where the bill aligns, where it may be in tension, and why a departure might still serve the public. A <strong>full analysis</strong> covers every provision the bill touches, contested readings and what the analysis can't tell you. It's written when an issue on this site links to the bill, or when a resident asks for one with "Request full analysis" on the bill page. Both start from the bill's own words: the latest text on Congress.gov or the California Legislature's site, or the official summary, labeled "limited", when the text isn't available.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">3</span>
      <div class="stack-sm">
        <h3>An AI tool writes it, and automatic checks correct it</h3>
        <p class="small secondary">Claude, an AI model made by Anthropic, writes the card or analysis from the bill text and the full text of the Constitution. Its instructions: no verdicts on constitutionality, no party labels or partisan language, the strongest version of each view, and "uncertain" rather than a guess. Then every passage quoted from the Constitution is compared with the National Archives text and replaced with the exact words if it doesn't match, and every court case is looked up in CourtListener, a free public database of court opinions. Cases that can't be found under the same name are removed, with every sentence that relies on them. Each change is logged.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">4</span>
      <div class="stack-sm">
        <h3>A second AI tool reviews it</h3>
        <p class="small secondary">A separate Claude call reads the analysis against the bill text and answers five questions. Is the summary accurate and complete for what the bill does? Is any side's argument noticeably weaker or less charitable than the other's? Is opinion stated as fact, or is there loaded or partisan language? Are the chosen provisions relevant, with nothing obviously missing? Does anything claim more certainty than the sources support? If all five are fine, the analysis is published, labeled <strong>"AI-drafted, auto-checked"</strong>. If any isn't, it stays off the public page and goes to a person with the reviewer's reasons.</p>
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
        <p class="small secondary">A random 10% of the analyses the AI reviewer passes also go to a person as spot checks. The review page keeps a running count of how often the person agrees with the AI reviewer, so we can see whether it can be trusted. A person can edit any part, approve, reject, or ask for a new draft. Analyses a person approves show "Reviewed by" with their name and the date. Earlier versions and every edit are kept.</p>
      </div>
    </li>
  </ol>
</section>

<section class="card stack" id="agenda-watch">
  <h2>Meetings and agenda watch</h2>
  <p>Meeting times, places, agendas, staff reports, minutes and video links come from Calaveras County's official meeting portal, for the Board of Supervisors and the Planning Commission. State committee hearings come from Open States and show when one of our two state legislators sits on the committee.</p>
  <ul class="plain-list small">
    <li><strong>How to weigh in:</strong> the comment instructions and deadline are copied word for word from the official agenda. When a short deadline is shown (for example "Written comments by Mon, Oct 12, 4:00 pm"), it is worked out only from the agenda's own plain wording, such as "no later than 4:00 pm on the day before the meeting".</li>
    <li><strong>Agenda watch:</strong> an AI tool (Claude, made by Anthropic) writes two or three neutral sentences about each item, from the official agenda only, and flags items about the budget, land use, fees and taxes, public safety, or public access and meetings. These summaries are labeled "AI-drafted from the official agenda" and link to the source. A sentence that states a number, amount or date the agenda item doesn't contain is removed automatically. People review the summaries.</li>
    <li><strong>Links to issues:</strong> the AI tool may suggest that an agenda item relates to an issue. A suggestion is shown only after a person approves it.</li>
    <li><strong>Votes:</strong> how each supervisor voted will be added from the published minutes.</li>
  </ul>
</section>

<section class="card stack-sm">
  <h2>What a full analysis contains</h2>
  <p class="small">A short card has the first four parts, briefly: the summary, the one to three most relevant provisions, one sentence for each panel, and contested readings only when a question is genuinely contested.</p>
  <ul class="plain-list small">
    <li><strong>What the bill does:</strong> a short, plain summary without judgment words.</li>
    <li><strong>Provisions it touches:</strong> each quoted from the Constitution, with one sentence on why.</li>
    <li><strong>Where it aligns</strong> and <strong>where it may be in tension</strong> with that text, written as questions a careful reader could raise, not conclusions.</li>
    <li><strong>Why this might still serve the public:</strong> where a policy departs from the baseline, the case for it, including whether it would need a constitutional amendment under Article V.</li>
    <li><strong>How different approaches read it:</strong> for contested questions only, how a reading based on original meaning, one based on precedent, and one based on evolving interpretation would each see it, side by side.</li>
    <li><strong>Cases cited:</strong> only cases verified in CourtListener, each linked to the opinion.</li>
    <li><strong>What it can't tell you:</strong> the limits of the analysis.</li>
  </ul>
</section>

<section class="card stack-sm">
  <h2>The Constitution's text</h2>
  <p class="small secondary">The Pillory quotes the Constitution and its 27 amendments only from one stored copy of the National Archives transcription, which keeps the original spelling (such as "chuse" and "Controul"). The <a href="/laws/constitution/#full-text">full text</a> is on the Constitution page, and an automatic check compares it with the Archives whenever it changes.</p>
</section>

<section class="card stack-sm">
  <h2>Reports and issues</h2>
  <p class="small">Reporting isn't open yet: it opens when accounts launch. When it does, this section will explain how reports are reviewed, corroborated, and given a confidence level. <a class="inline-link" href="/about/how-it-works/">How it works</a></p>
  <p class="small secondary">How reports are reviewed, corroborated, and given a confidence level.</p>
</section>"""
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
  <p class="small">See how your officials vote, read the constitutional analysis of the bills they vote on, and follow what's on your county's meeting agendas.</p>
  <div>
    <a class="list-row link-row" href="/"><div><div class="list-title">This week's meetings and votes</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
    <a class="list-row link-row" href="/reps/"><div><div class="list-title">Your reps</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
    <a class="list-row link-row" href="/laws/"><div><div class="list-title">Bills and the Constitution</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
  </div>
</section>"""
    render("report", "Report", main, tab="report", root=True)


def build_you():
    about = "".join([
        link_row("/about/", "About The Pillory"),
        link_row("/about/how-it-works/", "How it works"),
        link_row("/about/principles/", "Principles"),
        link_row("/about/methodology/", "Methodology", "How analyses and summaries are made and checked"),
    ])
    main = f"""
<header class="page-head">
  <h1>You</h1>
  <p class="subtitle">Your account, and about The Pillory.</p>
</header>
<section class="card empty-state stack-sm">
  <p>Accounts aren't open yet.</p>
  <p class="small secondary">When they launch, you'll verify once that you're a real resident. Then you can report, corroborate, and follow reps, bills and meetings. Other people will only ever see "Verified resident · Calaveras County", never your name, address or ID.</p>
</section>
{section("About", f'<div>{about}</div>')}"""
    render("you", "You", main, tab="you", root=True)


def build_about():
    links = "".join([
        link_row("/about/how-it-works/", "How it works"),
        link_row("/about/principles/", "Principles"),
        link_row("/about/methodology/", "Methodology", "How analyses and summaries are made and checked"),
    ])
    main = f"""
<header class="page-head">
  <h1>About The Pillory</h1>
  <p class="subtitle">A fact-based civic accountability platform, built for communities that value facts over noise.</p>
</header>
<section class="card stack-sm">
  <h2 class="label">What's here now</h2>
  <ul class="plain-list small stack-sm">
    <li><strong>Your officials and their votes:</strong> the supervisors, state legislators and members of Congress who represent Calaveras County, and every recorded vote, each linked to the official record.</li>
    <li><strong>Bills and the Constitution:</strong> for the bills they vote on, which parts of the Constitution a bill touches, quoted word for word. The Pillory maps the Constitution; it doesn't rule on it.</li>
    <li><strong>County meetings:</strong> Board of Supervisors and Planning Commission agendas, how to comment, and plain-language summaries of each item.</li>
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


PRINCIPLES = [
    ("Evidence first", "Claims without evidence do not amplify. The system is designed to reward documentation, consistency, and verifiability over volume or emotion."),
    ("Protected identities", "Participants are verified for uniqueness and relevance, but identities are protected by default. Safety enables honesty."),
    ("No public pile-ons", "Individual actions remain private. Only aggregated signal becomes public. The goal is accountability, not spectacle."),
    ("Anti-manipulation by design", "One person, one voice. Astroturfing, brigading, and impersonation are structurally constrained rather than moderated after the fact."),
    ("Nonpartisan", "No party labels anywhere, and nothing that suggests a political side. The Pillory maps the Constitution; it doesn't rule on it."),
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
  <p class="subtitle">The starting point for every analysis on The Pillory.</p>
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
    return ("// Generated by tools/build.py. Don't edit by hand.\n"
            "window.PILLORY_INDEX = " + json.dumps(items, ensure_ascii=False, indent=1) + ";\n")


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
    export_for_functions()
    print(f"Built {len(PAGES)} pages and {len(REDIRECTS)} redirects.")


if __name__ == "__main__":
    main()
