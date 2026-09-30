#!/usr/bin/env python3
"""Build The Pillory's app screens from tools/data.py.

    python3 tools/build.py

Writes static HTML into the generated folders listed in GENERATED_DIRS
(each page is <folder>/index.html) plus assets/search-index.js. Those folders
are wiped and rewritten on every run, so never hand-edit them: change
tools/data.py or this file, rebuild, and commit the output.

Hand-written pages (index.html, how-it-works.html, principles.html, join/)
and the shared assets/pillory.css and assets/app.js are not touched.

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
ASSET_VERSION = "15"  # bump when assets/pillory.css or assets/app.js change

# Folders this script owns. reps/ and bodies/ are NOT here: those pages are
# rendered from D1 by Pages Functions (functions/), as are the laws/ index and
# laws/bills/. The static laws/constitution/ and sample-law pages are still built.
GENERATED_DIRS = [
    "about", "agency", "constitution", "evidence", "feed", "issue",
    "issues", "laws", "meetings", "record", "report", "search", "you",
]

e = html.escape

# ---------------------------------------------------------------------------
# Lookups and derived (reverse) links
# ---------------------------------------------------------------------------

LEVEL_NAME = {"county": "County", "state": "State", "federal": "Federal"}

CLAUSES = {c["slug"]: c for c in D.CLAUSES}
BODIES = {b["slug"]: b for b in D.BODIES}
MEETINGS = {m["slug"]: m for m in D.MEETINGS}
LAWS = {l["slug"]: l for l in D.LAWS}
EVIDENCE = {v["slug"]: v for v in D.EVIDENCE}
ISSUES = {i["slug"]: i for i in D.ISSUES}
TABLES = {
    "clause": CLAUSES, "body": BODIES, "meeting": MEETINGS,
    "law": LAWS, "evidence": EVIDENCE, "issue": ISSUES,
}


def check(kind, slug, where):
    if slug not in TABLES[kind]:
        sys.exit(f"build.py: unknown {kind} '{slug}' referenced from {where}")


def validate():
    for b in D.BODIES:
        check("clause", b["clause"][0], b["slug"])
    for m in D.MEETINGS:
        check("body", m["body"], m["slug"])
        for s in m["issues"]:
            check("issue", s, m["slug"])
        for _, link in m["agenda"]:
            if link:
                check(link[0], link[1], m["slug"])
    for l in D.LAWS:
        check("body", l["body"], l["slug"])
        for c, _ in l["clauses"]:
            check("clause", c, l["slug"])
    for v in D.EVIDENCE:
        check(v["parent"][0], v["parent"][1], v["slug"])
    for i in D.ISSUES:
        check("body", i["body"], i["slug"])
        for s in i["laws"]:
            check("law", s, i["slug"])
        for c, _ in i["clauses"]:
            check("clause", c, i["slug"])
        for s in i["evidence"]:
            check("evidence", s, i["slug"])
    for kind, slugs in D.FOLLOWING.items():
        for s in slugs:
            check(kind[:-1] if kind != "bodies" else "body", s, "FOLLOWING")
    for _, _, link in D.NOTIFICATIONS:
        check(link[0], link[1], "NOTIFICATIONS")
    for _, _, link in D.MY_REPORTS:
        if link:
            check(link[0], link[1], "MY_REPORTS")
    # Sample clause pages must quote the stored Constitution exactly.
    stored = [" ".join(p["text"].split()) for p in CONSTITUTION if p["leaf"]]
    for c in D.CLAUSES:
        for para in c["text"]:
            if not any(" ".join(para.split()) in t for t in stored):
                sys.exit(f"build.py: clause {c['slug']} doesn't match data/constitution.json: {para[:80]}…")


def where(items, pred):
    return [x for x in items if pred(x)]


def issues_for_law(s):
    return where(D.ISSUES, lambda i: s in i["laws"])


def issues_for_clause(s):
    return where(D.ISSUES, lambda i: any(c == s for c, _ in i["clauses"]))


def issues_for_body(s):
    return where(D.ISSUES, lambda i: i["body"] == s)


def issues_for_meeting(s):
    return [ISSUES[x] for x in MEETINGS[s]["issues"]]


def meetings_for_issue(s):
    return where(D.MEETINGS, lambda m: s in m["issues"])


def laws_for_clause(s):
    return where(D.LAWS, lambda l: any(c == s for c, _ in l["clauses"]))


def evidence_used_in(s):
    return [("issue", i) for i in D.ISSUES if s in i["evidence"]]


# ---------------------------------------------------------------------------
# URLs and names
# ---------------------------------------------------------------------------

def url(kind, slug):
    return {
        "issue": "/issues/{}/",
        "body": "/bodies/{}/",
        "law": "/laws/{}/",
        "clause": "/laws/constitution/{}/",
        "meeting": "/meetings/{}/",
        "evidence": "/evidence/{}/",
        "record": "/record/{}/",
    }[kind].format(slug)


def name(kind, slug):
    x = TABLES[kind][slug]
    return {
        "issue": lambda: x["short"],
        "body": lambda: x["short"],
        "law": lambda: x["title"],
        "clause": lambda: x["title"],
        "meeting": lambda: x["title"],
        "evidence": lambda: x["title"],
    }[kind]()


def responsible(issue):
    """(display text, url) for who is responsible for a sample issue.

    Sample issues never link to real officials; they point at the governing body.
    """
    b = BODIES[issue["body"]]
    return issue["responsible"] or b["name"], url("body", b["slug"])


def clause_chip(ref, link=False):
    slug, aspect = ref
    text = f"{CLAUSES[slug]['short']} · {aspect}"
    if link:
        return f'<a class="chip chip--parch" href="{url("clause", slug)}">{e(text)}</a>'
    return f'<span class="chip chip--parch">{e(text)}</span>'


def clause_chips(refs, link=False):
    if not refs:
        return '<span class="chip chip--parch">Clause not yet mapped</span>'
    return "".join(clause_chip(r, link) for r in refs)


STATUS_CLASS = {"Kept": "status--kept", "Broken": "status--broken"}


def status_chip(status):
    return f'<span class="status {STATUS_CLASS.get(status, "status--gray")}">{e(status)}</span>'


VERIFIED = {"Official source", "Timestamp checked", "Location checked", "Link verified"}


def verification_chip(v):
    cls = "chip--navy" if v in VERIFIED else "chip--gray"
    return f'<span class="chip {cls}">{e(v)}</span>'


def plural(n, word, many=None):
    return f"{n} {word if n == 1 else (many or word + 's')}"


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

EXAMPLE_TAG = '<span class="example-tag">Example</span>'


def card(href, label, title, who, chips, foot_left, foot_right, level=None, h="h3", example=False):
    lvl = f' data-level="{level}"' if level else ""
    top = (f'<div class="card-top"><p class="label">{e(label)}</p>{EXAMPLE_TAG}</div>' if example
           else f'<p class="label">{e(label)}</p>')
    return f"""
