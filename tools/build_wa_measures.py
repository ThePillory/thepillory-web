#!/usr/bin/env python3
"""Washington's statewide ballot measures for the 2026 general election, from
the Secretary of State's official documents, word for word:

  - the ballot title (statement of subject, concise description, the question)
    and the explanatory statement ("The Law as It Presently Exists", "The
    Effect of the Proposed Measure if Approved"), both written by the Office of
    the Attorney General, from the Attorney General's letter to the Secretary;
  - the fiscal impact statement's summary, written by the Office of Financial
    Management, as printed in the Voters' Pamphlet (the separate fiscal PDFs
    drop letters where their font uses ligatures, so they're linked, not read);
  - the arguments for and against and each side's rebuttal, with who wrote
    them, from each measure's Voters' Pamphlet page. Each side's contact line
    is left out (no contact details on ThePillory).

Writes data/elections/2026-11-03-wa.json in the same shape as California's
(tools/build_elections.py), so the same pages show it. Needs pdftotext
(poppler-utils). See docs/elections.md.

    python3 tools/build_wa_measures.py              # download, read, write
    python3 tools/build_wa_measures.py --from DIR   # read texts saved by an earlier run (tests, debugging)
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "elections" / "2026-11-03-wa.json"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
SOS = "https://www.sos.wa.gov"
FILES = f"{SOS}/sites/default/files"
GUIDE = f"{SOS}/elections/data-research/election-data-and-maps/election-results-and-voters-pamphlets/2026-general-election-voters-guide"
PAMPHLET_PDFS = f"{GUIDE}/2026-voters-pamphlet-pdfs"
# One English edition of the Voters' Pamphlet: its statewide section (measures,
# fiscal statements) is the same in every county's edition.
PAMPHLET = f"{FILES}/2026-10/Voters%20Pamphlet%202026%20-%20Edition%2023%20-%20Skagit.pdf"

ELECTION = {
    "id": "2026-11-03-wa",
    "name": "November 3, 2026, General Election",
    "date": "2026-11-03",
    # Ballots must be postmarked or in a drop box by 8 p.m. Pacific on Election Day.
    "polls_close_utc": "2026-11-04T04:00:00Z",
    "state": "WA",
    "sos_page": f"{SOS}/about-office/news/2026/secretary-state-certifies-candidates-and-measures-november-general-election",
    "guide": GUIDE,
    "guide_pdf": PAMPHLET,
    "measures_page": f"{SOS}/elections/voters/proposed-ballot-measure-information",
    "results_page": f"{SOS}/elections/data-research/election-data-and-maps/election-results-and-voters-pamphlets",
}
ELECTION["sources"] = [
    {"url": ELECTION["sos_page"], "label": "Secretary of State certifies candidates and measures for the November General Election"},
    {"url": GUIDE, "label": "2026 General Election Voters' Guide (Secretary of State)"},
    {"url": PAMPHLET_PDFS, "label": "2026 Voters' Pamphlet PDFs, every edition (Secretary of State)"},
    {"url": ELECTION["measures_page"], "label": "Proposed ballot measure information (Secretary of State)"},
]

HOW_TO_VOTE = [
    {"label": "Register to vote, update your registration, or track your ballot", "url": "https://votewa.gov/", "by": "VoteWA, Washington Secretary of State"},
    {"label": "Where to vote: ballot drop boxes and voting centers", "url": "https://voter.votewa.gov/WhereToVote.aspx", "by": "VoteWA, Washington Secretary of State"},
    {"label": "The 2026 General Election Voters' Guide", "url": GUIDE, "by": "Washington Secretary of State"},
]

# In ballot order, as the Voters' Pamphlet lists them.
MEASURES = [
    {
        "number": "IP26-645", "kind": "Initiative to the People",
        "statement": f"{FILES}/2026-07/ExStmt_IP26-645.pdf",
        "pamphlet_page": f"{FILES}/2026-09/IP26-645%20VP%20page%209.17.pdf",
        "fiscal": f"{FILES}/2026-07/FIS%20-%20Initiative%20645%20-%20FINAL.pdf",
        "text": f"{FILES}/2026-07/Finaltext_IP26-645_fulltext.pdf",
        "ballot_title_letter": f"{FILES}/2026-07/IP26-645%20Ballot%20title%20%26%20Summary.pdf",
    },
    {
        "number": "IL26-001", "kind": "Initiative to the Legislature",
        "statement": f"{FILES}/2026-07/ExStat_IL26-001.pdf",
        "pamphlet_page": f"{FILES}/2026-08/IL26-001%20VP%20page.pdf",
        "fiscal": f"{FILES}/2026-07/Initiative%20Measure%20NoIL26-001_FIS_FINAL.pdf",
        "text": f"{FILES}/2026-03/INITIATIVE%20IL26-001%20fulltext.pdf",
        "ballot_title_letter": f"{FILES}/2026-03/INITIATIVE%20IL26-001%20ballottitleletter.pdf",
    },
    {
        "number": "IL26-638", "kind": "Initiative to the Legislature",
        "statement": f"{FILES}/2026-07/IL26-638%20Explanatory%20Statement.pdf",
        "pamphlet_page": f"{FILES}/2026-08/IL26-638%20VP%20page.pdf",
        "fiscal": f"{FILES}/2026-07/Initiative%20Measure%20NoIL26-638_FIS_FINAL.pdf",
        "text": f"{FILES}/2026-03/INITIATIVE%20IL26-638%20fulltext.pdf",
        "ballot_title_letter": f"{FILES}/2026-03/INITIATIVE%20IL26-638%20ballottitleletter.pdf",
    },
]

ARGUMENTS_DISCLAIMER = "The Secretary of State is not responsible for the content of statements or arguments (WAC 434-381-180)."

# Glyphs that mean a font's ligature was lost: text with any of these is not word for word.
DAMAGED = re.compile(r"[ƯƟ�]|\b(?:e|o|di|su|a|stu|sta|tra|tari|cert|identi|signi|speci|bene)\s(?:ect|ice|erent|cient|ord|ected|ective|ectively|ication|icant|ic|ied)\b")
LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"}


# ---------------------------------------------------------------------------
# Text from the PDFs

def saved_name(url, layout):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("://", 1)[1])[:180].removesuffix(".pdf") + (".layout.txt" if layout else ".txt")


def pdf_text(url, layout=False, source_dir=None):
    if source_dir:
        text = (Path(source_dir) / saved_name(url, layout)).read_text(encoding="utf-8")
    else:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "doc.pdf"
            with urllib.request.urlopen(req, timeout=120) as r:
                pdf.write_bytes(r.read())
            out = Path(tmp) / "doc.txt"
            subprocess.run(["pdftotext", *(["-layout"] if layout else []), str(pdf), str(out)], check=True)
            text = out.read_text(encoding="utf-8")
    for a, b in LIGATURES.items():
        text = text.replace(a, b)
    bad = DAMAGED.search(text)
    if bad:
        raise SystemExit(f"{url}: the text has damaged characters ({bad.group(0)!r}); not used.")
    return text


def join_lines(lines):
    """Lines of one paragraph as one string; a word broken with a hyphen at the end of a line keeps its hyphen."""
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
    return re.sub(r"\s+", " ", out).strip()


LABEL = re.compile(r"^(?:[A-Z][\w’'&,/-]*\s?(?:and|or|of|the|to|for|in|on|a)?\s?){1,8}:\s")


def line_width(lines):
    """A full line's length: most lines of a paragraph run to the margin (the 80th percentile, so one odd long line doesn't count)."""
    lengths = sorted(len(l.strip()) for l in lines if l.strip())
    return lengths[int(len(lengths) * 0.8)] if lengths else 0


SMALL = {"a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"}


def heading_like(line, short_ok=False):
    """A campaign's own heading ("Vote No Because It Discourages Girls From Playing Sports"): nearly every word
    capitalized. short_ok: a heading's last, short line ("Word", "Are Crime Victims") counts too."""
    words = [w for w in re.findall(r"[A-Za-z0-9][\w’'.-]*", line) if w.lower() not in SMALL]
    if not words or (len(words) < 2 and not short_ok):
        return False
    return sum(w[0].isupper() or w[0].isdigit() for w in words) >= 0.85 * len(words)


