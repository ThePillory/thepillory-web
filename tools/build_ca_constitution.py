#!/usr/bin/env python3
"""Builds data/ca-constitution.json: the California Constitution, word for word,
from the Legislature's own database export (California Legislative
Information's public download site, downloads.leginfo.legislature.ca.gov: the
daily "pubinfo" snapshot's law section table, law code CONS), one row per
section with a stable ID. The leginfo pages themselves refuse GitHub's
servers; the download site serves the same law text.

    python3 tools/build_ca_constitution.py           # download, read, write
    python3 tools/build_ca_constitution.py --check   # read again and compare: exit 1 on any difference
    python3 tools/build_ca_constitution.py --probe   # print the table's first CONS rows and one section's XML

Rows, the same shape as data/constitution.json:
    {"id": "ca-art-13a-sec-1", "parent": "ca-art-13a", "kind": "section",
     "label": "Article XIII A, Section 1", "text": "...", "history": "(Added June 6, 1978, by Prop. 13...)",
     "leaf": true, "source_url": "https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CONS&article=XIII%20A"}
Articles are rows too (kind "article", no text). IDs never change: the
article's Roman numeral and letter, then the section number as written ("1.5"
becomes "1-5"). A section no longer in the table keeps its row, marked
repealed, so its ID is never reused. Run weekly in the "California
Constitution" workflow (.github/workflows/ca-constitution.yml). Standard library only.
"""
import html
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "ca-constitution.json"
DOWNLOADS = "https://downloads.leginfo.legislature.ca.gov/"
SITE = "https://leginfo.legislature.ca.gov/faces/"
UA = "ThePillory/1.0 (+https://thepillory.co; civic data)"
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}
# LAW_SECTION_TBL columns (pubinfo_Readme.pdf).
COLS = ["id", "law_code", "section_num", "op_statues", "op_chapter", "op_section", "effective_date", "law_section_version_id",
        "division", "title", "part", "chapter", "article", "history", "content_xml", "active_flg", "trans_uid", "trans_update"]


def latest_snapshot():
    """The newest pubinfo_daily_<Day>.zip on the download site."""
    listing = urllib.request.urlopen(urllib.request.Request(DOWNLOADS, headers={"User-Agent": UA}), timeout=60).read().decode("utf-8", "replace")
    rows = re.findall(r'href="(pubinfo_daily_[A-Za-z]{3}\.zip)"[^\n]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', listing)
    if not rows:
        sys.exit("No pubinfo_daily_*.zip on the download site")
    return DOWNLOADS + max(rows, key=lambda r: r[1])[0]