<a class="card issue-card" href="{href}"{lvl}>
  {top}
  <{h}>{e(title)}</{h}>
  <p class="secondary small">{e(who)}</p>
  <div class="chips">{chips}</div>
  <div class="issue-foot"><span>{foot_left}</span><span>{foot_right}</span></div>
</a>"""


def issue_card(i, h="h3"):
    return card(
        url("issue", i["slug"]),
        f"{LEVEL_NAME[i['level']]} · {i['category']}",
        i["title"],
        responsible(i)[0],
        clause_chips(i["clauses"]),
        f"Status: <strong>{e(i['status'])}</strong>",
        f"Confidence: <strong>{e(i['confidence'])}</strong>",
        level=i["level"], h=h, example=True,
    )


def law_card(l, h="h3"):
    n = len(issues_for_law(l["slug"]))
    return card(
        url("law", l["slug"]),
        f"{LEVEL_NAME[l['level']]} · {l['kind']}",
        l["title"],
        BODIES[l["body"]]["name"],
        clause_chips(l["clauses"]),
        f"Status: <strong>{e(l['status'])}</strong>",
        f"Issues: <strong>{n}</strong>",
        level=l["level"], h=h,
    )


def body_card(b, h="h3"):
    return card(
        url("body", b["slug"]),
        f"{LEVEL_NAME[b['level']]} · Governing body",
        b["name"],
        b["about"],
        clause_chip(b["clause"]),
        f"Meetings: <strong>{len(where(D.MEETINGS, lambda m: m['body'] == b['slug']))}</strong>",
        f"Issues: <strong>{len(issues_for_body(b['slug']))}</strong>",
        level=b["level"], h=h,
    )


def meeting_card(m):
    b = BODIES[m["body"]]
    return f"""
<a class="card meeting-card" href="{url('meeting', m['slug'])}" data-level="{b['level']}">
  <p class="label">{LEVEL_NAME[b['level']]} · Meeting</p>
  <h3>{e(m['title'])}</h3>
  <p class="meeting-date">{e(m['date'])}</p>
  <p class="xsmall secondary">Comment by {e(m['comment_deadline'])}</p>
</a>"""


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


def cards_section(label, cards_html, empty):
    inner = cards_html if cards_html else f'<p class="secondary small">{e(empty)}</p>'
    return f"""
<section class="stack">
  <h2 class="label">{e(label)}</h2>
  {inner}
</section>"""


def timeline(entries):
    items = "".join(f"<li>{e(d)} · {e(t)}</li>" for d, t in entries)
    return f'<ol class="timeline small">{items}</ol>'


def kv(rows):
    out = "".join(f'<div class="kv-row"><dt>{e(k)}</dt><dd>{v}</dd></div>' for k, v in rows)
    return f'<dl class="kv">{out}</dl>'


def baseline(clause_refs, b):
    """The parchment constitutional baseline block (issue and law pages)."""
    if not clause_refs or not b:
        return """
<section class="parchment stack">
  <h2 class="label">Constitutional baseline</h2>
  <p>Not yet mapped. Reviewers will suggest the parts of the Constitution this touches.</p>
  <button class="btn btn--block" type="button">Suggest a clause</button>
</section>"""
    c = CLAUSES[clause_refs[0][0]]
    return f"""
