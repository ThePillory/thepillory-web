#!/usr/bin/env python3
"""Temporary: print the layout of states' official ballot-measure guides (text
and links), so builders can be written for them. Run in GitHub Actions (the
"Probe measure guides" workflow); writes nothing."""
import html, re, subprocess, sys, tempfile, urllib.request

UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
DOCS = [
    ("MA", "https://www.sec.state.ma.us/divisions/elections/research-and-statistics/2026-Information-for-voters/2026-ballot-questions.htm"),
    ("CO", "https://content.leg.colorado.gov/sites/default/files/2026-bluebook-english-accessible_1.pdf"),
    ("AZ", "https://azsos.gov/elections/ballot-measures"),
    ("AZ", "https://www.azleg.gov/ballot-measures-2026-analyses/"),
    ("FL", "https://files.floridados.gov/media/711369/eng-2026-booklet-constitutional-amendpub-updated-20260903.pdf"),
    ("MI", "https://www.michigan.gov/sos/-/media/Project/Websites/sos/BSC-Announcements/2026/Ballot-Summary-Language-MMOP-and-ConCon.pdf"),
]
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120) as r:
        return r.read(), r.headers.get("Content-Type", "")


for st, url in DOCS:
    print(f"\n===== {st} {url}")
    try:
        data, ctype = get(url)
    except Exception as e:
        print(f"  not read: {type(e).__name__}: {e}")
        continue
    print(f"  {len(data)} bytes, {ctype}")
    if data[:4] == b"%PDF":
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(data); f.flush()
            info = subprocess.run(["pdfinfo", f.name], capture_output=True, text=True).stdout
            print("  " + " | ".join(l for l in info.splitlines() if l.startswith(("Pages", "Title", "Producer"))))
            text = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout
        lines = [l.rstrip() for l in text.splitlines() if l.strip()]
        print(f"  {len(lines)} lines")
        for l in lines[:LIMIT]:
            print("  | " + l[:220])
    else:
        page = data.decode("utf-8", "replace")
        for href, label in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S):
            label = re.sub(r"<[^>]+>|\s+", " ", label).strip()
            if re.search(r"\.pdf|question|proposition|measure|pamphlet|analys", href + label, re.I):
                print(f"  link: {label[:90]} -> {href[:200]}")
        body = re.sub(r"(?is)<(script|style|nav|header|footer)\b.*?</\1>", " ", page)
        body = re.sub(r"(?i)<br\s*/?>|</(p|div|h\d|li|tr)>", "\n", body)
        text = html.unescape(re.sub(r"<[^>]+>", " ", body))
        lines = [re.sub(r"[ \t]+", " ", l).strip() for l in text.splitlines()]
        lines = [l for l in lines if l]
        print(f"  {len(lines)} text lines")
        for l in lines[:LIMIT]:
            print("  | " + l[:220])
