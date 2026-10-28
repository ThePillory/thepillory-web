#!/usr/bin/env python3
"""Statewide ballot measures for the November 3, 2026 general election in
Colorado, Arizona, Florida, Michigan and North Carolina, from each state's official documents,
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
  North Carolina  the State Board of Elections' ballot wording, the
             Legislative Services Officer's official summary explanations, the
             session laws that put each amendment on the ballot (what happens
             after the vote) and the Fiscal Research Division's fiscal notes;
             North Carolina publishes no official arguments. Also the State
             Board's Judicial Voter Guide: each appellate court candidate's
             details and statement, word for word

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_conflicts import sections_conflicts  # noqa: E402

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
        if isinstance(q, dict) and q.get("table"):
            continue
        text = q if isinstance(q, str) else q.get("h", "")
        if GARBLED.search(text):
            raise Unreadable(f"{where}: lost characters in {text[:80]!r}")
        if flat(text) not in src:
            # Show where the source differs, to fix the reader (the text is a public record).
            f = flat(text)
            n = len(f)
            while n > 20 and f[:n] not in src:
                n -= 10
            at = src.find(f[:n])
            raise Unreadable(f"{where}: not word for word in its source: {text[:100]!r}\n    read:   {f[max(0, n - 60):n + 140]!r}\n    source: {src[at + max(0, n - 60):at + n + 140] if at >= 0 else '(not found)'!r}")


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
        # List bullets ("●", "•", and "y", the bullet glyph in the Blue Book's font) aren't text.
        raw = ln.strip()
        s = re.sub(r"^(?:[●•▪]|y(?=\s*$))\s*|\s*[●•▪]$", "", raw)
        if raw and s != raw:
            # A bullet starts a new list item: whatever came before is its own paragraph.
            if re.match(r"^[●•▪]", raw) or not s:
                if cur:
                    blocks.append((cur, broke))
                    cur, broke = [], False
                if not s:
                    continue
            else:  # a bullet at the end of a line: the next line starts the list
                cur.append(s)
                blocks.append((cur, broke))
                cur, broke = [], False
                continue
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
    # Numbered arguments ("1) …", "2) …") run on without a blank line: each is its own paragraph.
    split = []
    for b, after_break in blocks:
        cut = [i for i, l in enumerate(b) if re.match(r"^\d{1,2}\)\s", l)]
        if len(cut) > 1 or (cut and cut[0] > 0):
            edges = ([0] if cut[0] > 0 else []) + cut + [len(b)]
            parts = [b[x:y] for x, y in zip(edges, edges[1:]) if b[x:y]]
            split += [(p, after_break if k == len(parts) - 1 else False) for k, p in enumerate(parts)]
        else:
            split.append((b, after_break))

    def heading_like(line, following):
        # A question, or a short line without a full stop followed by a line that starts a sentence.
        if line.endswith("?"):
            return True
        if re.search(r"\b(?:to|and|or|the|of|a|an|in|for|with|by|that|which)$", line):
            return False  # a sentence that runs on ("… amending the Colorado statutes to")
        return (len(line) < 70 and not re.search(r"[.;:,”\")]$", line) and not re.match(r"^\d{1,2}\)", line)
                and (following is None or re.match(r"^[A-Z0-9“\"$(]", following)))

    out = []
    pending_break = False
    for b, after_break in split:
        joinable = pending_break
        pending_break = after_break
        while len(b) > 1 and heading_like(b[0], b[1]):
            out.append({"h": b[0]})
            b = b[1:]
            joinable = False
        text = join_lines(b)
        if len(b) == 1 and heading_like(text, None):
            out.append({"h": text})
            continue
        prev = out[-1] if out else None
        # Continued across a page: the previous paragraph didn't end a sentence.
        if joinable and isinstance(prev, str) and not re.search(r"[.:;?!”\")]$", prev) and not re.match(r"^\d\)", text):
            out[-1] = prev + text if prev.endswith("-") and not prev.endswith(" -") else prev + " " + text
            continue
        out.append(text)
    return collapse_tables(out)


def tabley(h):
    """A "heading" that is really a table cell or chart label: few words, or numbers and signs. A question,
    or a heading of three or more words without dollar or percent signs, is a real heading."""
    words = re.findall(r"[A-Za-z]{2,}", h)
    if re.search(r"www\.|\.gov\b|/|^(?:Table|Figure)\s*\d", h):
        return True  # a web address or a table's caption in a chart
    if h.endswith("?") or (len(words) >= 3 and not re.search(r"[$%]|[a-z][A-Z]", h)):
        return False
    return len(words) < 2 or bool(re.search(r"[$%]|\d", h)) or bool(re.search(r"[a-z][A-Z]", h))


def collapse_tables(items):
    """A run of table cells and chart labels (two or more short pieces, mostly numbers or single words)
    becomes one {"table": true} marker: the page says a table is in the source document and links it."""
    # A "paragraph" of numbers with hardly a word ("4.4% -0.2") is a table row too.
    # "Table 1 …" or "Figure 2 …" starts a table: its caption and cells, up to the next full paragraph
    # (ten words or more) or real subheading, are the table.
    captioned, skipping = [], False
    for x in items:
        if isinstance(x, str):
            cap = re.search(r"\b(?:Table|Figure)\s*\d+\b", x)
            # A caption starts its own sentence ("… current law. Table 1 Fentanyl Offense …"); a sentence
            # that mentions a table ("as shown in Table 1", "Table 1 shows …") is text.
            if cap and (not x[:cap.start()].strip() or re.search(r"[.:?”]$", x[:cap.start()].strip())) \
                    and not re.match(r"(?:Table|Figure)\s*\d+\s+(?:shows|below|above|lists|compares|summarizes|includes|provides)\b", x[cap.start():]):
                before = x[:cap.start()].strip()
                if before:
                    captioned.append(before)
                captioned.append({"table": True})
                skipping = True
                continue
            if skipping and len(x.split()) < 10:
                continue
        elif "h" in x and re.match(r"(?:Table|Figure)\s*\d+\b", x["h"]):
            captioned.append({"table": True})
            skipping = True
            continue
        elif skipping and "h" in x and tabley(x["h"]):
            continue
        elif (skipping and "h" in x and not x["h"].endswith("?") and len(x["h"].split()) >= 4
              and captioned and isinstance(captioned[-1], dict) and captioned[-1].get("table")):
            continue  # the figure's own title, right after "Figure 3"
        skipping = False
        captioned.append(x)
    items = captioned
    def numeric(x):
        tokens = x.split()
        figures = sum(1 for t in tokens if re.search(r"\d", t))
        return (len(re.findall(r"[A-Za-z]{2,}", x)) < 4 and re.search(r"[\d$%]", x)) or (len(tokens) >= 4 and figures * 5 >= len(tokens) * 2)

    def label(x):
        # A chart or table label: a few words that don't end a sentence ("Higher revenue",
        # "Current Law: Single Filers", "$4.6 billion higher in the first year").
        return (len(x.split()) < 15 and not re.search(r"[.?!:;”\")]$", x)
                and not re.search(r"\b(?:to|and|or|the|of|a|an|in|for|with|by|that|which)$", x))

    items = [{"h": x, "label": True} if isinstance(x, str) and (numeric(x) or label(x)) else x for x in items]
    out, i = [], 0
    while i < len(items):
        if isinstance(items[i], dict) and "h" in items[i]:
            j = i
            while j < len(items) and isinstance(items[j], dict) and "h" in items[j]:
                j += 1
            run = items[i:j]
            cells = sum(1 for x in run if tabley(x["h"]) or x.get("label"))
            # Mostly cells, or four or more "headings" in a row with no text and no question among them: a chart.
            if len(run) >= 2 and (cells * 2 >= len(run) or (len(run) >= 4 and not any(x["h"].endswith("?") for x in run))):
                # keep a real subheading that opens the run, if it isn't a cell itself
                lead = []
                while run and not tabley(run[0]["h"]) and len(run) > 1 and tabley(run[1]["h"]) is False:
                    lead.append(run.pop(0))
                out += lead + [{"table": True}]
            elif len(run) == 1 and tabley(run[0]["h"]):
                out.append({"table": True})
            else:
                out += run
            i = j
            continue
        out.append(items[i])
        i += 1
    # A short label right against a table ("Higher revenue", "Current Law: Single Filers") is part of it.
    def is_table(x):
        return isinstance(x, dict) and x.get("table")

    def short_label(x):
        return isinstance(x, dict) and x.get("label") and not x["h"].endswith("?") and len(x["h"].split()) < 15

    changed = True
    while changed:
        changed = False
        for k, x in enumerate(out):
            between = 0 < k < len(out) - 1 and is_table(out[k - 1]) and is_table(out[k + 1])
            if (short_label(x) and ((k > 0 and is_table(out[k - 1])) or (k + 1 < len(out) and is_table(out[k + 1])))) or (
                    between and isinstance(x, dict) and "h" in x and not x["h"].endswith("?")):
                out[k] = {"table": True}
                changed = True
    # Between two tables, short pieces with no question and no real paragraph (ten words or more) are
    # the tables' labels ("Millions of Dollars", "Great Outdoors Colorado (GOCO)").
    marks = [k for k, x in enumerate(out) if is_table(x)]
    for a, b in zip(marks, marks[1:]):
        seg = out[a + 1:b]
        if seg and all((isinstance(x, dict) and "h" in x and not x["h"].endswith("?")) or (isinstance(x, str) and len(x.split()) < 10) for x in seg):
            out[a + 1:b] = [{"table": True}] * len(seg)
    # neighbouring markers are one table
    merged = []
    for x in out:
        if isinstance(x, dict) and x.get("table") and merged and isinstance(merged[-1], dict) and merged[-1].get("table"):
            continue
        merged.append(x)
    return merged


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
    measures, furniture, checks = [], [], []
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

        def noise(s, number=number, short=short, label=label):
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
        # A ballot title is a question: it ends at its question mark (a table can follow it, as for Amendment 87).
        q = next((j for j in range(bt0 + 1, bt1) if stripped[j].endswith("?")), bt1 - 1)
        ballot_title = join_lines(stripped[bt0 + 1:q + 1])
        furniture.append(noise)
        for what, quotes in (("proposal", proposes), ("analysis", analysis), ("arguments for", pros), ("arguments against", cons), ("fiscal impact", money), ("vote meanings", [yes, no, ballot_title])):
            checks.append((f"Colorado {label} {what}", quotes))
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
    # Quotes are checked against the booklet's text without its page furniture (page numbers, the
    # measure number and running title at the top of each page), which can fall mid-paragraph.
    clean = "\n".join(l for l in lines if not (l.strip() and any(f(l.strip()) for f in furniture)))
    for where, quotes in checks:
        check(where, clean, quotes)
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
    # The argument and analysis links are extras: a page that refuses to load leaves them out this run.
    try:
        args = az_links(page_text(AZ_PAGE))
    except Exception as e:  # noqa: BLE001
        print(f"AZ: the Secretary of State's ballot measures page wasn't read ({type(e).__name__}); argument links left out", file=sys.stderr)
        args = {}
    try:
        analyses = az_analyses(page_text(AZ_ANALYSES))
    except Exception as e:  # noqa: BLE001
        print(f"AZ: the Legislative Council's analyses page wasn't read ({type(e).__name__}); analysis links left out", file=sys.stderr)
        analyses = {}
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
    heads = [i for i, l in enumerate(ls) if re.fullmatch(r"No\. (\d+) Constitutional Amendment", l)]
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
# North Carolina: the State Board of Elections' ballot wording, the Legislative
# Services Officer's official summary explanations, the session laws that put
# each amendment on the ballot, the Fiscal Research Division's fiscal notes, and
# the State Board's Judicial Voter Guide (candidates' own statements).

NC_REFERENDA = "https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/statewide_referendums_20261103.pdf"
NC_UPCOMING = "https://www.ncsbe.gov/voting/upcoming-election"
# The Legislative Services Officer's release (N.C.G.S. 147-54.10) goes to every county board of
# elections; the Secretary of State's commission page doesn't post it, so it's read from the copy a
# county board of elections publishes (the first that reads; each is checked against itself).
NC_EXPLANATION = [
    "https://www.forsythcountync.gov/elections/assets/documents/Summary_Explanation_of_2026_Constitutional_Amendments.pdf",
    "https://www.clevelandcounty.com/main/Summary%20Explanation%20of%202026%20Constitutional%20Amendments.pdf",
]
NC_JUDICIAL = "https://www.ncsbe.gov/voting/upcoming-election/judicial-voter-guide-2026-general-election"
# Each amendment's session law: (number, the ratified law's PDF, the bill's page with its fiscal notes).
NC_LAWS = [
    ("2024-58", "https://www.ncleg.gov/EnactedLegislation/SessionLaws/PDF/2023-2024/SL2024-58.pdf", "https://www.ncleg.gov/BillLookUp/2023/S921", "Senate Bill 921"),
    ("2026-4", "https://www.ncleg.gov/Sessions/2025/Bills/Senate/PDF/S1080v3.pdf", "https://www.ncleg.gov/BillLookUp/2025/S1080", "Senate Bill 1080"),
    ("2026-5", "https://www.ncleg.gov/Sessions/2025/Bills/House/PDF/H1089v3.pdf", "https://www.ncleg.gov/BillLookUp/2025/H1089", "House Bill 1089"),
]
NC_SBE = "the North Carolina State Board of Elections' list of statewide referendum choices"
NC_LSO = "Official summary explanation, prepared by the Legislative Services Officer of the North Carolina General Assembly under N.C.G.S. 147-54.10"
NC_FRD = "Fiscal Research Division, North Carolina General Assembly: legislative fiscal note"
NC_NO_ARGUMENTS = "North Carolina doesn't publish official arguments for or against its constitutional amendments, so there are none to show here. The official summary explanation, the session law and the fiscal note above are the state's official documents on this amendment."
BULLET = re.compile(r"^[•●▪◦]\s*")


def nc_paragraphs(lines):
    """Lines of a PDF (no layout) as paragraphs: a blank line or a bullet starts a new one."""
    out, cur = [], []
    for raw in lines:
        line = raw.strip()
        if not line:
            if cur:
                out.append(join_lines(cur))
            cur = []
            continue
        if BULLET.match(line):
            if cur:
                out.append(join_lines(cur))
            cur = [BULLET.sub("", line)]
        else:
            cur.append(line)
    if cur:
        out.append(join_lines(cur))
    return [p for p in out if p]


def nc_referenda():
    """[{heading, question}] in the State Board's order."""
    text = pdf_text(NC_REFERENDA)
    ls = [l.strip() for l in text.split("\n")]
    out = []
    for i, l in enumerate(ls):
        m = re.fullmatch(r"CONSTITUTIONAL AMENDMENT\s*-\s*(.+)", l)
        if not m:
            continue
        j = i + 1
        while j < len(ls) and ls[j] != "For":
            j += 1
        q = []
        for l2 in ls[j + 1:]:
            if l2 in ("Against", "For") or l2.startswith("CONSTITUTIONAL AMENDMENT"):
                break
            if l2:
                q.append(l2)
        question = join_lines(q)
        check(f"North Carolina: {m.group(1)}", text, [l, question])
        out.append({"heading": m.group(1).strip(), "question": question})
    if not out:
        raise Unreadable("North Carolina: no referenda in the State Board's list")
    return out, text