<section class="parchment stack">
  <h2 class="label">Constitutional baseline</h2>
  <h3>{e(c['title'])}</h3>
  <blockquote class="quote bare">“{e(c['excerpt'])}”</blockquote>
  <p class="small">{e(c['note'])}</p>
  <a class="inline-link" href="{url('clause', c['slug'])}">Read the full text of {e(c['title'])} →</a>

  <div class="perspective perspective--aligns">
    <h3>Where it aligns</h3>
    <p class="small">{e(b['aligns'])}</p>
    <p class="source">{e(b['aligns_source'])}</p>
  </div>
  <div class="perspective perspective--tension">
    <h3>Where it may be in tension</h3>
    <p class="small">{e(b['tension'])}</p>
    <p class="source">{e(b['tension_source'])}</p>
  </div>
  <div class="perspective perspective--neutral">
    <h3>Why this might still serve the public</h3>
    <p class="small">{e(b['serves'])}</p>
    <p class="source">{e(b['serves_source'])}</p>
  </div>

  <p class="small center">The Pillory maps the Constitution. It doesn't rule on it.</p>
  <button class="btn btn--block" type="button">Add a perspective</button>
</section>"""


def page_head(label, title, sub_html="", chips_html=""):
    sub = f'<div class="secondary">{sub_html}</div>' if sub_html else ""
    chips = f'<div class="chips">{chips_html}</div>' if chips_html else ""
    return f"""
<header class="page-head">
  <p class="label">{e(label)}</p>
  <h1>{e(title)}</h1>
  {sub}
  {chips}
</header>"""


# ---------------------------------------------------------------------------
# Page shell
# ---------------------------------------------------------------------------

TABS = [
    ("home", "Home", "/home/"),
    ("reps", "Reps", "/reps/"),
    ("report", "+ Report", "/report/"),
    ("laws", "Laws", "/laws/"),
    ("you", "You", "/you/"),
]

SEARCH = """
<form class="search" action="/search/" role="search" autocomplete="off">
  <label class="visually-hidden" for="q">Search reps, bodies, laws, issues, the Constitution, and meetings</label>
  <input class="input search-input" id="q" name="q" type="search"
    placeholder="Search reps, laws, issues, meetings" aria-controls="search-results" aria-expanded="false" />
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
    PAGES[path] = doc.replace(marker, "    <!-- Generated by tools/build.py from tools/data.py. Edit those and rebuild; "
                                      "don't edit this file by hand. -->\n" + marker, 1)


def redirect(path, to):
    PAGES[path] = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content="0; url={to}" />
    <link rel="canonical" href="{to}" />
    <title>Moved – The Pillory</title>
  </head>
  <body>
    <!-- Generated by tools/build.py. -->
    <p>This page moved to <a href="{to}">{to}</a>.</p>
  </body>
</html>
"""


def placeholder(path, title, desc, *, back=None, tab=None, app=True, extra=""):
    main = f"""
<header class="page-head">
  <h1>{e(title)}</h1>
  <p class="subtitle">{e(desc)}</p>
</header>
<p class="banner">Placeholder page, content to come</p>
{extra}"""
    render(path, title, main, tab=tab, back=back, app=app)


# ---------------------------------------------------------------------------
# Tab 1: Home (a Pages Function, functions/home/), issues, sample meetings, evidence
# ---------------------------------------------------------------------------

def build_issues_index():
    """/issues/: every issue, with the County / State / Federal filter. Home shows the top three."""
    scope = """
<fieldset class="chips bare">
  <legend class="visually-hidden">Scope</legend>
  <label class="toggle"><input type="radio" name="scope" value="all" checked /><span>All</span></label>
  <label class="toggle"><input type="radio" name="scope" value="county" /><span>County</span></label>
  <label class="toggle"><input type="radio" name="scope" value="state" /><span>State</span></label>
  <label class="toggle"><input type="radio" name="scope" value="federal" /><span>Federal</span></label>
</fieldset>
<p class="banner">Every issue here is an example, until residents can file real reports.</p>"""
    issues = "".join(issue_card(i, h="h2") for i in D.ISSUES)
    main = f"""
<header class="page-head">
  <h1>Issues near you</h1>
  <p class="subtitle">Reported by verified residents, with evidence.</p>
</header>
{scope}
<section class="stack" id="issues">
  <h2 class="visually-hidden">Issues</h2>
  {issues}
