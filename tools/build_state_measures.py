#!/usr/bin/env python3
"""Statewide ballot measures for the November 3, 2026 general election in
Colorado, Arizona, Florida and Michigan, from each state's official documents,
word for word. Each state's file is data/elections/2026-11-03-<st>.json, in the
"sections" format the measure page shows the same way for every state
(functions/elections/[[path]].js): each measure's ballot question, what a Yes
and a No vote mean where the state publishes that, and the official analysis,
arguments and fiscal impact as sections, each with who wrote it.

  Colorado   the Blue Book (State Ballot Information Booklet), written by the
             nonpartisan Legislative Council Staff: ballot title, what your vote
             means, summary and analysis, arguments for and against (written by
             the staff to represent both sides), fiscal impact
  Arizona    the Secretary of State's official ballot language: descriptive
             title and what a Yes and a No vote would do; the Legislative
             Council's analysis, the arguments filed for and against, and the
             Publicity Pamphlet are linked
  Florida    the Division of Elections' booklet of proposed constitutional
             amendments: ballot title and ballot summary (the amendment text's
             font doesn't survive extraction, so it's linked)
  Michigan   the ballot wording as quoted in the Senate Fiscal Agency's
             overview of each proposal; the overviews are linked

Every paragraph is checked word for word against the text it came from; a
state whose document doesn't read as expected is not written (the others still
are) and the run fails at the end. Needs pdftotext (poppler-utils). See
docs/elections.md.

    python3 tools/build_state_measures.py            # every state
    python3 tools/build_state_measures.py --state CO
"""
import argparse
import html
import http.cookiejar
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "elections"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
DATE = "2026-11-03"
LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"}
# Characters that mean a font's text was lost on extraction (Florida's amendment text).
GARBLED = re.compile(r"[Ā-ɏͰ-Ͽ⁰-₟�]")


# ---------------------------------------------------------------------------
# Fetching and text