def nc_explanations():
    """{session law number: {name, question, summary}} from the Legislative Services Officer's release."""
    last = None
    for url in NC_EXPLANATION:
        try:
            text = pdf_text(url)
        except Exception as e:  # noqa: BLE001 (the next county's copy)
            last = e
            continue
        ls = [l.strip() for l in text.split("\n")]
        heads = [i for i, l in enumerate(ls) if l.endswith("Proposed Constitutional Amendment")]
        out = {}
        for k, h in enumerate(heads):
            end = heads[k + 1] if k + 1 < len(heads) else len(ls)
            seg = ls[h:end]
            name = seg[0][: -len("Proposed Constitutional Amendment")].strip()
            law = re.search(r"Session Law (\d{4}-\d+) places", " ".join(seg))
            off = next((i for i, l in enumerate(seg) if l.endswith("(Official Summary)")), None)
            if not law or off is None:
                raise Unreadable(f"North Carolina: the explanation for {name} didn't read")
            body = []
            for l in seg[off + 1:]:
                if l.startswith("This official summary explanation was adopted"):
                    break
                body.append(l)
            summary = nc_paragraphs(body)
            check(f"North Carolina explanation, {name}", text, [name, *summary])
            out[law.group(1)] = {"name": name, "summary": summary, "url": url}
        if out:
            return out
        last = Unreadable("North Carolina: no explanations found in the Legislative Services Officer's release")
    raise last if isinstance(last, Unreadable) else Unreadable(f"North Carolina: the explanation didn't download ({last})")


