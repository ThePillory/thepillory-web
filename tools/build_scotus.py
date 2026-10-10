#!/usr/bin/env python3
"""The U.S. Supreme Court, from official sources, written to data/scotus/.
Standard library plus pdftotext (poppler-utils). Runs daily in the "Refresh
Supreme Court data" workflow. See docs/scotus.md.

    data/scotus/justices.json      the current justices: name, title, state,
                                   appointing President, oath date, the Senate's
                                   nomination and confirmation vote (roll call
                                   link), and their official biography's career
                                   sentences, word for word
    data/scotus/terms/<year>.json  each decision of the term: name, docket, date,
                                   the Reporter's one-line summary, the opinion
                                   PDF, the lineup (who wrote and who joined each
                                   opinion, from the opinion's own syllabus), and
                                   the constitutional provisions the opinion of
                                   the Court names, each with its own sentence
    data/scotus/current.json       this term: the cases granted for argument
                                   (argument date, question presented word for
                                   word from the Court's QP document), and which
                                   are decided
    data/scotus/disclosures.json   each justice's financial disclosure reports,
                                   gifts and reimbursements (CourtListener; only
                                   with COURTLISTENER_API_TOKEN)

Sources: supremecourt.gov (justices, biographies, slip opinions, granted list,
dockets, questions presented); senate.gov (Supreme Court nominations); and
CourtListener for disclosures. Nothing is written for a part whose source
couldn't be read; the previous file stays.

    python3 tools/build_scotus.py
    python3 tools/build_scotus.py --max-pdfs 40
"""
import argparse
import datetime
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "scotus"
SCOTUS = "https://www.supremecourt.gov"
SENATE = "https://www.senate.gov/legislative/nominations/SupremeCourtNominations1789present.htm"
CL = "https://www.courtlistener.com/api/rest/v4"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
OLDEST_TERM = 2010  # supremecourt.gov's slip-opinion pages go back about this far
# Bump when the opinion readers change: decisions read by an older version are read again.
PARSER_VERSION = 2

# The surname as the opinions print it (in capitals), for every justice who may
# appear in a lineup since OLDEST_TERM. A lineup name not here stops the parse.
SURNAMES = ["ROBERTS", "THOMAS", "ALITO", "SOTOMAYOR", "KAGAN", "GORSUCH", "KAVANAUGH", "BARRETT", "JACKSON",
            "BREYER", "GINSBURG", "KENNEDY", "SCALIA"]