</section>"""
    render("issues", "Issues near you", main, tab="home", back=("Home", "/home/"))


SAMPLE_ISSUE_NOTICE = (
    '<p class="banner"><strong>Example issue.</strong> It is hypothetical, shown for layout until residents '
    "can file real reports, and it is not a report about any real official or agency.</p>"
)


def build_issue(i):
    who, who_url = responsible(i)
    status_chips = (EXAMPLE_TAG + f'<span class="chip chip--navy">{e(i["status"])}</span>'
                    f'<span class="chip chip--outline">Confidence: {e(i["confidence"])}</span>')
    head = page_head(
        f"{LEVEL_NAME[i['level']]} · {i['category']}",
        i["title"],
        f'<a class="inline-link" href="{who_url}">{e(who)}</a>',
        status_chips,
    )

    evidence_rows = "".join(
        link_row(url("evidence", s), EVIDENCE[s]["title"], EVIDENCE[s]["source_type"],
                 f'<span class="list-status">{e(EVIDENCE[s]["verification"])}</span>')
        for s in i["evidence"]
    )

    related = []
    related.append(link_row(url("body", i["body"]), BODIES[i["body"]]["name"], "Governing body"))
    for s in i["laws"]:
        related.append(link_row(url("law", s), LAWS[s]["title"], LAWS[s]["kind"]))
    for c, _ in i["clauses"]:
        related.append(link_row(url("clause", c), CLAUSES[c]["title"], "Constitution"))
    for m in meetings_for_issue(i["slug"]):
        related.append(link_row(url("meeting", m["slug"]), m["title"], m["date"]))

    if i["response"]:
        who_resp, text = i["response"]
        response = f'<p class="small secondary">{e(who_resp)}</p><p>{e(text)}</p>'
    else:
        response = '<p class="secondary">No response yet. The agency has been invited to respond through the agency portal.</p>'

    main = f"""{head}
{SAMPLE_ISSUE_NOTICE}
<div class="chips">{clause_chips(i['clauses'], link=True)}</div>

<section class="card stack">
  <h2 class="label">The facts</h2>
  <p>{e(i['facts'])}</p>
  <div class="grid-3">
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Corroborated</div></div>
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Support</div></div>
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Affected</div></div>
  </div>
  <p class="hint center">Verified {'county' if i['level'] == 'county' else 'district'} residents only</p>
</section>

{section("Evidence", f'<div>{evidence_rows}</div>')}
{baseline(i['clauses'], i['baseline'])}
{section("Connected", f'<div>{"".join(related)}</div>')}
{section("Agency response", response, "card stack-sm")}
{section("Record history", timeline(i['history']))}

<a class="btn btn--block" href="{url('record', i['slug'])}">Share as a published record</a>"""

    actions = """
<div class="bottom-bar action-bar" role="group" aria-label="Actions">
  <div class="bottom-bar-inner">
    <button class="btn btn--primary" type="button">Corroborate</button>
    <button class="btn" type="button">Support</button>
    <button class="btn" type="button">I'm affected</button>
  </div>
</div>"""
    render(f"issues/{i['slug']}", i["short"], main, tab="home", back=("Issues near you", "/issues/"), after=actions)

    placeholder(
        f"record/{i['slug']}", "Published record",
        "A read-only, shareable record of this issue for media, officials, and institutions.",
        back=(i["short"], url("issue", i["slug"])), app=False,
        extra=f'<p class="secondary small">Issue: {e(i["title"])}</p>',
    )


def build_meeting(m):
    b = BODIES[m["body"]]
    agenda = []
    for text, link in m["agenda"]:
        if link:
            agenda.append(f'<li><a class="inline-link" href="{url(*link)}">{e(text)}</a></li>')
        else:
            agenda.append(f"<li>{e(text)}</li>")
    issues = "".join(issue_card(i) for i in issues_for_meeting(m["slug"]))
    main = f"""{page_head(f"{LEVEL_NAME[b['level']]} · Meeting", m['title'],
                        f'<a class="inline-link" href="{url("body", b["slug"])}">{e(b["name"])}</a>')}
<section class="card stack-sm">
  {kv([("Date", e(m['date'])), ("Location", e(m['location']))])}
</section>
<section class="panel-navy stack-sm">
  <h2 class="label">Public comment deadline</h2>
  <p><strong>{e(m['comment_deadline'])}</strong></p>
  <p class="small secondary">In-person comment may also be taken at the meeting.</p>
</section>
{section("Agenda", f'<ol class="agenda">{"".join(agenda)}</ol>')}
{cards_section("Related issues", issues, "No related issues yet.")}"""
    render(f"meetings/{m['slug']}", m["title"], main, tab="home", back=("Meetings", "/meetings/"))


def build_evidence(v):
    kind, slug = v["parent"]
    used = "".join(
        link_row(url(k, x["slug"]), name(k, x["slug"]), "Issue")
        for k, x in evidence_used_in(v["slug"])
    )
    checked = {
        "Official source": "Retrieved directly from the official publisher and matched to its public listing.",
        "Timestamp checked": "Timestamps matched against the official meeting record.",
        "Location checked": "Photo location matched to the reported place.",
        "Link verified": "Link resolves and the archived copy matches the original.",
        "Under review": "Reviewers are still checking this item. It does not count toward confidence yet.",
    }.get(v["verification"], "")
    main = f"""{page_head("Evidence", v['title'], "", verification_chip(v['verification']))}
<div class="evidence-preview">{e(v['preview'])}</div>
<section class="card stack-sm">
  {kv([("Source type", e(v['source_type'])),
       ("Verification", e(v['verification'])),
       ("Submitted", "[date]"),
       ("From", e(v['submitted_by']))])}