def paragraphs(lines, width=None):
    """Paragraphs from wrapped lines: a paragraph ends on a short line, a heading ends where sentence text starts,
    and one starts at a "Label:" line or at a heading after a finished sentence."""
    lines = [l.rstrip() for l in lines]
    width = width or line_width(lines)
    out, cur, after_heading = [], [], False

    def is_heading(ls):
        return bool(ls) and all(heading_like(x, short_ok=True) and not re.search(r"[.!?]$", x) for x in ls)

    def flush():
        nonlocal cur, after_heading
        if cur:
            # The text right after a heading is never another heading (it may be full of capitalized names).
            after_heading = is_heading(cur) and not after_heading
            out.append(join_lines(cur))
        cur = []

    for line in lines:
        s = line.strip()
        if s == PAGE_BREAK:
            # A page break ends the paragraph when the page's last line ends a sentence.
            if cur and re.search(r"[.:;”\"]$", cur[-1]):
                flush()
            continue
        if not s:
            continue
        heading_done = cur and not after_heading and is_heading(cur) and not heading_like(s, short_ok=True)
        if cur and (heading_done or LABEL.match(s) or (re.search(r"[.!?”\"]$", cur[-1]) and heading_like(s))):
            flush()
        cur.append(s)
        if len(s) < width * 0.78:
            flush()
    flush()
    return [p for p in out if p]