def nc_law(number, url):
    """The session law's ballot question and what its sections say happens after the vote."""
    text = pdf_text(url)
    ls = [l.strip() for l in text.split("\n")]
    secs, cur = [], []
    for l in ls:
        if re.match(r"SECTION \d+\.", l):
            if cur:
                secs.append(join_lines(cur))
            cur = [l]
        elif cur and (l.startswith("In the General Assembly read three times") or re.match(r"\*[SH]\d+-v-\d+\*", l) or re.match(r"Page \d+ ", l)):
            secs.append(join_lines(cur))
            cur = []
        elif cur:
            cur.append(l)
    if cur:
        secs.append(join_lines(cur))
    q = next((x for x in secs if "The question to be used in the voting systems and ballots shall be" in x), None)
    after = [x for x in secs if re.search(r"majority of votes cast on the question", x)]
    if not q or not after:
        raise Unreadable(f"North Carolina Session Law {number}: its ballot question or certification sections weren't found")
    check(f"North Carolina Session Law {number}", text, after)
    title = re.search(r"(AN ACT TO .+?)\s+The General Assembly of North Carolina enacts:", flat(text))
    return {"after": after, "question_text": flat(q), "title": title.group(1) if title else None}


def nc_fiscal(bill_page):
    """The bill's latest fiscal note: its Fiscal Impact Summary, word for word, and the note's edition and date. None when there's no note."""
    page = page_text(bill_page)
    notes = re.findall(r'href="(/Sessions/\d+/FiscalNotes/[^"]+\.pdf)"', page)
    if not notes:
        return None
    url = "https://www.ncleg.gov" + notes[-1]
    text = pdf_text(url)
    ls = [l.strip() for l in text.split("\n")]
    try:
        a = ls.index("FISCAL IMPACT SUMMARY")
    except ValueError:
        raise Unreadable(f"North Carolina fiscal note {url}: no Fiscal Impact Summary")
    b = next((i for i in range(a + 1, len(ls)) if ls[i] in ("FISCAL ANALYSIS", "TECHNICAL CONSIDERATIONS") or ls[i].startswith("FISCAL RESEARCH DIVISION")), len(ls))
    paras = nc_paragraphs(ls[a + 1:b])
    check(f"North Carolina fiscal note {url}", text, paras)
    edition = re.search(r"((?:Senate|House) Bill \d+ \([A-Z][a-z]+ Edition\))", flat(text))
    date = re.search(r"FISCAL RESEARCH DIVISION Page 1 of \d+ ([A-Z][a-z]+ \d{1,2}, \d{4})", flat(text))
    return {"url": url, "paragraphs": paras, "edition": edition.group(1) if edition else None, "date": date.group(1) if date else None}