def fetch(url, binary=False, headers=None, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
                return data if binary else data.decode("utf-8", "replace")
        except Exception as e:
            if attempt == tries - 1:
                raise
            time.sleep(4 * (attempt + 1))


def text_of(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def pdf_text(data, layout=False):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        args = ["pdftotext"] + (["-layout"] if layout else []) + [f.name, "-"]
        return subprocess.run(args, capture_output=True, check=True).stdout.decode("utf-8", "replace")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ---------------------------------------------------------------------------
# Justices


def parse_members(page):
    """Current justices from 'Justices 1789 to Present': rows with no termination date."""
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [text_of(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        anchor = re.search(r'biographies\.aspx#(\w+)', row)
        if len(cells) < 5 or not anchor:
            continue
        name, state, president, oath, ended = cells[:5]
        if ended.replace("\xa0", "").strip():
            continue
        out.append({"listed_name": name, "state": state, "appointed_by": president, "oath_date": oath, "bio_anchor": anchor.group(1)})
    # The Chief Justices' table comes first on the page; the current Chief is the one row from it.
    return out


def official_name(listed):
    """'Roberts, John G., Jr.' → 'John G. Roberts, Jr.'; 'Barrett, Amy Coney' → 'Amy Coney Barrett'."""
    parts = [p.strip() for p in listed.split(",")]
    last, first = parts[0], parts[1] if len(parts) > 1 else ""
    suffix = f", {parts[2]}" if len(parts) > 2 else ""
    return f"{first} {last}{suffix}".strip()


def justice_slug(listed):
    """'Roberts, John G., Jr.' → 'john-roberts'; 'Barrett, Amy Coney' → 'amy-coney-barrett'."""
    parts = [p.strip() for p in listed.split(",")]
    given = [w for w in (parts[1] if len(parts) > 1 else "").split() if not re.fullmatch(r"[A-Z]\.", w)]
    return slugify(" ".join(given + [parts[0]]))


PERSONAL = re.compile(r"\b(married|wife|husband|children|child|son|daughter|grandchildren)\b", re.I)


def parse_bios(page):
    """{anchor: [career sentences]} from the official biographies, word for word; family sentences left out."""
    out = {}
    blocks = re.split(r'<a[^>]+(?:name|id)="(\w+)"', page)
    for i in range(1, len(blocks) - 1, 2):
        anchor, body = blocks[i], text_of(blocks[i + 1])
        body = re.split(r"\b(?:Back to top|Retired Justices)\b", body)[0]
        # From the name onward: "<Name>, <Title>, was born …"
        m = re.search(r"([A-Z][A-Za-z.\- ]+(?:, Jr\.)?), (Chief Justice of the United States|Associate Justice),\s+(was born.*)", body)
        if not m:
            continue
        # A sentence ends at a period before a capital, but not after an initial ("Henry J. Friendly") or "U.S."
        sentences = re.split(r"(?<! [A-Z]\.)(?<!U\.S\.)(?<=[.])\s+(?=[A-Z])", m.group(3))
        keep = [s.strip() for s in sentences if s.strip() and not PERSONAL.search(s)]
        heading = f"{m.group(1)}, {m.group(2)}"
        # The first sentence as the biography prints it: "<Name>, <Title>, was born …".
        if keep and keep[0].startswith("was born"):
            keep[0] = f"{heading}, {keep[0]}"
        out[anchor] = {"heading": heading, "sentences": keep}
    return out


def parse_senate(page):
    """{surname-first name: {predecessor, nominated, nomination_url, vote, roll_call_url, result_date}} from the Senate's table."""
    out = {}
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        cells = [c for c in cells if "vert_content_break" not in c]
        if len(cells) < 4:
            continue
        name = text_of(cells[0])
        nom = re.search(r'href="([^"]+)"[^>]*>([^<]+)</a>', cells[2])
        vote_cell = cells[3]
        tally = re.match(r"\s*(\d+-\d+)", text_of(vote_cell))
        roll = re.search(r'href="([^"]+)"[^>]*>\s*(\d+)\s*<', vote_cell, re.I)
        result = text_of(cells[4]) if len(cells) > 4 else ""
        if not name or not nom:
            continue
        if name in out:  # the same person nominated twice: keep both, apart
            name = f"{name} ({len([k for k in out if k.startswith(name)]) + 1})"
        out[name] = {
            "predecessor": text_of(cells[1]),
            "nominated": text_of(nom.group(2)),
            "nomination_url": html.unescape(nom.group(1)),
            "vote": tally.group(1) if tally else text_of(vote_cell),
            "roll_call_url": html.unescape(roll.group(1)) if roll else None,
            "roll_call": roll.group(2) if roll else None,
            "result": result,
        }
    return out


def build_justices():
    members = parse_members(fetch(f"{SCOTUS}/about/members_text.aspx"))
    bios = parse_bios(fetch(f"{SCOTUS}/about/biographies.aspx"))
    senate = parse_senate(fetch(SENATE))
    if len(members) != 9:
        raise SystemExit(f"Justices: expected 9 current justices, found {len(members)}; not written")
    out = []
    for i, m in enumerate(members):
        listed = m["listed_name"]
        # The Senate lists "Roberts, John G., Jr." as "Roberts, John G., Jr." and "Thomas, Clarence " with a space.
        last, first = listed.split(",")[0].lower(), listed.split(",")[1].strip().split()[0].lower()
        # The confirmation that seated them (Roberts was first nominated for another seat, withdrawn).
        conf = next((v for k, v in senate.items() if k.lower().startswith(last + ",") and first in k.lower() and v["result"].startswith("C")), None)
        bio = bios.get(m["bio_anchor"], {})
        out.append({
            "slug": justice_slug(listed),
            "name": official_name(listed),
            "title": "Chief Justice of the United States" if i == 0 else "Associate Justice",
            "state": m["state"],
            "appointed_by": m["appointed_by"],
            "oath_date": m["oath_date"],
            "senate": conf,
            "biography": bio.get("sentences", []),
            "sources": {
                "members": f"{SCOTUS}/about/members_text.aspx",
                "biography": f"{SCOTUS}/about/biographies.aspx#{m['bio_anchor']}",
                "senate": SENATE,
            },
        })
    # Seniority: the Chief Justice, then by oath date.
    chief, rest = out[0], sorted(out[1:], key=lambda j: datetime.datetime.strptime(j["oath_date"], "%B %d, %Y"))
    return [chief] + rest


# ---------------------------------------------------------------------------
# Decisions


def parse_slip_list(page):
    """Rows of a term's slip-opinion table: R-number, date, docket, name, the Reporter's summary, author code, PDF."""
    out = []
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        cells = [text_of(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        link = re.search(r"href='(/opinions/\d+pdf/[^']+\.pdf)'(?:[^>]*title=\"([^\"]*)\")?", row)
        if len(cells) < 6 or not link:
            continue
        r, date, docket, name, author, part = cells[:6]
        m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2})", date)
        out.append({
            "r": r,
            "date": f"20{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else date,
            "docket": docket,
            "name": name,
            "summary": html.unescape(link.group(2) or "").strip(),
            "author_code": author,
            "pdf": SCOTUS + link.group(1),
        })
    return out


def unwrap(t):
    """pdftotext output as running text: hyphenated line breaks joined, whitespace collapsed."""
    t = re.sub(r"(\w)[‐\-]\s*\n\s*(\w)", r"\1\2", t)
    return re.sub(r"\s+", " ", t).strip()


NAME = r"(?:" + "|".join(SURNAMES) + r")"
WHO = rf"{NAME}(?:, C\. J\.| , J\.|, J\.|, JJ\.)?"


def names_in(s):
    return [n.title() for n in re.findall(NAME, s)]


LINEUP_START = re.compile(rf"({NAME}, (?:C\. )?J\., delivered the opinion|PER CURIAM|{NAME}, (?:C\. )?J\., announced the judgment)")


def lineup_paragraph(text):
    """The syllabus's last paragraph: who delivered the opinion, and who filed or joined what."""
    t = unwrap(without_headers(text))
    m = LINEUP_START.search(t)
    if not m:
        return None
    rest = t[m.start():]
    # It ends where the opinion itself begins (a page header or the opinion's caption).
    # It ends where the opinion itself begins: its caption or the slip notice (page headers are already out).
    end = re.search(r"\s(?:NOTICE: This opinion|SUPREME COURT OF THE UNITED STATES|PRELIMINARY PRINT)", rest)
    return rest[: end.start() if end else 1200].strip()


def parse_lineup(paragraph):
    """
    {unanimous, justices: [{justice, roles, wrote}]} from the lineup paragraph. Roles:
    majority, majority in part, concurrence, concurring in part, concurrence in the
    judgment, concurring in part and dissenting in part, dissenting in part, dissent,
    took no part. Only what the paragraph states; a sentence it doesn't recognize is
    left out rather than guessed.
    """
    if not paragraph:
        return []
    roles = {}  # justice -> {role: wrote?}

    def add(names, role, wrote=False):
        for n in names:
            r = roles.setdefault(n, {})
            r[role] = r.get(role, False) or wrote

    def joiners(s):
        """[(names, partial)] for each "in which X joined[ as to Parts …]" clause."""
        out = []
        for m in re.finditer(r"in which (.*?) joined( as to [^.;]*?(?=,? and in which|[.;]|$))?", s):
            out.append((names_in(m.group(1)), bool(m.group(2))))
        return out

    unanimous = False
    for s in re.split(r"(?<=\.)\s+(?=[A-Z]{3,}, (?:C\. )?J\.|[A-Z]{3,} and [A-Z]{3,}|[A-Z]{3,}, [A-Z]{3,})", paragraph):
        head = re.split(r" delivered| filed| concurred| dissented| took no part| announced", s)[0]
        authors = names_in(head)
        joined = joiners(s)
        if "unanimous Court" in s:
            add(authors, "majority", True)
            unanimous = True
            continue
        if re.search(r"delivered the opinion of the Court|announced the judgment of the Court", s):
            add(authors, "majority", True)
            for names, partial in joined:
                add(names, "majority in part" if partial else "majority")
            continue
        if "took no part" in s:
            add(authors, "took no part")
            continue
        wrote = "filed" in s
        role = None
        if re.search(r"concurring in part and dissenting in part|concurred in part and dissented in part", s):
            role = "concurring in part and dissenting in part"
        elif re.search(r"concurring in the judgment|concurred in the judgment", s):
            role = "concurrence in the judgment"
        elif re.search(r"dissenting in part|dissented in part", s):
            role = "dissenting in part"
        elif re.search(r"concurring in part|concurred in part", s):
            role = "concurring in part"
        elif re.search(r"concurring opinion|concurring opinions", s):
            role = "concurrence"
        elif re.search(r"dissenting opinion|dissenting opinions|dissented", s):
            role = "dissent"
        if role:
            add(authors, role, wrote)
            for names, _ in joined:
                add(names, role)
    out = [{"justice": j, "roles": sorted(r), "wrote": sorted(k for k, v in r.items() if v)} for j, r in roles.items()]
    return {"unanimous": unanimous, "justices": out} if out else []


# Provisions the opinion of the Court names, by the names opinions use. Only
# names that point at one provision; "Due Process Clause" (Fifth or Fourteenth)
# and "Ex Post Facto Clause" (two places) aren't mapped.
PROVISIONS = [
    (r"First Amendment|Establishment Clause|Free Exercise Clause|Free Speech Clause", "amend-1"),
    (r"Second Amendment", "amend-2"),
    (r"Fourth Amendment", "amend-4"),
    (r"Fifth Amendment|Takings Clause|Double Jeopardy Clause|Self-Incrimination Clause", "amend-5"),
    (r"Sixth Amendment|Confrontation Clause", "amend-6"),
    (r"Seventh Amendment", "amend-7"),
    (r"Eighth Amendment|Excessive Fines Clause", "amend-8"),
    (r"Tenth Amendment", "amend-10"),
    (r"Eleventh Amendment", "amend-11"),
    (r"Fourteenth Amendment|Equal Protection Clause", "amend-14"),
    (r"Fifteenth Amendment", "amend-15"),
    (r"Commerce Clause", "art-1-sec-8-cl-3"),
    (r"Spending Clause", "art-1-sec-8-cl-1"),
    (r"Necessary and Proper Clause", "art-1-sec-8-cl-18"),
    (r"Elections Clause", "art-1-sec-4-cl-1"),
    (r"Appointments Clause", "art-2-sec-2-cl-2"),
    (r"Electors Clause", "art-2-sec-1-cl-2"),
    (r"Take Care Clause", "art-2-sec-3"),
    (r"Supremacy Clause", "art-6-cl-2"),
    (r"Full Faith and Credit Clause", "art-4-sec-1"),
    (r"Article III(?!I)", "art-3"),
    (r"Article II(?!I)", "art-2"),
]


HEADER = re.compile(r"^\s*(?:Opinion of the Court|Syllabus|Cite as:.*|\(Slip Opinion\).*|\d+\s+[A-Z][A-Z .,'&\-]+ v\. [A-Z .,'&\-]+|[A-Z][A-Z .,'&\-]+ v\. [A-Z .,'&\-]+\s+\d+|\d+|(?:%s), (?:C\. )?J\., (?:concurring|dissenting).*|Opinion of (?:%s), (?:C\. )?J\.)\s*$" % ("|".join(SURNAMES), "|".join(SURNAMES)))


def without_headers(text):
    """The text with page headers, running case names and page numbers taken out."""
    return "\n".join(l for l in text.splitlines() if not HEADER.match(l))


def court_opinion_text(text):
    """The opinion of the Court: after the syllabus, before the first separate opinion's page header."""
    start = re.search(r"Opinion of the Court|PER CURIAM", text)
    t = text[start.end():] if start else text
    end = re.search(rf"\n\s*(?:{NAME}, (?:C\. )?J\., (?:concurring|dissenting))", t[200:])
    return unwrap(without_headers(t[: end.start() + 200] if end else t))


def provisions_named(text, constitution_ids):
    """[{id, quote}]: each mapped provision the opinion of the Court names, with the first sentence that names it."""
    body = court_opinion_text(text)
    out = []
    for pattern, pid in PROVISIONS:
        if pid not in constitution_ids or any(p["id"] == pid for p in out):
            continue
        m = re.search(rf"\b(?:{pattern})\b", body)
        if not m:
            continue
        start = max(body.rfind(". ", 0, m.start()), body.rfind("? ", 0, m.start()))
        start = start + 2 if start >= 0 else 0
        end_m = re.search(r"[.?](?=\s+[A-Z“\"(]|\s*$)", body[m.end():])
        end = m.end() + end_m.end() if end_m else len(body)
        quote = body[start:end].strip()
        out.append({"id": pid, "quote": quote if 20 <= len(quote) <= 450 else None})
    return out[:4]


def build_term(term, previous, constitution_ids, budget):
    """One term's decisions. PDFs already read (same URL) are kept from the previous file."""
    try:
        page = fetch(f"{SCOTUS}/opinions/slipopinion/{str(term)[2:]}")
    except Exception as e:
        print(f"OT{term}: {type(e).__name__}", file=sys.stderr)
        return None, budget
    rows = parse_slip_list(page)
    if not rows:
        return None, budget
    known = {c["pdf"]: c for c in (previous or {}).get("cases", [])}
    cases = []
    for row in rows:
        old = known.get(row["pdf"])
        if old and old.get("parser") == PARSER_VERSION:
            cases.append({**old, **row})
            continue
        if budget <= 0:
            cases.append({**row, "pending_read": True})
            continue
        budget -= 1
        try:
            # Layout mode keeps small-capital names whole ("ROBERTS, C. J."); the plain mode breaks some apart.
            text = pdf_text(fetch(row["pdf"], binary=True), layout=True)
        except Exception as e:
            print(f"OT{term} {row['docket']}: {type(e).__name__}", file=sys.stderr)
            cases.append({**row, "pending_read": True})
            continue
        lineup_text = lineup_paragraph(text)
        cases.append({
            **row,
            "parser": PARSER_VERSION,
            "lineup_text": lineup_text,
            "lineup": parse_lineup(lineup_text),
            "provisions": provisions_named(text, constitution_ids),
        })
        time.sleep(0.5)
    return {"term": term, "source_url": f"{SCOTUS}/opinions/slipopinion/{str(term)[2:]}", "cases": cases}, budget


# ---------------------------------------------------------------------------
# This term


def current_term(today=None):
    """The October Term in session: it starts the first Monday in October."""
    today = today or datetime.date.today()
    oct1 = datetime.date(today.year, 10, 1)
    first_monday = oct1 + datetime.timedelta(days=(7 - oct1.weekday()) % 7)
    return today.year if today >= first_monday else today.year - 1


def parse_granted(text):
    """Cases from the Granted & Noted list: docket(s), name, lower court, granted date, argument date."""
    out = []
    blocks = re.split(r"\n\s*\n", text)
    for b in blocks:
        lines = [l for l in b.splitlines() if l.strip()]
        heads = [re.match(r"\s*(\d{2}-\d+)(?:\)\d+)?\s+[A-Z]{3}\s+(.+?)\s*$", l) for l in lines]
        heads = [h for h in heads if h]
        if not heads:
            continue
        rest = " ".join(lines)
        granted = re.search(r"Granted:\s*(\d{1,2}/\d{1,2}/\d{2})", rest)
        argued = re.search(r"Argument Date:\s*(\d{1,2}/\d{1,2}/\d{2})", rest)
        court = re.search(r"Court:\s*(.+?)\s{2,}", " ".join(lines) + "  ")
        out.append({
            "dockets": [h.group(1) for h in heads],
            "name": " / ".join(h.group(2).strip() for h in heads),
            "lower_court": court.group(1).strip() if court else "",
            "granted": granted.group(1) if granted else "",
            "argument_date": argued.group(1) if argued else "",
        })
    return out


def parse_qp(text):
    """The question(s) presented, word for word: after 'QUESTION(S) PRESENTED:' up to the Court's order line."""
    m = re.search(r"QUESTIONS? PRESENTED:?\s*(.*?)(?:\n\s*(?:THE PETITION|CERT\. GRANTED|LIMITED TO|PETITION GRANTED|MOTION|CONSOLIDATED|$))", text, re.S)
    if not m:
        return []
    paras = [unwrap(p) for p in re.split(r"\n\s*\n|\n {5,}(?=\S)", m.group(1)) if p.strip()]
    return [p for p in paras if p]


def build_current(term, decided_dockets):
    text = pdf_text(fetch(f"{SCOTUS}/orders/{str(term)[2:]}grantednotedlist.pdf", binary=True), layout=True)
    cases = parse_granted(text)
    for c in cases:
        d = c["dockets"][0]
        c["docket_url"] = f"{SCOTUS}/search.aspx?filename=/docket/docketfiles/html/public/{d}.html"
        c["decided"] = any(x in decided_dockets for x in c["dockets"])
        try:
            dj = json.loads(fetch(f"{SCOTUS}/RSS/Cases/JSON/{d}.json"))
            qp = dj.get("QPLink")
            if qp:
                c["qp_url"] = urllib.parse.urljoin(f"{SCOTUS}/docket/", qp)
                c["question_presented"] = parse_qp(pdf_text(fetch(c["qp_url"], binary=True), layout=True))
        except Exception as e:
            print(f"OT{term} {d}: {type(e).__name__}", file=sys.stderr)
        time.sleep(0.5)
    return {"term": term, "source_url": f"{SCOTUS}/orders/grantednotedlists.aspx", "cases": cases}


# ---------------------------------------------------------------------------
# Disclosures (CourtListener)


def cl_get(path, token):
    return json.loads(fetch(f"{CL}{path}", headers={"Authorization": f"Token {token}"}))


def build_disclosures(justices, token):
    out = {}
    for j in justices:
        last = j["name"].split(",")[0].split()[-1]
        people = cl_get(f"/people/?name_last={urllib.parse.quote(last)}&positions__court=scotus", token).get("results", [])
        first = j["name"].split()[0]
        person = next((p for p in people if p.get("name_first") == first), None)
        if not person:
            continue
        reports = []
        for fd in cl_get(f"/financial-disclosures/?person={person['id']}&order_by=-year", token).get("results", [])[:20]:
            gifts = cl_get(f"/gifts/?financial_disclosure={fd['id']}", token).get("results", [])
            reimb = cl_get(f"/reimbursements/?financial_disclosure={fd['id']}", token).get("results", [])
            reports.append({
                "year": fd.get("year"),
                "report_url": fd.get("filepath") or fd.get("download_filepath"),
                "gifts": [{"source": g.get("source"), "description": g.get("description"), "value": g.get("value")} for g in gifts],
                "reimbursements": [{"source": r.get("source"), "dates": r.get("date_raw"), "location": r.get("location"), "purpose": r.get("purpose")} for r in reimb],
                "source_url": f"https://www.courtlistener.com/person/{person['id']}/{person.get('slug', '')}/disclosures/",
            })
            time.sleep(0.3)
        out[j["slug"]] = reports
    return out


# ---------------------------------------------------------------------------


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pdfs", type=int, default=150, help="opinion PDFs to read this run (the rest wait for the next)")
    args = ap.parse_args()
    constitution_ids = {p["id"] for p in json.loads((ROOT / "data" / "constitution.json").read_text())["provisions"]}
    built = datetime.date.today().isoformat()

    justices = build_justices()
    write(OUT / "justices.json", {"built_on": built, "justices": justices})
    print(f"Justices: {', '.join(j['name'] for j in justices)}")

    term_now = current_term()
    budget = args.max_pdfs
    terms = []
    decided_now = set()
    for term in range(term_now, OLDEST_TERM - 1, -1):
        path = OUT / "terms" / f"{term}.json"
        previous = json.loads(path.read_text()) if path.exists() else None
        data, budget = build_term(term, previous, constitution_ids, budget)
        if data is None:
            if term < term_now:
                break  # past the oldest term supremecourt.gov lists
            continue
        write(path, {**data, "built_on": built})
        terms.append(term)
        if term == term_now:
            decided_now = {c["docket"] for c in data["cases"]}
        unread = sum(1 for c in data["cases"] if c.get("pending_read"))
        signed = [c for c in data["cases"] if c.get("author_code") != "PC" and not c.get("pending_read")]
        lineups = sum(1 for c in signed if c.get("lineup"))
        print(f"OT{term}: {len(data['cases'])} decisions, lineups read for {lineups} of {len(signed)} signed{f', {unread} to read next run' if unread else ''}")
    write(OUT / "index.json", {"built_on": built, "current_term": term_now, "terms": terms})

    try:
        current = build_current(term_now, decided_now)
        write(OUT / "current.json", {**current, "built_on": built})
        print(f"OT{term_now} granted: {len(current['cases'])} cases")
    except Exception as e:
        print(f"Granted list OT{term_now}: {type(e).__name__}; current.json not changed", file=sys.stderr)

    token = os.environ.get("COURTLISTENER_API_TOKEN")
    if token:
        disclosures = build_disclosures(justices, token)
        write(OUT / "disclosures.json", {"built_on": built, "source": "CourtListener (Free Law Project), from the judiciary's financial disclosure reports", "justices": disclosures})
        print(f"Disclosures: {sum(len(v) for v in disclosures.values())} reports")
    else:
        print("Disclosures: COURTLISTENER_API_TOKEN not set; skipped")


if __name__ == "__main__":
    main()