def download(url, path):
    print("Downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


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


def fields(line):
    """One pubinfo row: tab-separated, each value in backticks (NULL bare)."""
    return [v[1:-1] if v.startswith("`") and v.endswith("`") else ("" if v == "NULL" else v) for v in line.rstrip("\r\n").split("\t")]


def section_text(xml):
    """A section's content XML as plain text, one paragraph per <p>."""
    paras = [text_of(p) for p in re.findall(r"<p\b[^>]*>(.*?)</p>", xml, flags=re.S | re.I)]
    return "\n\n".join(p for p in paras if p)


def article_of(raw):
    """The ARTICLE column ('XIII A', 'ARTICLE XIII A', 'XIII A.') as 'XIII A', or None."""
    m = re.fullmatch(r"(?:ARTICLE\s+)?([IVXLC]+)(?:\s*([A-Z]))?\.?", raw.strip().upper())
    return f"{m.group(1)} {m.group(2)}" if m and m.group(2) else (m.group(1) if m else None)


def read_snapshot(zpath, probe=False):
    z = zipfile.ZipFile(zpath)
    names = {n.lower(): n for n in z.namelist()}
    table = next((names[n] for n in names if n.endswith("law_section_tbl.dat")), None)
    if not table:
        sys.exit(f"No LAW_SECTION_TBL in the snapshot: {sorted(names)[:30]}")
    rows = []
    with z.open(table) as f:
        for line in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
            v = fields(line)
            if len(v) >= 16 and v[1] == "CONS":
                rows.append(dict(zip(COLS, v)))
    if probe:
        print(len(rows), "CONS rows; the first three:")
        for r in rows[:3]:
            print(json.dumps(r)[:800])
        if rows:
            lob = rows[0]["content_xml"]
            name = names.get(lob.lower()) or next((names[n] for n in names if n.endswith(lob.lower())), None)
            print("content", lob, "->", name)
            if name:
                print(z.read(name).decode("utf-8", "replace")[:2000])
        return [], z
    return rows, z


def build(zpath):
    rows, z = read_snapshot(zpath)
    names = {n.lower(): n for n in z.namelist()}
    by_art, bad = {}, []
    for r in rows:
        if r["active_flg"] not in ("Y", ""):
            continue
        art = article_of(r["article"])
        num = re.sub(r"^(?:SEC(?:TION)?\.?\s*)", "", r["section_num"].strip(), flags=re.I).rstrip(".").strip()
        if not art or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?[a-z]?", num):
            bad.append((r["article"], r["section_num"]))
            continue
        lob = r["content_xml"]
        name = names.get(lob.lower()) or next((names[n] for n in names if n.endswith(lob.lower())), None)
        text = section_text(z.read(name).decode("utf-8", "replace")) if name else ""
        if not text:
            bad.append((r["article"], r["section_num"], "no text"))
            continue
        by_art.setdefault(art, []).append((num, text, text_of(r["history"])))
    if bad:
        print(f"{len(bad)} rows not read: {bad[:10]}")
    order = lambda a: (roman(a.split()[0]), a)  # noqa: E731
    secnum = lambda n: [float(x) if x.replace(".", "").isdigit() else 0 for x in re.findall(r"[0-9]+(?:\.[0-9]+)?", n)]  # noqa: E731
    out = []
    for art in sorted(by_art, key=order):
        aid = article_id(art)
        url = SITE + "codes_displayText.xhtml?lawCode=CONS&article=" + urllib.parse.quote(art)
        out.append({"id": aid, "parent": None, "kind": "article", "label": f"Article {art}", "text": "", "leaf": False, "source_url": url})
        for num, text, history in sorted(by_art[art], key=lambda s: secnum(s[0])):
            out.append({"id": section_id(art, num), "parent": aid, "kind": "section", "label": f"Article {art}, Section {num}",
                        "text": text, "history": history, "leaf": True, "source_url": url})
        print(f"  Article {art}: {len(by_art[art])} sections")
    return out, bad


def main():
    zpath = Path("/tmp/pubinfo.zip")
    if not zpath.exists():
        download(latest_snapshot(), zpath)
    if "--probe" in sys.argv:
        read_snapshot(zpath, probe=True)
        return
    rows, bad = build(zpath)
    sections = [r for r in rows if r["kind"] == "section"]
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        sys.exit(f"Duplicate IDs: {sorted({i for i in ids if ids.count(i) > 1})}")
    if len(sections) < 400:
        sys.exit(f"Read too little to trust: {len(sections)} sections. Run --probe and fix the reader.")
    if "--check" in sys.argv:
        old = {r["id"]: r for r in json.loads(OUT.read_text())["provisions"]}
        diff = [r["id"] for r in sections if r["id"] in old and old[r["id"]]["text"] != r["text"]]
        gone = [i for i, r in old.items() if r["kind"] == "section" and not r.get("repealed") and i not in set(ids)]
        print(f"{len(diff)} sections changed, {len(gone)} no longer listed")
        sys.exit(1 if diff or gone else 0)
    previous = json.loads(OUT.read_text())["provisions"] if OUT.exists() else []
    retired = [{**r, "repealed": True} for r in previous if r["kind"] == "section" and r["id"] not in set(ids)]
    doc = {
        "about": "The California Constitution, word for word from the Legislature's own database (California Legislative "
                 "Information, downloads.leginfo.legislature.ca.gov, law code CONS). One row per section; IDs are stable "
                 "and never reused. Built by tools/build_ca_constitution.py.",
        "source_url": SITE + "codesTOCSelected.xhtml?tocCode=CONS&tocTitle=+California+Constitution+-+CONS",
        "read": time.strftime("%Y-%m-%d"),
        "provisions": rows + retired,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rows) - len(sections)} articles, {len(sections)} sections" + (f", {len(retired)} kept as repealed" if retired else ""))


if __name__ == "__main__":
    main()