def nc_judicial():
    """The Judicial Voter Guide: each contest's candidates in ballot order, with the guide's fields and statement, word for word."""
    page = page_text(NC_JUDICIAL)
    page = page.split("<footer", 1)[0]
    body = re.sub(r"(?is)<(script|style|nav|header)\b.*?</\1>", "", page)
    body = re.sub(r"(?i)<br\s*/?>|</?(p|div|h[1-6]|li|ul|ol|section|article|tr|td|th|table|dt|dd|dl)\b[^>]*>", "\n", body)
    body = html.unescape(re.sub(r"<[^>]+>", "", body)).replace("\xa0", " ")
    ls = [re.sub(r"[ \t]+", " ", l).strip() for l in body.split("\n")]
    ls = [l for l in ls if l]
    src = "\n".join(ls)
    try:
        start = max(i for i, l in enumerate(ls) if l == "Candidate Submissions")
    except ValueError:
        raise Unreadable("North Carolina Judicial Voter Guide: no candidate submissions")
    intro = []
    if "About This Guide" in ls:
        a = max(i for i, l in enumerate(ls) if l == "About This Guide")
        for l in ls[a + 1:]:
            if l in ("4 Appellate Court Contests", "About the Appellate Courts", "Voter Registration", "Candidate Submissions") or re.match(r"\d+ Appellate Court Contests", l):
                break
            intro.append(l)
    labels = ["Residence", "Education", "Occupation", "Employer", "Date Admitted to the Bar", "Date Admitted to Bar", "Legal/Judicial Experience", "Candidate Statement"]
    parties = {"Democrat", "Republican", "Libertarian", "Green", "Unaffiliated", "Constitution", "Justice for All", "No Labels", "We the People"}
    contests, cand, field = [], None, None
    stop = ("Return to top", "Back to top", "Share this page", "Was this page helpful?", "Last updated")
    for i, l in enumerate(ls[start + 1:], start + 1):
        if l.startswith(stop):
            break
        if re.fullmatch(r"NC (Supreme Court|Court of Appeals)(?: Associate Justice| Chief Justice| Judge)? Seat \d+", l):
            contests.append({"office": l, "candidates": []})
            cand, field = None, None
            continue
        if not contests:
            continue
        if i + 1 < len(ls) and ls[i + 1] in parties and l not in labels:
            cand = {"name": l, "party": ls[i + 1], "fields": []}
            contests[-1]["candidates"].append(cand)
            field = "party"
            continue
        if field == "party" and l in parties:
            field = None
            continue
        if cand is None:
            continue
        if l in labels:
            cand["fields"].append([("Date Admitted to the Bar" if l.startswith("Date Admitted") else l), []])
            field = l
            continue
        if cand["fields"]:
            cand["fields"][-1][1].append(l)
    out = []
    for c in contests:
        if not c["candidates"]:
            continue
        m = re.match(r"NC (Supreme Court|Court of Appeals)(?: (Associate Justice|Chief Justice|Judge))? Seat (\d+)", c["office"])
        if not m:
            raise Unreadable(f"North Carolina Judicial Voter Guide: contest {c['office']!r} didn't read")
        court = "supreme-court" if m.group(1) == "Supreme Court" else "court-of-appeals"
        office = f"{'Associate Justice, Supreme Court of North Carolina' if court == 'supreme-court' else 'Judge, North Carolina Court of Appeals'}, Seat {m.group(3)}"
        cands = []
        for cd in c["candidates"]:
            fields, statement = [], []
            for label, vals in cd["fields"]:
                # A sentence ending in "Learn more at" plus its link, and a lone "." after a link: one paragraph.
                merged = []
                for v in vals:
                    if merged and (v in (".", ",") or merged[-1].endswith(("Learn more at", "Learn more at:")) or re.fullmatch(r"(?:https?://)?(?:www\.)?[\w-]+(\.[\w-]+)+(/\S*)?\.?", v) and merged[-1].rstrip().endswith((":", "at"))):
                        merged[-1] = merged[-1].rstrip() + ("" if v in (".", ",") else " ") + v
                    else:
                        merged.append(v)
                if label == "Candidate Statement":
                    statement = merged
                else:
                    fields.append([label, merged])
            for label, vals in fields:
                check(f"North Carolina Judicial Voter Guide, {cd['name']}, {label}", src, vals)
            check(f"North Carolina Judicial Voter Guide, {cd['name']}, statement", src, statement)
            cands.append({
                "name": cd["name"],
                "party": cd["party"],
                "details": fields,
                **({"statement": {"paragraphs": statement, "source_url": NC_JUDICIAL, "source": "North Carolina State Board of Elections, Judicial Voter Guide: 2026 General Election"}} if statement else {}),
            })
        out.append({"id": f"{court}-seat-{m.group(3)}", "office": office, "guide_heading": c["office"], "court": court, "candidates": cands})
    if not out or any(len(c["candidates"]) < 1 for c in out):
        raise Unreadable("North Carolina Judicial Voter Guide: no contests read")
    check("North Carolina Judicial Voter Guide, about this guide", src, intro)
    return {
        "source_url": NC_JUDICIAL,
        "source": "North Carolina State Board of Elections, Judicial Voter Guide: 2026 General Election",
        "about": intro,
        "contests": out,
    }


