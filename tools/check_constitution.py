"""Check data/constitution.json against the National Archives transcriptions.

    python3 tools/check_constitution.py            # fetches the three archives.gov pages
    python3 tools/check_constitution.py page.html  # or checks against saved copies (any number)
    python3 tools/check_constitution.py --print    # prints the Archives pages as plain text

Every quotable provision ("leaf" rows) must appear word for word in the
Archives text. Only whitespace, curly vs. straight quotes, and the Archives'
editorial marks (footnote stars, [brackets], "--" for a dash, a stray space
before punctuation) are ignored. Exits 1 and prints the closest Archives wording for anything that doesn't match. Standard library only.
"""
import html
import json
import re
import sys
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = [
    "https://www.archives.gov/founding-docs/constitution-transcript",
    "https://www.archives.gov/founding-docs/bill-of-rights-transcript",
    "https://www.archives.gov/founding-docs/amendments-11-27",
]


def normalize(text):
    text = html.unescape(text)
    text = text.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    # Editorial marks on the Archives pages: footnote stars, [brackets] around
    # superseded text, "--" typed for a dash, and a stray space before a comma.
    text = text.replace("\u00a0", " ").replace("*", "").replace("[", "").replace("]", "")
    text = text.replace("--", "\u2014")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s*\u2014\s*", "\u2014", text)
    text = re.sub(r" ([,;:.])", r"\1", text)
    return text.strip()


def page_text(raw):
    raw = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return normalize(raw)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; thepillory-text-check)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def closest(needle, hay):
    """The stretch of the Archives text most like the stored text."""
    words = hay.split(" ")
    n = len(needle.split(" "))
    first = needle.split(" ")[:4]
    best, best_ratio = "", 0.0
    for i in range(len(words)):
        if words[i : i + 2] != first[:2] and words[i : i + 1] != first[:1]:
            continue
        cand = " ".join(words[i : i + n + 3])
        ratio = SequenceMatcher(None, needle, cand[: len(needle) + 20]).ratio()
        if ratio > best_ratio:
            best, best_ratio = cand, ratio
    return best[: len(needle) + 40], best_ratio


def readable(raw):
    """The page as plain text with one paragraph per line (for --print)."""
    raw = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<(br|/p|/div|/h\d|/li)\b[^>]*>", "\n", raw)
    raw = html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))
    lines = [re.sub(r"[ \t\u00a0]+", " ", l).strip() for l in raw.split("\n")]
    return "\n".join(l for l in lines if l)


def main(args):
    if args and args[0] == "--print":
        for u in PAGES:
            print(f"===== {u}\n{readable(fetch(u))}")
        return 0
    sources = [Path(a).read_text(encoding="utf-8") for a in args] if args else [fetch(u) for u in PAGES]
    hay = " ".join(page_text(s) for s in sources)
    data = json.loads((ROOT / "data" / "constitution.json").read_text(encoding="utf-8"))
    leaves = [p for p in data["provisions"] if p["leaf"]]
    bad = 0
    for p in leaves:
        want = normalize(p["text"])
        if want in hay:
            continue
        bad += 1
        got, ratio = closest(want, hay)
        print(f"\nMISMATCH {p['id']} ({p['label']}), closest {ratio:.2f}")
        for tag, a1, a2, b1, b2 in SequenceMatcher(None, want, got[: len(want) + 20]).get_opcodes():
            if tag != "equal":
                print(f"  stored {want[max(0,a1-25):a2+25]!r}\n  archive {got[max(0,b1-25):b2+25]!r}")
    print(f"\n{len(leaves) - bad} of {len(leaves)} provisions match the National Archives text.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
