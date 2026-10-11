#!/usr/bin/env python3
"""Temporary: print the layout of states' official ballot-measure guides (text
and links), so builders can be written for them. Run in GitHub Actions (the
"Probe measure guides" workflow); writes nothing."""
import html, http.cookiejar, re, subprocess, sys, tempfile, urllib.request
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
# (state, url, pdftotext options, first page, last page, find: print lines around matches, keep blank lines)
DOCS = [
    ("MA", "https://www.sec.state.ma.us/divisions/elections/research-and-statistics/2026-Information-for-voters/2026-ballot-questions.htm", [], 0, 0, None, False),
    ("MI", "https://sfa.senate.michigan.gov/Publications/BallotProps/Proposal26-1.pdf", [], 0, 0, None, True),
    ("MI", "https://sfa.senate.michigan.gov/Publications/BallotProps/Proposal26-2.pdf", [], 1, 2, None, True),
    ("CO", "https://content.leg.colorado.gov/sites/default/files/2026-bluebook-english-accessible_1.pdf", [], 15, 16, None, True),
    ("AZ", "https://azsos.gov/sites/default/files/docs/2026-Ballot-Language-English-2026-0819.pdf", ["-layout"], 1, 3, None, False),
    ("AZ", "https://apps.azsos.gov/election/BallotMeasures/2026/2026-AZ-Publicity-Pamphlet.pdf", ["-layout"], 0, 0, r"ANALYSIS BY LEGISLATIVE COUNCIL|Table of Contents|TABLE OF CONTENTS|OFFICIAL TITLE|Fiscal Impact|FISCAL IMPACT", False),
]
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def get(url):
    last = None
    for ua in (UA, BROWSER):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "text/html,application/pdf,*/*", "Accept-Language": "en-US,en;q=0.9"})
            with OPENER.open(req, timeout=120) as r:
                print(f"  read with {'our' if ua == UA else 'a browser'} user agent")
                return r.read(), r.headers.get("Content-Type", "")
        except Exception as e:
            last = e
            print(f"  {'our' if ua == UA else 'browser'} user agent: {type(e).__name__}: {e}")
    raise last


for st, url, opts, first, last, find, blanks in DOCS:
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
            pages = ["-f", str(first), "-l", str(last)] if first else []
            text = subprocess.run(["pdftotext", *opts, *pages, f.name, "-"], capture_output=True, text=True).stdout
        lines = [l.rstrip() for l in text.splitlines() if blanks or l.strip()]
        print(f"  {len(lines)} lines")
        if find:
            hits = [i for i, l in enumerate(lines) if re.search(find, l)]
            print(f"  {len(hits)} matches for {find}")
            shown = set()
            for i in hits[:14]:
                for j in range(max(0, i - 3), min(len(lines), i + 40)):
                    if j not in shown:
                        shown.add(j)
                        print(f"  {j:5d}| " + lines[j][:220])
                print("  ...")
        else:
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