# ---------------------------------------------------------------------------
# The Attorney General's letter: ballot title and explanatory statement

PAGE_BREAK = "<page break>"
LETTER_NOISE = re.compile(r"^(ATTORNEY GENERAL OF WASHINGTON|[A-Z][a-z]+ \d{1,2}, \d{4}|Page \d+|EXPLANATORY STATEMENT|Explanatory Statement)$")


def ballot_title(text):
    t = re.sub(r"\s+", " ", text)
    subject = re.search(r"Statement of Subject:\s*(.+?)\s*Concise Description:", t)
    description = re.search(r"Concise Description:\s*(.+?)\s*Should this measure be enacted into law\?", t)
    if not subject or not description:
        raise SystemExit("ballot title not found in the Attorney General's letter")
    return {"subject": subject.group(1), "description": description.group(1), "question": "Should this measure be enacted into law?"}


def explanatory(text):
    # The letter's page headers (name, date, page number) mark page breaks.
    lines = [PAGE_BREAK if LETTER_NOISE.match(l.strip()) else l for l in text.replace("\f", "\n").split("\n")]
    joined = "\n".join(lines)
    m = re.search(r"\nThe Law [Aa]s It Presently Exists\n(.*?)\nThe Effect of the Proposed Measure,? [Ii]f Approved\n(.*?)\nSincerely,", joined, re.S)
    if not m:
        raise SystemExit("explanatory statement sections not found")
    present, effect = m.group(1).split("\n"), m.group(2).split("\n")
    width = line_width([l for l in present + effect if l != PAGE_BREAK])
    return {"present": paragraphs(present, width), "effect": paragraphs(effect, width)}


# ---------------------------------------------------------------------------
# The Voters' Pamphlet: the fiscal impact statement's summary

def fiscal_summary(pamphlet, number):
    """The Summary under 'Fiscal Impact Statement' for this measure, up to 'General assumptions'."""
    for m in re.finditer(r"Fiscal Impact Statement\nWritten by the Office of Financial Management\n(.*?)\nGeneral assumptions", pamphlet, re.S):
        body = m.group(1)
        if f"Initiative Measure No. {number}" not in body:
            continue
        body = body.split("\nSummary\n", 1)[-1]
        lines = [l for l in body.split("\n") if l.strip() and not re.fullmatch(r"Initiative Measure (No\. )?[A-Z]{2}\d{2}-\d{3}", l.strip()) and not l.strip().startswith("For more information visit")]
        return [join_lines(lines)]
    raise SystemExit(f"{number}: fiscal impact summary not found in the pamphlet")


# ---------------------------------------------------------------------------
# The Voters' Pamphlet page: arguments, rebuttals and who wrote them

SECTION = {
    "Argument for": ("for", "supporters"),
    "Argument against": ("against", "opponents"),
    # A rebuttal answers the other side: the supporters' rebuttal answers the argument against.
    "Rebuttal of argument against": ("rebuttal_for", "supporters"),
    "Rebuttal of argument for": ("rebuttal_against", "opponents"),
}


def columns(layout):
    """The two columns of a pamphlet page (left: supporters; right: opponents), each as its lines."""
    lines = layout.replace("\f", "\n").split("\n")
    head = next((i for i, l in enumerate(lines) if l.strip().startswith("Argument for") and "Argument against" in l), None)
    if head is None:
        raise SystemExit("pamphlet page: no 'Argument for / Argument against' heading")
    cut = lines[head].index("Argument against")
    left, right = [], []
    for l in lines[head:]:
        left.append(l[:cut])
        right.append(l[cut:])
    return left, right


def signers(lines):
    text = join_lines(lines)
    out = []
    for part in [p.strip() for p in text.split(";") if p.strip()]:
        name, _, title = part.partition(",")
        out.append({"name": name.strip(), "title": title.strip()})
    return out


