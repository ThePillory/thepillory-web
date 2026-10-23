#!/usr/bin/env python3
"""Builds data/ca-constitution.json: the California Constitution, word for word,
from the Legislature's official site (California Legislative Information,
leginfo.legislature.ca.gov), one row per section with a stable ID.

    python3 tools/build_ca_constitution.py           # fetch, parse, write
    python3 tools/build_ca_constitution.py --check   # fetch again and compare: exit 1 on any difference
    python3 tools/build_ca_constitution.py --probe   # print what one article page looks like

Rows, the same shape as data/constitution.json:
    {"id": "ca-art-13a-sec-1", "parent": "ca-art-13a", "kind": "section",
     "label": "Article XIII A, Section 1", "text": "...", "history": "(Sec. 1 added ...)",
     "leaf": true, "source_url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?..."}
Articles are rows too (kind "article", the article's title, no text). IDs never
change: an article's Roman numeral and letter, then the section number as
written ("1.5" becomes "1-5"). A repealed section that the site no longer lists
keeps its ID retired, never reused. Run weekly in the "California Constitution"
workflow (.github/workflows/ca-constitution.yml); this container's network
can't reach leginfo. Standard library only.
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "ca-constitution.json"
BASE = "https://leginfo.legislature.ca.gov/faces/"
TOC = BASE + "codesTOCSelected.xhtml?tocCode=CONS&tocTitle=+California+Constitution+-+CONS"
UA = "ThePillory/1.0 (+https://thepillory.co; civic data, one request at a time)"

# Every article of the California Constitution, in order (used when the table of
# contents can't be read; the TOC's own list wins when it can).
ARTICLES = ["I", "II", "III", "IV", "V", "VI", "VII", "IX", "X", "X A", "X B", "XI", "XII", "XIII", "XIII A", "XIII B",
            "XIII C", "XIII D", "XIV", "XV", "XVI", "XVIII", "XIX", "XIX A", "XIX B", "XIX C", "XIX D", "XX", "XXI",
            "XXII", "XXXIV", "XXXV"]
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as err:  # noqa: BLE001 (any network error: try again, then give up loudly)
            if i == tries - 1:
                raise RuntimeError(f"couldn't read {url}: {err}") from err
            time.sleep(3 * (i + 1))
    return ""


def roman(s):
    total = 0
    for i, ch in enumerate(s):
        v = ROMAN[ch]
        total += -v if i + 1 < len(s) and ROMAN[s[i + 1]] > v else v
    return total


def article_id(art):
    """'XIII A' -> 'ca-art-13a'."""
    num, _, letter = art.partition(" ")
    return f"ca-art-{roman(num)}{letter.lower()}"


def section_id(art, num):
    return f"{article_id(art)}-sec-{num.rstrip('.').replace('.', '-')}"


def text_of(fragment):
    """An HTML fragment as plain text: tags dropped, entities read, spaces collapsed."""
    t = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t).replace(" ", " ")
    return re.sub(r"[ \t]+", " ", t).strip()


def toc_articles(page):
    """The article list from the table of contents, in its order."""
    found = []
    for m in re.finditer(r"codes_displayText\.xhtml\?[^\"']*?article=([^\"'&]+)", page):
        art = urllib.parse.unquote_plus(html.unescape(m.group(1))).strip()
        if re.fullmatch(r"[IVXLC]+(?: [A-Z])?", art) and art not in found:
            found.append(art)
    return found


def parse_article(page, art):
    """(article title, [(section number, text, history)]) from one article's display page."""
    title_m = re.search(r"ARTICLE\s+" + re.escape(art).replace(r"\ ", r"\s+") + r"\.?\s*(?:&nbsp;|\s)*([^<\[]+)", page)
    title = text_of(title_m.group(1)).strip(" .") if title_m else ""
    sections = []
    # Each section starts with a heading like <h6 ...><a ...>SECTION 1.</a></h6> or "SEC. 2.5."
    heads = list(re.finditer(r"<h6[^>]*>(.*?)</h6>", page, flags=re.S | re.I))
    for i, h in enumerate(heads):
        label = text_of(h.group(1))
        m = re.fullmatch(r"(?:SECTION|SEC\.)\s*([0-9]+(?:\.[0-9]+)?[a-z]?)\.?", label, flags=re.I)
        if not m:
            continue
        body = page[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(page)]
        body = re.split(r'<div[^>]*id="(?:footer|codes_footer)', body)[0]
        paras = [text_of(p) for p in re.findall(r"<p\b[^>]*>(.*?)</p>", body, flags=re.S | re.I)]
        paras = [p for p in paras if p]
        history = ""
        if paras and re.fullmatch(r"\((?:Sec\.|Article|Added|Amended|Repealed)[\s\S]*\)", paras[-1]):
            history = paras.pop()
        sections.append((m.group(1), "\n\n".join(paras), history))
    return title, sections