def nc_measures():
    referenda, ref_text = nc_referenda()
    explained = nc_explanations()
    laws = {}
    for number, url, bill_page, bill in NC_LAWS:
        laws[number] = {**nc_law(number, url), "url": url, "bill_page": bill_page, "bill": bill, "fiscal": nc_fiscal(bill_page)}
    measures = []
    for n, r in enumerate(referenda, 1):
        # Each referendum's session law is the one whose ballot question is the State Board's, word for word.
        number = next((k for k, v in laws.items() if flat(r["question"]) in v["question_text"]), None)
        if not number:
            raise Unreadable(f"North Carolina: no session law has the ballot question {r['question'][:80]!r}")
        law, ex = laws[number], explained.get(number)
        if not ex:
            raise Unreadable(f"North Carolina: no official explanation for Session Law {number}")
        sections = [
            section("explanation", "Official summary explanation", NC_LSO + ", adopted August 20, 2026", ex["summary"]),
            section("law", f"How it got on the ballot: Session Law {number}", f"Session Law {number} ({law['bill']}), North Carolina General Assembly", law["after"],
                    "The amendment's own text marks the words it adds and removes by underlining and striking through, which doesn't survive copying, so it isn't shown here. Read it in the session law (linked below)."),
        ]
        fiscal = law["fiscal"]
        if fiscal:
            sections.append(section("fiscal", "Fiscal note", NC_FRD + (f", on {fiscal['edition']}" if fiscal["edition"] else "") + (f", {fiscal['date']}" if fiscal["date"] else ""), fiscal["paragraphs"],
                                    "The note's Fiscal Impact Summary, word for word. It was written on the edition of the bill named above, the latest the General Assembly lists a fiscal note for. The full note, with its analysis and tables, is linked below."))
        links = [
            {"url": NC_REFERENDA, "label": "Statewide referendum choices on the ballot, North Carolina State Board of Elections (PDF)"},
            {"url": ex["url"], "label": "Official Summary Explanation of 2026 Constitutional Amendments, Legislative Services Officer (PDF, as published by a county board of elections)"},
            {"url": law["url"], "label": f"Session Law {number}, with the amendment's text (PDF)"},
            {"url": law["bill_page"], "label": f"{law['bill']}: history and votes, North Carolina General Assembly"},
        ]
        if fiscal:
            links.append({"url": fiscal["url"], "label": "Legislative fiscal note, Fiscal Research Division (PDF)"})
        measures.append({
            "id": f"amendment-{n}",
            "number": str(n),
            # The ballot doesn't number North Carolina's amendments: each is "Constitutional Amendment" plus its heading.
            "label": "Constitutional Amendment",
            "kind": "Legislatively referred constitutional amendment",
            "placed_by": "the General Assembly",
            "scope": "statewide",
            "title": r["heading"],
            "official_name": ex["name"],
            "requirement": "Passes with a majority of the votes cast on the question (the session law, as quoted below)",
            "question": r["question"],
            "question_by": "the ballot wording, from " + NC_SBE + " and the session law",
            **({} if fiscal else {"cost_note": f"The General Assembly lists no fiscal note from its Fiscal Research Division for {law['bill']} (Session Law {number})."}),
            "means_note": f"North Carolina's official documents don't print a “Yes means / No means.” Voters mark FOR or AGAINST: “{r['question']}”",
            "lead": {"text": " ".join(ex["summary"]), "source": "The official summary explanation."},
            "sections": sections,
            "arguments": [],
            "no_arguments": NC_NO_ARGUMENTS,
            "links": links,
            "source_url": ex["url"],
            "source": "Official Summary Explanation of 2026 Constitutional Amendments, Legislative Services Officer",
        })
    office = offices()["NC"]
    elec = election("NC", "North Carolina", "2026-11-04T00:30:00Z", office,
                    [{"url": NC_REFERENDA, "label": "Statewide referendum choices (State Board of Elections)"},
                     {"url": NC_EXPLANATION[0], "label": "Official Summary Explanation of 2026 Constitutional Amendments (Legislative Services Officer)"},
                     {"url": NC_JUDICIAL, "label": "Judicial Voter Guide: 2026 General Election (State Board of Elections)"}], guide=NC_UPCOMING)
    elec["_guide_link"] = {"label": "Judicial Voter Guide: the appellate court candidates, in their own words", "url": NC_JUDICIAL, "by": "North Carolina State Board of Elections"}
    data = doc("NC", elec, measures, "the North Carolina State Board of Elections, the Legislative Services Officer's summary explanations, the session laws and the Fiscal Research Division's fiscal notes, and the State Board's Judicial Voter Guide")
    try:
        data["judicial"] = nc_judicial()
    except Unreadable as e:
        # The measures still publish; the guide waits for the next run (the run is marked failed).
        print(f"NC: Judicial Voter Guide not read: {e}", file=sys.stderr)
        LATE_FAILURES.append("NC judicial guide")
    return data


# ---------------------------------------------------------------------------

LATE_FAILURES = []
STATES = {"CO": co_measures, "AZ": az_measures, "FL": fl_measures, "MI": mi_measures, "NC": nc_measures}


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
        # What the official sections say about other measures on this ballot (tools/measure_conflicts.py).
        for m in data["measures"]:
            conflicts = sections_conflicts(m, data["measures"])
            if conflicts:
                m["conflicts"] = conflicts
        out = Path(args.out_dir) / f"{DATE}-{st.lower()}.json"
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"{st}: {len(data['measures'])} measures → {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
        for m in data["measures"]:
            print(f"  {m['label']}: {m['title'][:70]} · {sum(len(s['paragraphs']) for s in m['sections'])} section paragraphs, {sum(len(a['paragraphs']) for a in m['arguments'])} argument paragraphs")
        if data.get("judicial"):
            print(f"  Judicial Voter Guide: {len(data['judicial']['contests'])} contests, {sum(1 for c in data['judicial']['contests'] for x in c['candidates'] if x.get('statement'))} statements")
    if failed or LATE_FAILURES:
        sys.exit(f"Not written: {', '.join(failed + LATE_FAILURES)}")


if __name__ == "__main__":
    main()