</section>
{section("How it was checked", f'<p class="small">{e(checked)}</p>', "card stack-sm")}
{section("Used in", f'<div>{used}</div>')}"""
    render(f"evidence/{v['slug']}", v["title"], main, tab="home",
           back=(name(kind, slug), url(kind, slug)))


# ---------------------------------------------------------------------------
# Tab 2 (Reps, bodies) and the Laws index are rendered from D1 by Pages
# Functions; see functions/ and export_for_functions() below.
# Tab 4: sample laws and the Constitution
# ---------------------------------------------------------------------------

def build_law(l):
    s = l["slug"]
    b = BODIES[l["body"]]
    issues = "".join(issue_card(i) for i in issues_for_law(s))
    main = f"""{page_head(f"{LEVEL_NAME[l['level']]} · {l['kind']} · Sample", l['title'],
                        f'<a class="inline-link" href="{url("body", b["slug"])}">{e(b["name"])}</a>',
                        f'<span class="chip chip--navy">{e(l["status"])}</span>' + clause_chips(l['clauses'], link=True))}
<p class="banner">Hypothetical sample law, for layout only. Real bills and votes are listed under <a href="/laws/">Laws</a>.</p>
{section("Plain-language summary", f'<p>{e(l["summary"])}</p>', "card stack-sm")}
{baseline(l['clauses'], l['baseline'])}
{section("How your reps voted", '<p class="secondary small">No recorded votes: this is a sample law. Real voting records appear on real bills under Laws.</p>', "card stack-sm")}
<section class="card stack">
  <h2 class="label">Verified district signal</h2>
  <div class="grid-3">
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Support</div></div>
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Oppose</div></div>
    <div class="stat"><div class="stat-num">[#]</div><div class="stat-label">Affected</div></div>
  </div>
  <p class="hint center">Verified residents of your districts only. Individual responses stay private.</p>
</section>
{cards_section("Related issues", issues, "No related issues yet.")}"""
    render(f"laws/{s}", l["title"], main, tab="laws", back=("Laws", "/laws/"))


def build_constitution():
    browse = []
    for g, title, sub in D.CLAUSE_GROUPS:
        rows = "".join(
            link_row(url("clause", c["slug"]), c["title"], c["subtitle"],
                     f'<span class="list-meta">{plural(len(issues_for_clause(c["slug"])), "issue")}</span>')
            for c in D.CLAUSES if c["group"] == g
        )
        browse.append(f"""
<section class="card stack">
  <div><h2 class="label">{e(title)}</h2><p class="list-meta">{e(sub)}</p></div>
  <div>{rows}</div>
</section>""")
    main = f"""
<header class="page-head">
  <h1>The Constitution</h1>
  <p class="subtitle">The starting point for every issue.</p>
</header>

<section class="parchment stack-sm">
  <h2 class="label">Preamble</h2>
  <p class="quote">
    We the People of the United States, in Order to form a more perfect Union, establish
    Justice, insure domestic Tranquility, provide for the common defence, promote the
    general Welfare, and secure the Blessings of Liberty to ourselves and our Posterity,
    do ordain and establish this Constitution for the United States of America.
  </p>
</section>

{"".join(browse)}

{full_constitution()}

<section class="card stack">
  <h2 class="label">How the baseline works</h2>
  <ol class="numbered">
    <li>
      <span class="step-num" aria-hidden="true">1</span>
      <div class="stack-sm">
        <h3>Every issue links to the text</h3>
        <p class="small secondary">Each report is tied to the clauses it touches, quoted in full.</p>
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
        <p class="small secondary">
          Why a different path might serve the public, including the case for amendment
          under Article V.
        </p>
      </div>
    </li>
  </ol>
</section>"""
    render("laws/constitution", "The Constitution", main, tab="laws", back=("Laws", "/laws/"))


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


def build_clause(c):
    group = next(t for g, t, _ in D.CLAUSE_GROUPS if g == c["group"])
    text = "".join(f'<p class="constitution-text">{e(p)}</p>' for p in c["text"])
    issues = "".join(issue_card(i) for i in issues_for_clause(c["slug"]))
    laws = "".join(law_card(l) for l in laws_for_clause(c["slug"]))
    main = f"""{page_head(group, c['title'], e(c['subtitle']))}
<section class="parchment stack">
  <h2 class="label">Full text</h2>
  {text}
  <p class="small">{e(c['note'])}</p>
</section>
{cards_section("Related issues", issues, "No sample issues cite this section yet.")}
{cards_section("Related laws", laws, "No sample laws cite this section yet.")}"""
    render(f"laws/constitution/{c['slug']}", c["title"], main, tab="laws",
           back=("The Constitution", "/laws/constitution/"))


# ---------------------------------------------------------------------------
# Tab 3: + Report flow (placeholders)
# ---------------------------------------------------------------------------

REPORT_STEPS = [
    ("", "Details", "Say what happened, who is responsible, and when. Facts only, in your own words."),
    ("evidence", "Evidence", "Attach documents, photos, video, links, or public records that support the facts."),
    ("perspective", "Perspective", "Optional: why it matters to you. Shown separately from the facts."),
    ("constitution", "Constitution", "Pick the parts of the Constitution this touches, or let reviewers suggest."),
    ("review", "Review", "Check everything before it goes to review. Your name is never attached."),
    ("submitted", "Submitted", "Your report is in review. Reviewed reports join an issue."),
]


def build_report():
    n = len(REPORT_STEPS)
    for idx, (slug, title, desc) in enumerate(REPORT_STEPS):
        path = "report/" + slug if slug else "report"
        steps = "".join(
            f'<li class="{"is-done" if j < idx else "is-current" if j == idx else ""}">{e(t)}</li>'
            for j, (_, t, _) in enumerate(REPORT_STEPS)
        )
        if idx < n - 1:
            nxt_slug, nxt_title, _ = REPORT_STEPS[idx + 1]
            label = "Submit for review" if nxt_slug == "submitted" else f"Next: {nxt_title}"
            action = f'<a class="btn btn--primary btn--block" href="/report/{nxt_slug}/">{e(label)}</a>'
        else:
            action = '<a class="btn btn--primary btn--block" href="/home/">Back to Home</a>'
        if idx == 0:
            back = None
        elif slug == "submitted":
            back = ("Home", "/home/")
        else:
            prev_slug, prev_title, _ = REPORT_STEPS[idx - 1]
            back = (prev_title, f"/report/{prev_slug}/" if prev_slug else "/report/")
        main = f"""
<header class="page-head">
  <p class="label">New report · Step {idx + 1} of {n}</p>
  <h1>{e(title)}</h1>
  <p class="subtitle">{e(desc)}</p>
</header>
<ol class="progress" aria-label="Report steps">{steps}</ol>
<p class="banner">Placeholder page, form to come</p>
{action}"""
        render(path, f"New report: {title}", main, tab="report", root=idx == 0, back=back)


# ---------------------------------------------------------------------------
# Tab 5: You, plus About and other placeholders
# ---------------------------------------------------------------------------

def build_you():
    following = []
    for kind, slugs in D.FOLLOWING.items():
        k = {"reps": "rep", "bodies": "body", "issues": "issue", "laws": "law"}[kind]
        meta = {"rep": "Rep", "body": "Body", "issue": "Issue", "law": "Law"}[k]
        following += [link_row(url(k, s), name(k, s), meta) for s in slugs]
    notes = "".join(link_row(url(k, s), text, f"{d} · {name(k, s)}") for d, text, (k, s) in D.NOTIFICATIONS)
    reports = "".join(
        link_row(url(*link), title, status) if link else
        f'<div class="list-row"><div><div class="list-title">{e(title)}</div><div class="list-meta">{e(status)}</div></div></div>'
        for title, status, link in D.MY_REPORTS
    )
    districts = "".join([
        link_row("/reps/", "County", "Calaveras · Board of Supervisors"),
        link_row("/reps/", "State Assembly", "[District]"),
        link_row("/reps/", "State Senate", "[District]"),
        link_row("/reps/", "U.S. House", "[District]"),
        link_row("/reps/", "U.S. Senate", "California"),
    ])
    about = "".join([
        link_row("/about/", "About The Pillory"),
        link_row("/how-it-works.html", "How it works"),
        link_row("/principles.html", "Principles"),
        link_row("/about/methodology/", "Methodology"),
        link_row("/about/funding/", "Funding"),
        link_row("/about/advisory-group/", "Advisory group"),
    ])
    main = f"""
<header class="page-head">
  <h1>You</h1>
  <p class="subtitle">What you follow, what you've reported, and what we hold about you.</p>
</header>
<section class="panel-navy stack-sm">
  <span class="badge">Verified resident · Calaveras County</span>
  <p class="small secondary">This is all anyone else sees. Never your name, address, or ID.</p>
</section>

{section("Following & notifications", f'<div>{notes}</div><h3 class="label">Following</h3><div>{"".join(following)}</div>')}
{section("My reports", f'<div>{reports}</div><a class="btn btn--primary" href="/report/">+ New report</a>')}
<section class="card stack">
  <h2 class="label">Civic jury</h2>
  <p>You have <strong>[#] invitations</strong> to review reports from other verified residents before they join an issue.</p>
  <a class="btn" href="/you/jury/">Review a report</a>
</section>
{section("Verification & districts", f'<p class="small secondary">Verified [date]. Your address was only used to match these districts.</p><div>{districts}</div><a class="btn" href="/join/">Update address</a>')}
<section class="card stack">
  <h2 class="label">Privacy</h2>
  <p class="small">See what we hold about you, download a copy, or delete your account.</p>
  <a class="btn" href="/you/privacy/">Open privacy dashboard</a>
</section>
{section("About", f'<div>{about}</div>')}"""
    render("you", "You", main, tab="you", root=True)

    placeholder("you/jury", "Civic jury review",
                "Review a report as a randomly invited, verified resident before it joins an issue.",
                back=("You", "/you/"), tab="you")
    placeholder("you/privacy", "Privacy dashboard",
                "What we hold about you, with options to download it or delete it.",
                back=("You", "/you/"), tab="you")

    about_links = "".join([
        link_row("/about/methodology/", "Methodology"),
        link_row("/about/funding/", "Funding"),
        link_row("/about/advisory-group/", "Advisory group"),
        link_row("/how-it-works.html", "How it works"),
        link_row("/principles.html", "Principles"),
        link_row("/agency/", "For agencies and offices", "Agency portal"),
    ])
    placeholder("about", "About The Pillory",
                "Evidence-first, nonpartisan civic accountability, built by and for verified residents.",
                back=("You", "/you/"), tab="you",
                extra=f'<section class="card"><div>{about_links}</div></section>')
    build_methodology()
    placeholder("about/funding", "Funding",
                "Who funds The Pillory, and the rules that keep funders out of editorial decisions.",
                back=("About", "/about/"), tab="you")
    placeholder("about/advisory-group", "Advisory group",
                "The people who advise on methodology and fairness, and how they are chosen.",
                back=("About", "/about/"), tab="you")
    placeholder("agency", "Agency portal",
                "Private link for agencies and offices: verify your office, view an issue, and post an unedited response.",
                app=False)


def build_methodology():
    main = """
<header class="page-head">
  <h1>Methodology</h1>
  <p class="subtitle">How The Pillory maps laws and issues to the Constitution, and how reports are reviewed.</p>
</header>

<section class="card stack" id="analysis">
  <h2>Constitutional analysis of bills</h2>
  <p>The Pillory maps the Constitution; it doesn't rule on it. For bills that our officials have voted on, an AI tool writes a first draft showing which parts of the Constitution a bill touches. People review every draft. Nothing here is a verdict on whether a bill is constitutional, and nothing here is legal advice.</p>
  <ol class="numbered">
    <li>
      <span class="step-num" aria-hidden="true">1</span>
      <div class="stack-sm">
        <h3>Start from the bill's own words</h3>
        <p class="small secondary">We read the latest text on Congress.gov for federal bills, or on the California Legislature's site for state bills. If the text isn't available, we use the official summary and label the analysis "limited: based on summary only." Very long bills are cut at a set length, and the analysis says so.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">2</span>
      <div class="stack-sm">
        <h3>An AI tool writes a draft</h3>
        <p class="small secondary">The draft is written by Claude, an AI model made by Anthropic, from the bill text and the full text of the Constitution. Its instructions: give no verdicts on constitutionality, use no party labels or partisan language, present the strongest version of each view, and say "uncertain" rather than guess.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">3</span>
      <div class="stack-sm">
        <h3>Automatic checks before anything is saved</h3>
        <p class="small secondary">Every passage quoted from the Constitution is compared with the National Archives text. A quote that doesn't match word for word is replaced with the exact text. Every court case is looked up in CourtListener, a free public database of court opinions. Cases that can't be found under the same name are removed, along with every sentence that relies on them. Each change is logged.</p>
      </div>
    </li>
    <li>
      <span class="step-num" aria-hidden="true">4</span>
      <div class="stack-sm">
        <h3>People review it</h3>
        <p class="small secondary">Until a person reviews it, an analysis is marked "AI-drafted, not yet reviewed." A reviewer can edit any part, approve it, reject it, or ask for a new draft. Approved analyses show "Reviewed by" with the reviewer's name and the date. Earlier versions and every edit are kept.</p>
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
  <h2>What each analysis contains</h2>
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
  <p class="banner">Content to come</p>
  <p class="small secondary">How reports are reviewed, corroborated, and given a confidence level.</p>
</section>"""
    render("about/methodology", "Methodology", main, tab="you", back=("About", "/about/"))


def build_search():
    main = """
<header class="page-head">
  <h1>Search</h1>
  <p class="subtitle">Reps, bodies, laws, issues, the Constitution, and meetings.</p>
</header>
<div id="search-page-results" class="stack" aria-live="polite"></div>"""
    render("search", "Search", main)


def tags(refs):
    return " ".join(f"{CLAUSES[c]['short']} {aspect}" for c, aspect in refs)


def search_index():
    items = []
    for b in D.BODIES:
        items.append({"type": "Body", "title": b["name"], "sub": LEVEL_NAME[b["level"]] + " · Governing body",
                      "url": url("body", b["slug"]), "k": b["short"]})
    for l in D.LAWS:
        items.append({"type": l["kind"], "title": l["title"], "sub": f"{BODIES[l['body']]['short']} · {l['status']}",
                      "url": url("law", l["slug"]), "k": "law bill ordinance " + LEVEL_NAME[l["level"]] + " " + tags(l["clauses"])})
    for i in D.ISSUES:
        items.append({"type": "Issue", "title": i["title"], "sub": f"Example · {LEVEL_NAME[i['level']]} · {i['category']}",
                      "url": url("issue", i["slug"]), "k": " ".join([i["short"], responsible(i)[0], tags(i["clauses"])])})
    items.append({"type": "Constitution", "title": "The Constitution", "sub": "Preamble, articles, and amendments",
                  "url": "/laws/constitution/", "k": "preamble"})
    for c in D.CLAUSES:
        items.append({"type": "Constitution", "title": c["title"], "sub": c["subtitle"],
                      "url": url("clause", c["slug"]), "k": c["short"] + " " + " ".join(c["text"])})
    for m in D.MEETINGS:
        items.append({"type": "Meeting", "title": m["title"], "sub": m["date"],
                      "url": url("meeting", m["slug"]), "k": BODIES[m["body"]]["name"]})
    return ("// Generated by tools/build.py from tools/data.py. Don't edit by hand.\n"
            "window.PILLORY_INDEX = " + json.dumps(items, ensure_ascii=False, indent=1) + ";\n")


# ---------------------------------------------------------------------------

HOME_START = "<!-- build:home-issues (filled in by tools/build.py from tools/data.py; edits inside are overwritten) -->"
HOME_END = "<!-- /build:home-issues -->"


def fill_home_preview():
    """Refresh the sample issue cards on the hand-written home page (one per level)."""
    home = ROOT / "index.html"
    s = home.read_text(encoding="utf-8")
    if HOME_START not in s or HOME_END not in s:
        sys.exit("build.py: index.html is missing the build:home-issues markers")
    picks = [next(i for i in D.ISSUES if i["level"] == level) for level in D.LEVELS]
    cards = "".join(issue_card(i) for i in picks)
    indented = "\n".join("          " + line if line else "" for line in cards.strip("\n").splitlines())
    before, rest = s.split(HOME_START, 1)
    _, after = rest.split(HOME_END, 1)
    home.write_text(f"{before}{HOME_START}\n{indented}\n          {HOME_END}{after}", encoding="utf-8")


# ---------------------------------------------------------------------------
# Shared pieces for the Pages Functions (functions/) that render D1 pages
# ---------------------------------------------------------------------------

FUNCTIONS_EXPORT = ROOT / "functions" / "_lib" / "generated.js"


def export_for_functions():
    """Write functions/_lib/generated.js: the page shell and sample-data snippets.

    Pages Functions render the D1-backed pages (Reps, rep profiles, bodies, the
    Laws index, real bills) in JavaScript. Rather than duplicate the templates,
    they import the exact shell and card HTML produced here.
    """
    page = shell("%%TITLE%%", "%%MAIN%%", nav="%%NAV%%", back_html="%%BACK%%", title_is_html=True)
    tabbars = {t: {"root": tabbar(t, True), "sub": tabbar(t, False)} for t, _, _ in TABS}
    bodies = [{
        "slug": b["slug"], "name": b["name"], "short": b["short"], "level": b["level"],
        "about": b["about"], "chip": clause_chip(b["clause"], link=True),
        "chip_span": clause_chip(b["clause"]), "card": body_card(b),
    } for b in D.BODIES]
    meetings_by_body = {b["slug"]: [link_row(url("meeting", m["slug"]), m["title"], m["date"])
                                    for m in D.MEETINGS if m["body"] == b["slug"]] for b in D.BODIES}
    laws_by_body = {b["slug"]: [link_row(url("law", l["slug"]), l["title"], f"Sample {l['kind'].lower()} · {l['status']}")
                                for l in D.LAWS if l["body"] == b["slug"]] for b in D.BODIES}
    issues_by_body = {b["slug"]: [i["slug"] for i in issues_for_body(b["slug"])] for b in D.BODIES}
    data = {
        "ASSET_VERSION": ASSET_VERSION,
        "PAGE": page,
        "TABBARS": tabbars,
        "LEVEL_NAME": LEVEL_NAME,
        "BODIES": bodies,
        "MEETINGS_BY_BODY": meetings_by_body,
        "LAWS_BY_BODY": laws_by_body,
        "ISSUES_BY_BODY": issues_by_body,
        "ISSUE_CARDS": {i["slug"]: issue_card(i) for i in D.ISSUES},
        "ISSUES": {i["slug"]: {"title": i["title"], "short": i["short"], "url": url("issue", i["slug"]),
                               "level": i["level"], "body": i["body"], "category": i["category"],
                               "facts": i["facts"]} for i in D.ISSUES},
        "SAMPLE_LAW_CARDS": [law_card(l) for l in D.LAWS],
    }
    out = ["// Generated by tools/build.py. Don't edit by hand; change tools/build.py or tools/data.py and rebuild.",
           "// Shared page shell and sample-data snippets for the Pages Functions."]
    for k, v in data.items():
        out.append(f"export const {k} = {json.dumps(v, ensure_ascii=False, indent=1)};")
    FUNCTIONS_EXPORT.parent.mkdir(parents=True, exist_ok=True)
    FUNCTIONS_EXPORT.write_text("\n".join(out) + "\n", encoding="utf-8")


def main():
    validate()
    build_issues_index()
    for i in D.ISSUES:
        build_issue(i)
    for m in D.MEETINGS:
        build_meeting(m)
    for v in D.EVIDENCE:
        build_evidence(v)
    for l in D.LAWS:
        build_law(l)
    build_constitution()
    for c in D.CLAUSES:
        build_clause(c)
    build_report()
    build_you()
    build_search()
    # Old URLs from the first round of screens.
    redirect("constitution", "/laws/constitution/")
    redirect("feed", "/home/")  # the Feed tab became Home
    redirect("issue", url("issue", "public-comment-limit"))

    for d in GENERATED_DIRS:
        shutil.rmtree(ROOT / d, ignore_errors=True)
    for path, doc in PAGES.items():
        if path.split("/")[0] not in GENERATED_DIRS:
            sys.exit(f"build.py: {path} is outside GENERATED_DIRS")
        out = ROOT / path / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(doc, encoding="utf-8")
    (ROOT / "assets" / "search-index.js").write_text(search_index(), encoding="utf-8")
    fill_home_preview()
    export_for_functions()
    print(f"Built {len(PAGES)} pages.")


if __name__ == "__main__":
    main()