def build():
    toc = get(TOC)
    arts = toc_articles(toc) or ARTICLES
    print(f"{len(arts)} articles in the table of contents: {', '.join(arts)}")
    rows, empty = [], []
    for art in arts:
        url = BASE + "codes_displayText.xhtml?lawCode=CONS&article=" + urllib.parse.quote(art)
        title, secs = parse_article(get(url), art)
        aid = article_id(art)
        rows.append({"id": aid, "parent": None, "kind": "article", "label": f"Article {art}" + (f": {title.title()}" if title else ""),
                     "text": "", "leaf": False, "source_url": url})
        if not secs:
            empty.append(art)
        for num, text, history in secs:
            if not text:
                continue
            rows.append({
                "id": section_id(art, num), "parent": aid, "kind": "section", "label": f"Article {art}, Section {num}",
                "text": text, "history": history, "leaf": True,
                "source_url": BASE + "codes_displaySection.xhtml?" + urllib.parse.urlencode({"lawCode": "CONS", "sectionNum": f"SEC. {num}.", "article": art}),
            })
        print(f"  Article {art}: {len(secs)} sections" + (f" ({title})" if title else ""))
        time.sleep(1)
    return rows, empty


def main():
    if "--probe" in sys.argv:
        page = get(BASE + "codes_displayText.xhtml?lawCode=CONS&article=XIII%20A")
        i = page.find("SECTION 1")
        print(len(page), "bytes; around SECTION 1:\n", page[max(0, i - 1500): i + 2500])
        print("TOC articles:", toc_articles(get(TOC)))
        return
    rows, empty = build()
    sections = [r for r in rows if r["kind"] == "section"]
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        sys.exit(f"Duplicate IDs: {dupes}")
    if empty or len(sections) < 400:
        sys.exit(f"Read too little to trust: {len(sections)} sections; articles with none: {empty}. Run --probe and fix the parser.")
    if "--check" in sys.argv:
        old = {r["id"]: r for r in json.loads(OUT.read_text())["provisions"]}
        diff = [r["id"] for r in sections if r["id"] in old and old[r["id"]]["text"] != r["text"]]
        gone = [i for i, r in old.items() if r["kind"] == "section" and i not in set(ids)]
        print(f"{len(diff)} sections changed, {len(gone)} no longer listed")
        for i in diff[:20]:
            print(" changed:", i)
        sys.exit(1 if diff or gone else 0)
    previous = json.loads(OUT.read_text())["provisions"] if OUT.exists() else []
    # A section the site no longer lists keeps its row (marked repealed), so its ID is never reused.
    retired = [{**r, "repealed": True} for r in previous if r["kind"] == "section" and r["id"] not in set(ids)]
    doc = {
        "about": "The California Constitution, word for word from California Legislative Information "
                 "(leginfo.legislature.ca.gov), the Legislature's official site. One row per section; "
                 "IDs are stable and never reused. Built by tools/build_ca_constitution.py.",
        "source_url": TOC,
        "read": time.strftime("%Y-%m-%d"),
        "provisions": rows + retired,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rows) - len(sections)} articles, {len(sections)} sections" + (f", {len(retired)} kept as repealed" if retired else ""))


if __name__ == "__main__":
    main()