def fetch(url):
    """The document's bytes. Some state sites refuse a program that names itself; then a browser's user agent."""
    last = None
    for ua in (UA, BROWSER):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "text/html,application/pdf,*/*", "Accept-Language": "en-US,en;q=0.9"})
            with OPENER.open(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 (tried again with the other user agent, then raised)
            last = e
    raise last


def pdf_text(url, *, layout=False, first=0, last=0):
    with tempfile.TemporaryDirectory() as tmp:
        pdf = Path(tmp) / "doc.pdf"
        pdf.write_bytes(fetch(url))
        pages = ["-f", str(first), "-l", str(last)] if first else []
        text = subprocess.run(["pdftotext", *(["-layout"] if layout else []), *pages, str(pdf), "-"], check=True, capture_output=True, text=True).stdout
    for a, b in LIGATURES.items():
        text = text.replace(a, b)
    return text.replace("­", "")


def page_text(url):
    page = fetch(url).decode("utf-8", "replace")
    return page


def join_lines(lines):
    """Lines of one paragraph as one string; a word broken with a hyphen at a line's end keeps its hyphen."""
    out = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if not out:
            out = line
        elif out.endswith("-") and not out.endswith(" -"):
            out += line
        else:
            out += " " + line
    return out


def flat(text):
    return re.sub(r"\s+", " ", re.sub(r"(?<!\s)-\s*\n\s*", "-", text)).strip()


class Unreadable(Exception):
    """A document didn't read as expected: that state's file isn't written."""


def check(where, source, quotes):
    """Every paragraph must be in its source word for word, with no lost characters."""
    src = flat(source)
    for q in quotes:
        text = q if isinstance(q, str) else q.get("h", "")
        if GARBLED.search(text):
            raise Unreadable(f"{where}: lost characters in {text[:80]!r}")
        if flat(text) not in src:
            raise Unreadable(f"{where}: not word for word in its source: {text[:100]!r}")


def section(sid, heading, by, paragraphs, note=""):
    return {"id": sid, "heading": heading, "by": by, "paragraphs": paragraphs, **({"note": note} if note else {})}


def election(st, name, polls_close_utc, office, sources, guide=None):
    return {
        "id": f"{DATE}-{st.lower()}",
        "name": "November 3, 2026, General Election",
        "date": DATE,
        "polls_close_utc": polls_close_utc,
        "state": st,
        "state_name": name,
        "format": "sections",
        "guide": guide or office["url"],
        "results_page": office["url"],
        "results_by": f"{name} election office",
        "sources": sources,
    }


def offices():
    return json.loads((ROOT / "data" / "states" / "election-offices.json").read_text())["offices"]


def how_to_vote(name, office, guide=None):
    out = [
        {"label": f"{name}'s official election information: registering, where and how to vote, and results", "url": office["url"], "by": f"{name} election office (listed by USA.gov)"},
        {"label": "Register to vote or check your registration", "url": "https://vote.gov/", "by": "Vote.gov, U.S. Election Assistance Commission"},
    ]
    if guide:
        out.append(guide)
    return {"state": out}


def doc(st, elec, measures, readme):
    return {
        "_readme": f"Generated by tools/build_state_measures.py from {readme}. Do not edit by hand.",
        "election": elec,
        "how_to_vote": how_to_vote(elec["state_name"], {"url": elec["results_page"]}, elec.get("_guide_link")),
        "counties": {},
        "contests": [],
        "measures": measures,
    }


# ---------------------------------------------------------------------------
# Colorado: the Blue Book

CO_BOOK = "https://content.leg.colorado.gov/sites/default/files/2026-bluebook-english-accessible_1.pdf"
CO_BOOK_PAGE = "https://leg.colorado.gov/bluebook"
CO_CONTACTS = "https://www.coloradosos.gov/pubs/elections/Initiatives/ballot/contacts/2026.html"
CO_LABEL = re.compile(r"^((?:Amendment|Proposition) (?:\d{1,3}|[A-Z]{2})):\s*(.*)$")
CO_LCS = "Legislative Council Staff, Colorado General Assembly"


def co_blocks(lines, noise):
    """Paragraphs from reading-order lines: blocks split on blank lines, page furniture dropped, a
    paragraph broken by a page joined back up, and a question or short line opening a block kept as a
    subheading ({"h": ...})."""
    blocks, cur, broke = [], [], False
    for ln in lines + [""]:
        s = ln.strip()
        if s and noise(s):
            if re.fullmatch(r"\d{1,3}", s) and blocks and not cur:
                blocks[-1] = (blocks[-1][0], True)  # a page number after a block: the next block may continue it
            elif re.fullmatch(r"\d{1,3}", s):
                broke = True
            continue
        if not s:
            if cur:
                blocks.append((cur, broke))
                cur, broke = [], False
            continue
        cur.append(s)
    out = []
    pending_break = False
    for b, after_break in blocks:
        joinable = pending_break
        pending_break = after_break
        # A subheading starts a block: a question, or a short line without a full stop followed by text.
        while len(b) > 1 and (b[0].endswith("?") or (len(b[0]) < 70 and not re.search(r"[.;:,”\"]$", b[0]) and not re.match(r"^\d\)", b[0]))):
            out.append({"h": b[0]})
            b = b[1:]
            joinable = False
        text = join_lines(b)
        if len(b) == 1 and (text.endswith("?") or (len(text) < 70 and not re.search(r"[.;:,”\")]$", text))):
            out.append({"h": text})
            continue
        prev = out[-1] if out else None
        # Continued across a page: the previous paragraph didn't end a sentence.
        if joinable and isinstance(prev, str) and not re.search(r"[.:;?!”\")]$", prev) and not re.match(r"^\d\)", text):
            out[-1] = prev + text if prev.endswith("-") and not prev.endswith(" -") else prev + " " + text
            continue
        out.append(text)
    return out


def co_measures():
    text = pdf_text(CO_BOOK)
    lines = text.split("\n")
    stripped = [l.strip() for l in lines]
    # Each measure's analysis: "Summary and Analysis of <label>", its header a few lines above.
    starts = [i for i, s in enumerate(stripped) if re.match(r"^Summary and Analysis of ((?:Amendment|Proposition) \S+)$", s)]
    if len(starts) < 10:
        raise Unreadable(f"Colorado: {len(starts)} measure analyses found; expected 14")
    titles_at = next((i for i, s in enumerate(stripped) if s == "Text & Titles" and i > starts[-1]), None)
    if titles_at is None:
        raise Unreadable("Colorado: the Titles and Text section wasn't found")
    labels = [re.match(r"^Summary and Analysis of (.+)$", stripped[at]).group(1) for at in starts]
    # Each measure's header, "<label>: <title …>", a page or so above its analysis.
    heads = []
    for label, at in zip(labels, starts):
        hs = [i for i in range(max(0, at - 120), at) if stripped[i].startswith(f"{label}:")]
        if not hs:
            raise Unreadable(f"Colorado {label}: its header wasn't found")
        heads.append(hs[-1])
    measures = []
    for k, (label, at, head) in enumerate(zip(labels, starts, heads)):
        placed = next((i for i in range(head, at) if stripped[i].startswith("Placed on the ballot")), None)
        if placed is None:
            raise Unreadable(f"Colorado {label}: \"Placed on the ballot by\" wasn't found")
        title = join_lines([stripped[head][len(label) + 1:], *stripped[head + 1:placed]])
        placed_line = stripped[placed]
        m = re.match(r"^Placed on the ballot by (.+?) • (Passes with .+)$", placed_line)
        if not m:
            raise Unreadable(f"Colorado {label}: unexpected line {placed_line!r}")
        how_placed, requirement = m.group(1), m.group(2)
        try:
            vote_at = next(i for i in range(placed, at) if stripped[i] == "What Your Vote Means")
            yes_at = next(i for i in range(vote_at, at) if stripped[i] == "YES")
            no_at = next(i for i in range(yes_at, at) if stripped[i] == "NO")
        except StopIteration:
            raise Unreadable(f"Colorado {label}: \"What Your Vote Means\" wasn't read")
        end = heads[k + 1] if k + 1 < len(heads) else titles_at

        def find(pattern, lo, hi):
            return next((i for i in range(lo, hi) if re.match(pattern, stripped[i])), None)

        args_for = find(rf"^Arguments? For {re.escape(label)}$", at, end)
        args_against = find(rf"^Arguments? Against {re.escape(label)}$", at, end)
        info = find(r"^Information about the organizations supporting and opposing", at, end)
        fiscal = find(rf"^Fiscal Impact of {re.escape(label)}$", at, end)
        tabor = find(r"^State Spending and Tax Increases$", at, end)
        if None in (args_for, args_against, fiscal):
            raise Unreadable(f"Colorado {label}: its arguments or fiscal impact weren't found")
        number = label.split()[-1]
        short = re.sub(r"\s+", " ", title)

        def noise(s):
            return (re.fullmatch(r"\d{1,3}", s) is not None or s in (number, "Analysis", short, label, "y")
                    or (len(s) > 12 and short.startswith(s)) or s.startswith("Placed on the ballot"))

        proposes = co_blocks(lines[placed + 1:vote_at], noise)
        yes = join_lines(stripped[yes_at + 1:no_at])
        no = join_lines([s for s in stripped[no_at + 1:at] if s and not noise(s)])
        analysis = co_blocks(lines[at + 1:args_for], noise)
        pros = co_blocks(lines[args_for + 1:args_against], noise)
        cons = co_blocks(lines[args_against + 1:(info or fiscal)], noise)
        money = co_blocks(lines[fiscal + 1:(tabor or end)], noise)
        # The ballot title, from the Titles and Text section.
        t0 = next((i for i in range(titles_at, len(stripped)) if stripped[i] == label and any(stripped[j] == "Ballot Title:" for j in range(i, min(i + 14, len(stripped))))), None)
        if t0 is None:
            raise Unreadable(f"Colorado {label}: its ballot title wasn't found")
        bt0 = next(j for j in range(t0, t0 + 14) if stripped[j] == "Ballot Title:")
        bt1 = next(j for j in range(bt0, len(stripped)) if stripped[j].startswith("Text of Measure"))
        ballot_title = join_lines(stripped[bt0 + 1:bt1])
        for what, quotes in (("proposal", proposes), ("analysis", analysis), ("arguments for", pros), ("arguments against", cons), ("fiscal impact", money)):
            check(f"Colorado {label} {what}", text, quotes)
        check(f"Colorado {label} vote meanings", text, [yes, no, ballot_title])
        if not (pros and cons and analysis and money and yes.startswith("A “yes” vote") and no.startswith("A “no” vote")):
            raise Unreadable(f"Colorado {label}: a section came out empty")
        kind = ("Citizen-initiated " if "citizen" in how_placed else "Referred by the legislature: ") + ("constitutional amendment" if label.startswith("Amendment") else "statute")
        measures.append({
            "id": label.lower().replace(" ", "-"),
            "number": number,
            "label": label,
            "kind": kind,
            "scope": "statewide",
            "title": short,
            "requirement": requirement,
            "placed_by": how_placed,
            "question": ballot_title,
            "question_by": "Ballot title set by the Title Board (staff of the Secretary of State, the Attorney General and the General Assembly's legal staff)",
            "yes_means": yes,
            "no_means": no,
            "means_by": CO_LCS,
            "lead": {"text": " ".join(p for p in proposes if isinstance(p, str)), "source": "The Blue Book's summary, written by the Legislative Council Staff."},
            "sections": [
                section("proposes", "What the measure proposes", CO_LCS, proposes),
                section("analysis", "Summary and analysis", CO_LCS, analysis),
                section("fiscal", "Fiscal impact", CO_LCS, money, "The full fiscal impact statement is at leg.colorado.gov/bluebook." if tabor is None else "The full fiscal impact statement, and the TABOR notice for this measure, are in the Blue Book."),
            ],
            "arguments": [
                {"side": "for", "heading": f"Arguments for {label}", "paragraphs": pros},
                {"side": "against", "heading": f"Arguments against {label}", "paragraphs": cons},
            ],
            "arguments_by": "Written by the Legislative Council Staff, which states that careful consideration has been given to the arguments in an effort to fairly represent both sides of each issue.",
            "links": [
                {"url": CO_BOOK, "label": "2026 State Ballot Information Booklet (the Blue Book), English (PDF)"},
                {"url": CO_BOOK_PAGE, "label": "The Blue Book online, with each measure's full fiscal impact statement (Legislative Council)"},
                {"url": CO_CONTACTS, "label": "Organizations supporting and opposing each measure (Secretary of State)"},
            ],
            "source_url": CO_BOOK,
            "source": "2026 State Ballot Information Booklet, Legislative Council of the Colorado General Assembly",
        })
    if len(measures) != 14:
        raise Unreadable(f"Colorado: {len(measures)} measures read; the Blue Book lists 14")
    office = offices()["CO"]
    elec = election("CO", "Colorado", "2026-11-04T02:00:00Z", office,
                    [{"url": CO_BOOK, "label": "2026 State Ballot Information Booklet (Legislative Council)"}, {"url": office["url"], "label": "Colorado Secretary of State, elections"}],
                    guide=CO_BOOK)
    elec["_guide_link"] = {"label": "The 2026 Blue Book (State Ballot Information Booklet)", "url": CO_BOOK, "by": "Legislative Council of the Colorado General Assembly"}
    return doc("CO", elec, measures, "the Colorado Legislative Council's 2026 State Ballot Information Booklet")


# ---------------------------------------------------------------------------
# Arizona: the Secretary of State's official ballot language

AZ_PAGE = "https://azsos.gov/elections/ballot-measures"
AZ_LANGUAGE = "https://azsos.gov/sites/default/files/docs/2026-Ballot-Language-English-2026-0819.pdf"
AZ_PAMPHLET = "https://apps.azsos.gov/election/BallotMeasures/2026/2026-AZ-Publicity-Pamphlet.pdf"
AZ_ANALYSES = "https://www.azleg.gov/ballot-measures-2026-analyses/"
AZ_SOS = "the Arizona Secretary of State"


def az_links(page):
    """{prop: {"for": url, "against": url}} from the Secretary of State's ballot measures page, and the
    Legislative Council's analysis links {bill: url}."""
    args = {}
    for url, prop, side in re.findall(r'href="(https://apps\.azsos\.gov/election/BallotMeasures/2026/Prop-(\d+)-[^"]*?-(For|Against)-Arguments\.pdf)"', page):
        args.setdefault(prop, {})[side.lower()] = url
    return args


def az_analyses(page):
    out = {}
    for href in re.findall(r'href="([^"]*2026BallotMeasures[^"]*analysis[^"]*\.pdf)"', page, re.I):
        url = href.replace("\\", "/").replace("https:/www", "https://www")
        bill = re.sub(r"\s+", "", re.search(r"analysis\s*(.+?)(?:\s*-\s*20\d\d)?(?:rev)?\.pdf$", url, re.I).group(1)).upper()
        out[bill] = re.sub(r" ", "%20", url)
    return out


def az_measures():
    text = pdf_text(AZ_LANGUAGE, layout=True)
    sos = page_text(AZ_PAGE)
    args = az_links(sos)
    analyses = az_analyses(page_text(AZ_ANALYSES))
    blocks = re.split(r"\n(?=\s*PROPOSITION \d{3}\s*\n)", "\n" + text)
    measures = []
    for b in blocks:
        ls = [l.strip() for l in b.split("\n")]
        ls = [l for l in ls if l and not re.fullmatch(r"\d{1,2}", l)]
        if not ls or not re.fullmatch(r"PROPOSITION \d{3}", ls[0]):
            continue
        prop = ls[0].split()[1]
        bill = ls[1]
        try:
            ot = ls.index("OFFICIAL TITLE")
            dt = ls.index("DESCRIPTIVE TITLE")
            yes0 = next(i for i, l in enumerate(ls) if l.startswith("A “yes” vote shall have the effect"))
            no0 = next(i for i, l in enumerate(ls) if l.startswith("A “no” vote shall have the effect"))
        except (ValueError, StopIteration):
            raise Unreadable(f"Arizona Proposition {prop}: the ballot language's parts weren't found")
        heading = join_lines(ls[2:ot])
        official = join_lines(ls[ot + 1:dt])
        descriptive = join_lines(ls[dt + 1:yes0])
        yes = join_lines(ls[yes0:no0])
        no = join_lines(ls[no0:])
        check(f"Arizona Proposition {prop}", text, [heading, official, descriptive, yes, no])
        key = re.sub(r"\s+|\(\d{4}\)", "", bill).upper()
        year = re.search(r"\((\d{4})\)", bill)
        analysis = analyses.get(f"{key}") or analyses.get(f"{key}-{year.group(1)}" if year else key)
        links = [{"url": AZ_PAMPHLET, "label": "2026 General Election Publicity Pamphlet: the analysis, every argument filed, and the ballot format (Secretary of State, PDF)"}]
        if analysis:
            links.append({"url": analysis, "label": f"Analysis by the Arizona Legislative Council, {bill} (PDF)"})
        arg = args.get(prop, {})
        if arg.get("for"):
            links.append({"url": arg["for"], "label": f"Arguments filed for Proposition {prop} (Secretary of State, PDF)"})
        if arg.get("against"):
            links.append({"url": arg["against"], "label": f"Arguments filed against Proposition {prop} (Secretary of State, PDF)"})
        links.append({"url": AZ_LANGUAGE, "label": "2026 official ballot measure language (Secretary of State, PDF)"})
        kind = ("Referred by the legislature: " if "BY THE LEGISLATURE" in heading else "Citizen-initiated: ") + ("constitutional amendment" if "CONSTITUTION" in heading else "statute")
        measures.append({
            "id": f"prop-{prop}",
            "number": prop,
            "label": f"Proposition {prop}",
            "kind": kind,
            "scope": "statewide",
            "title": descriptive.capitalize() if descriptive.isupper() else descriptive,
            "question": descriptive,
            "question_by": "Descriptive title, from the official ballot language published by the Secretary of State",
            "yes_means": yes,
            "no_means": no,
            "means_by": "The official ballot language published by the Secretary of State",
            "lead": {"text": yes, "source": "The official ballot language: what a “yes” vote would do."},
            "sections": [
                section("heading", "As it appears on the ballot", "The official ballot language published by the Secretary of State",
                        [heading, {"h": "Official title"}, official, {"h": "Descriptive title"}, descriptive]),
            ],
            "arguments": [],
            "arguments_by": "",
            "argument_links": [x for x in links if "Arguments filed" in x["label"]],
            "arguments_note": "State law requires the Secretary of State to publish every qualified argument filed for and against each proposition; the opinions are the filers' own, and the Secretary of State takes no position.",
            "links": links,
            "source_url": AZ_LANGUAGE,
            "source": "2026 official ballot measure language, Arizona Secretary of State",
        })
    if len(measures) < 5:
        raise Unreadable(f"Arizona: {len(measures)} propositions read from the ballot language")
    office = offices()["AZ"]
    elec = election("AZ", "Arizona", "2026-11-04T02:00:00Z", office,
                    [{"url": AZ_LANGUAGE, "label": "2026 official ballot measure language (Secretary of State)"}, {"url": AZ_PAMPHLET, "label": "2026 General Election Publicity Pamphlet (Secretary of State)"}, {"url": AZ_PAGE, "label": "Ballot measures (Secretary of State)"}],
                    guide=AZ_PAMPHLET)
    elec["_guide_link"] = {"label": "The 2026 General Election Publicity Pamphlet", "url": AZ_PAMPHLET, "by": "Arizona Secretary of State"}
    return doc("AZ", elec, measures, "the Arizona Secretary of State's 2026 official ballot measure language")


# ---------------------------------------------------------------------------
# Florida: the booklet of proposed constitutional amendments

FL_BOOKLET = "https://files.floridados.gov/media/711369/eng-2026-booklet-constitutional-amendpub-updated-20260903.pdf"
FL_BY = "Ballot title and summary, from the Florida Division of Elections' booklet of proposed constitutional amendments"


def fl_measures():
    text = pdf_text(FL_BOOKLET, layout=True)
    ls = [l.strip() for l in text.split("\n")]
    heads = [i for i, l in enumerate(ls) if re.fullmatch(r"No\. (\d+) Constitutional Amendment", l) and i > 30]
    measures = []
    for k, h in enumerate(heads):
        n = re.match(r"No\. (\d+)", ls[h]).group(1)
        end = heads[k + 1] if k + 1 < len(heads) else len(ls)
        seg = ls[h:end]
        try:
            bt = seg.index("Ballot Title")
            bs = seg.index("Ballot Summary")
            tx = seg.index("Text")
        except ValueError:
            raise Unreadable(f"Florida Amendment {n}: its ballot title or summary wasn't found")
        where = join_lines([l for l in seg[1:bt] if l])
        title = join_lines([l for l in seg[bt + 1:bs] if l])
        summary = join_lines([l for l in seg[bs + 1:tx] if l])
        check(f"Florida Amendment {n}", text, [where, title])
        if GARBLED.search(summary):
            summary = None  # the booklet's font for it doesn't survive extraction: linked, never guessed
        else:
            check(f"Florida Amendment {n}", text, [summary])
        clean = title.rstrip("—- .").rstrip("—").strip()
        measures.append({
            "id": f"amendment-{n}",
            "number": n,
            "label": f"Amendment {n}",
            "kind": "Constitutional amendment",
            "scope": "statewide",
            "title": clean.title() if clean.isupper() else clean,
            "requirement": "Passes with 60 percent of the vote (Florida Constitution, Article XI, Section 5)",
            "question": title,
            "question_by": FL_BY,
            "lead": {"text": summary, "source": "The official ballot summary."} if summary else None,
            "sections": [
                section("summary", "Ballot summary", FL_BY, [summary]) if summary else
                section("summary", "Ballot summary", FL_BY, [], "The ballot summary couldn't be read from the booklet's text (its font doesn't survive extraction), so it isn't shown here. Read it in the Division of Elections' booklet."),
                section("where", "Where it would change the constitution", FL_BY, [where]),
            ],
            "arguments": [],
            "links": [
                {"url": FL_BOOKLET, "label": "Proposed Constitutional Amendments for the General Election, with the full text of each (Division of Elections, PDF)"},
            ],
            "source_url": FL_BOOKLET,
            "source": "Proposed Constitutional Amendments for the General Election (November 3, 2026), Florida Division of Elections",
        })
    if not measures:
        raise Unreadable("Florida: no amendments found in the booklet")
    office = offices()["FL"]
    elec = election("FL", "Florida", "2026-11-04T01:00:00Z", office,
                    [{"url": FL_BOOKLET, "label": "Proposed Constitutional Amendments for the General Election (Division of Elections)"}], guide=FL_BOOKLET)
    elec["_guide_link"] = {"label": "Proposed constitutional amendments, with their full text", "url": FL_BOOKLET, "by": "Florida Division of Elections"}
    return doc("FL", elec, measures, "the Florida Division of Elections' booklet of proposed constitutional amendments")


# ---------------------------------------------------------------------------
# Michigan: the ballot wording, from the Senate Fiscal Agency's overviews

MI_PROPOSALS = [
    ("26-1", "https://sfa.senate.michigan.gov/Publications/BallotProps/Proposal26-1.pdf", []),
    ("26-2", "https://sfa.senate.michigan.gov/Publications/BallotProps/Proposal26-2.pdf",
     [{"url": "https://legislature.mi.gov/documents/2025-2026/initiative/Ballot_Proposal_2_of_2026.pdf", "label": "Analysis by the House Fiscal Agency (PDF)"}]),
]
MI_BY = "The ballot wording, drafted by the Director of Elections and approved by the Board of State Canvassers, as quoted by the Senate Fiscal Agency"


def mi_measures():
    measures = []
    for n, url, extra in MI_PROPOSALS:
        text = pdf_text(url)
        ls = [l.strip() for l in text.split("\n")]
        start = next((i for i, l in enumerate(ls) if l.endswith("on the ballot as follows:")), None)
        stop = next((i for i, l in enumerate(ls) if l.startswith("If a majority of the electors vote")), None)
        if start is None or stop is None:
            raise Unreadable(f"Michigan Proposal {n}: the ballot wording wasn't found")
        body = [l for l in ls[start + 1:stop] if l]
        body = [l for l in body if not re.fullmatch(r"(Yes|No|YES|NO)\s*\[\s*\]", l)]
        if body and re.fullmatch(r"Proposal (?:20)?\d\d-\d+", body[0]):
            body = body[1:]
        # The caption runs to the first line that starts the statement ("Shall …" or "The proposal would:").
        cap_end = next((i for i, l in enumerate(body) if l.startswith(("Shall ", "The proposal would"))), None)
        if cap_end is None:
            raise Unreadable(f"Michigan Proposal {n}: the ballot statement wasn't found")
        caption = join_lines(body[:cap_end])
        paras, cur = [], []
        for l in body[cap_end:]:
            if l.startswith("-- ") or l.startswith(("Shall ", "The proposal would", "Should this proposal")):
                if cur:
                    paras.append(join_lines(cur))
                cur = [l]
            else:
                cur.append(l)
        if cur:
            paras.append(join_lines(cur))
        question = next((p for p in paras if p.startswith(("Shall ", "Should "))), "")
        check(f"Michigan Proposal {n}", text, [caption, *paras])
        if not question:
            raise Unreadable(f"Michigan Proposal {n}: the ballot question wasn't found")
        measures.append({
            "id": f"proposal-{n}",
            "number": n,
            "label": f"Proposal {n}",
            "kind": "Constitutional convention question (required every 16 years)" if n == "26-1" else "Citizen-initiated statute",
            "scope": "statewide",
            "title": caption[0].upper() + caption[1:],
            "question": question,
            "question_by": MI_BY,
            "lead": {"text": caption, "source": "The caption of the ballot wording."},
            "sections": [section("wording", "The ballot wording", MI_BY, [caption, *paras])],
            "arguments": [],
            "links": [{"url": url, "label": f"Ballot Proposal {n}: An Overview, Senate Fiscal Agency (PDF), with background and the views expressed for and against"}, *extra],
            "source_url": url,
            "source": f"November 2026 Ballot Proposal {n}: An Overview, Michigan Senate Fiscal Agency",
        })
    office = offices()["MI"]
    elec = election("MI", "Michigan", "2026-11-04T02:00:00Z", office, [{"url": u, "label": f"Ballot Proposal {n}: An Overview (Senate Fiscal Agency)"} for n, u, _ in MI_PROPOSALS])
    return doc("MI", elec, measures, "the ballot wording quoted in the Michigan Senate Fiscal Agency's overviews")


# ---------------------------------------------------------------------------

STATES = {"CO": co_measures, "AZ": az_measures, "FL": fl_measures, "MI": mi_measures}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", action="append", choices=sorted(STATES), help="one state (repeatable); every state by default")
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    args = ap.parse_args()
    failed = []
    for st in args.state or STATES:
        try:
            data = STATES[st]()
        except Unreadable as e:
            print(f"{st}: not written: {e}", file=sys.stderr)
            failed.append(st)
            continue
        except Exception as e:  # noqa: BLE001 (a site down: that state waits for the next run)
            print(f"{st}: not written: {type(e).__name__}: {e}", file=sys.stderr)
            failed.append(st)
            continue
        data["election"].pop("_guide_link", None)
        out = Path(args.out_dir) / f"{DATE}-{st.lower()}.json"
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"{st}: {len(data['measures'])} measures → {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
        for m in data["measures"]:
            print(f"  {m['label']}: {m['title'][:70]} · {sum(len(s['paragraphs']) for s in m['sections'])} section paragraphs, {sum(len(a['paragraphs']) for a in m['arguments'])} argument paragraphs")
    if failed:
        sys.exit(f"Not written: {', '.join(failed)}")


if __name__ == "__main__":
    main()
