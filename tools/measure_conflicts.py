"""Official text saying a ballot measure can void, or be voided by, another
measure on the same ballot: the "conflicts" field of each measure in
data/elections/<id>.json, shown as "Conflicts with other measures" on the
"Just the facts" card (functions/_lib/measure-facts.js).

Word for word from the official source, never written here:
  1. California: the Legislative Analyst's analysis. Its section on other
     measures on the same ballot is a figure ("Potential Interactions With
     Other Propositions"), whose text the guide's web page carries as the
     figure's text description (the image's alt text); a paragraph saying the
     same is read too.
  2. Otherwise the conflict line of the Attorney General's official summary
     ("States that other voter-approved measures appearing on the same ballot
     are void if they conflict with this measure ..."), which names no measure.
  3. The "sections" format (tools/build_state_measures.py): any paragraph of a
     measure's official sections that speaks of the same ballot and names
     another measure on it by its label.

Each entry: {text, title?, measures: [ids it names], source, source_url}.
Standard library only; tested in tools/test_measure_conflicts.py.
"""
import html
import re

SAME_BALLOT = re.compile(r"\bsame (?:statewide )?ballot\b", re.I)
VOID_LINE = re.compile(r"\bsame ballot\b.*\b(?:void|conflict)", re.I)
FIG_LABEL = re.compile(r"^Proposition \d+ Figure \d+\.\s*", re.I)
FIG_TITLE = re.compile(r"^(Potential Interactions With Other Propositions)[.:]\s*", re.I)
ANALYST = "Legislative Analyst's analysis, Official Voter Information Guide"


def _text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def proposition_numbers(text):
    """Every proposition number a sentence names: "Proposition 41 or 42" -> ["41", "42"]."""
    out = []
    for m in re.finditer(r"\bPropositions?\s+(\d{1,3}(?:(?:\s*,\s*|\s+(?:or|and)\s+|,\s*(?:or|and)\s+)\d{1,3})*)", text):
        for n in re.findall(r"\d{1,3}", m.group(1)):
            if n not in out:
                out.append(n)
    return out


def ca_analysis_conflicts(page, own, numbers, url):
    """The analysis's passages about other propositions on the same ballot that name one of `numbers`."""
    found = []
    pieces = [html.unescape(a) for a in re.findall(r'<img[^>]*\balt="([^"]*)"', page, re.I)]
    pieces += [_text(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", page, re.S | re.I)]
    for raw in pieces:
        t = re.sub(r"\s+", " ", raw).strip()
        if not SAME_BALLOT.search(t):
            continue
        names = [n for n in proposition_numbers(t) if n != str(own) and n in numbers]
        if not names:
            continue
        t = FIG_LABEL.sub("", t)
        title = None
        m = FIG_TITLE.match(t)
        if m:
            title, t = m.group(1), t[m.end():]
        if any(c["text"] == t for c in found):
            continue
        found.append({"text": t, **({"title": title} if title else {}), "measures": [f"prop-{n}" for n in names],
                      "source": ANALYST, "source_url": url})
    return found


def ca_summary_conflicts(ag_summary, url):
    """The official summary's conflict line, when the analysis names no other measure."""
    return [{"text": s, "measures": [], "source": "Attorney General's official title and summary", "source_url": url}
            for s in ag_summary or [] if VOID_LINE.search(s)]


def ca_conflicts(n, analysis_page, analysis_url, ag_summary, ts_url, numbers):
    """1, else 2."""
    return ca_analysis_conflicts(analysis_page or "", n, numbers, analysis_url) or ca_summary_conflicts(ag_summary, ts_url)


def sections_conflicts(m, measures):
    """A "sections" measure's paragraphs about the same ballot that name another of `measures` by its label."""
    out = []
    labels = {x["label"]: x["id"] for x in measures if x.get("label") and x["id"] != m["id"]}
    for sec in m.get("sections") or []:
        for p in sec.get("paragraphs") or []:
            if not isinstance(p, str) or not SAME_BALLOT.search(p):
                continue
            names = [i for label, i in labels.items() if re.search(rf"\b{re.escape(label)}\b", p)]
            if names:
                out.append({"text": p, "measures": names, "source": sec.get("by") or m.get("source") or "Official source",
                            "source_url": m.get("source_url")})
    return out