def column_parts(lines, number):
    parts, cur, written, kind = {}, None, [], None
    for raw in lines:
        s = raw.strip()
        if s in SECTION:
            cur = SECTION[s]
            parts[cur] = []
            continue
        if s == "Written by":
            cur = "written"
            continue
        if s.startswith("Contact:"):
            cur = "contact"
            continue
        if cur == "written":
            written.append(s)
        elif cur in parts:
            parts[cur].append(raw)
    width = line_width([l for ls in parts.values() for l in ls])
    out = []
    for (kind, side), body in parts.items():
        heading = next(k for k, v in SECTION.items() if v == (kind, side))
        out.append({"kind": kind, "side": side, "heading": heading, "paragraphs": paragraphs(body, width), "signers": signers(written)})
    if not written:
        raise SystemExit(f"{number}: no 'Written by' on the pamphlet page")
    return out


def arguments(layout, number):
    left, right = columns(layout)
    found = column_parts(left, number) + column_parts(right, number)
    kinds = sorted(a["kind"] for a in found)
    if kinds != ["against", "for", "rebuttal_against", "rebuttal_for"]:
        raise SystemExit(f"{number}: expected an argument and a rebuttal on each side, found {kinds}")
    order = ["for", "rebuttal_against", "against", "rebuttal_for"]
    return sorted(found, key=lambda a: order.index(a["kind"]))


def flat(text):
    """Text with line breaks and spacing evened out, for checking a quote against its source."""
    return re.sub(r"\s+", " ", re.sub(r"(?<!\s)-\s*\n\s*", "-", text)).strip()


def check_quotes(number, source, quotes, what):
    """Every paragraph must be in its source word for word, or nothing is written."""
    src = flat(source)
    for q in quotes:
        if flat(q) not in src:
            raise SystemExit(f"{number}: a {what} paragraph isn't word for word in its source: {q[:80]!r}")


def column_text(layout, side):
    left, right = columns(layout)
    return "\n".join(left if side == "supporters" else right)


# ---------------------------------------------------------------------------

def build(source_dir=None):
    pamphlet = pdf_text(PAMPHLET, source_dir=source_dir)
    measures = []
    for cfg in MEASURES:
        number = cfg["number"]
        letter = pdf_text(cfg["statement"], source_dir=source_dir)
        page = pdf_text(cfg["pamphlet_page"], layout=True, source_dir=source_dir)
        bt = ballot_title(letter)
        ex = explanatory(letter)
        fiscal = fiscal_summary(pamphlet, number)
        args = arguments(page, number)
        letter_body = "\n".join(l for l in letter.replace("\f", "\n").split("\n") if not LETTER_NOISE.match(l.strip()))
        check_quotes(number, letter_body, [bt["subject"], bt["description"], *ex["present"], *ex["effect"]], "ballot title or explanatory statement")
        check_quotes(number, re.sub(r"\nInitiative Measure (No\. )?[A-Z]{2}\d{2}-\d{3}\n", "\n", pamphlet), fiscal, "fiscal impact")
        for a in args:
            check_quotes(number, column_text(page, a["side"]), a["paragraphs"], f"{a['kind']} argument")
        measures.append({
            "id": number.lower(),
            "number": number,
            "label": f"Initiative Measure No. {number}",
            "kind": cfg["kind"],
            "scope": "statewide",
            "title": bt["subject"],
            "ballot_title": bt,
            "explanatory": ex,
            "fiscal_summary": fiscal,
            "arguments": args,
            "arguments_disclaimer": ARGUMENTS_DISCLAIMER,
            "links": {
                "guide": GUIDE,
                "pamphlet": PAMPHLET,
                "statement": cfg["statement"],
                "fiscal": cfg["fiscal"],
                "pamphlet_page": cfg["pamphlet_page"],
                "text": cfg["text"],
                "ballot_title_letter": cfg["ballot_title_letter"],
            },
            "source_url": cfg["pamphlet_page"],
            "source": "Voters' Pamphlet and the Attorney General's ballot title and explanatory statement (Washington Secretary of State)",
        })
    return {
        "_readme": "Generated by tools/build_wa_measures.py from the Washington Secretary of State's official documents. Do not edit by hand.",
        "election": ELECTION,
        "how_to_vote": {"state": HOW_TO_VOTE},
        "counties": {},
        "contests": [],
        "measures": measures,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="source_dir", default=None, help="read texts saved by an earlier run instead of downloading")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    data = build(args.source_dir)
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for m in data["measures"]:
        print(f"{m['number']}: {len(m['explanatory']['present'])}+{len(m['explanatory']['effect'])} explanatory paragraphs, "
              f"{sum(len(a['paragraphs']) for a in m['arguments'])} argument paragraphs, "
              f"{len(m['arguments'][0]['signers'])}/{len(m['arguments'][2]['signers'])} signers")


if __name__ == "__main__":
    main()
