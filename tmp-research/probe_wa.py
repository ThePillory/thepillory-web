# TEMPORARY: fetch Washington's official 2026 general election pages and the
# voters' pamphlet, and save them (and the pamphlet's text) for reading.
import os, re, subprocess, urllib.request, urllib.parse
OUT = "tmp-research/out-wa"
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (compatible; ThePillory research; +https://thepillory.co)"
START = [
    "https://www.sos.wa.gov/about-office/news/2026/secretary-state-certifies-candidates-and-measures-november-general-election",
    "https://www.sos.wa.gov/elections/voters/proposed-ballot-measure-information",
    "https://www.sos.wa.gov/elections/voters/voters-pamphlet",
    "https://www.sos.wa.gov/elections/voters/voter-pamphlet",
    "https://www.sos.wa.gov/elections/initiatives-referenda",
    "https://www.sos.wa.gov/elections/initiatives-referenda/2026-initiatives-legislature",
    "https://www.sos.wa.gov/elections/initiatives-referenda/2026-initiatives-people",
    "https://www.sos.wa.gov/sites/default/files/2026-10/Voters%20Pamphlet%202026%20-%20Edition%2023%20-%20Skagit.pdf",
]
seen, queue = set(), list(START)
def name(u):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", u.split("://", 1)[1])[:180]
def get(u):
    req = urllib.request.Request(u, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()
count = 0
while queue and count < 45:
    u = queue.pop(0)
    if u in seen:
        continue
    seen.add(u)
    count += 1
    try:
        status, ctype, body = get(u)
    except Exception as e:
        open(f"{OUT}/_errors.txt", "a").write(f"{u}\t{e}\n")
        continue
    path = f"{OUT}/{name(u)}"
    if "pdf" in ctype or u.lower().endswith(".pdf"):
        open(path if path.endswith(".pdf") else path + ".pdf", "wb").write(body)
        pdf = path if path.endswith(".pdf") else path + ".pdf"
        subprocess.run(["pdftotext", "-layout", pdf, pdf[:-4] + ".layout.txt"])
        subprocess.run(["pdftotext", pdf, pdf[:-4] + ".txt"])
        os.remove(pdf)
        continue
    text = body.decode("utf-8", "replace")
    open(path + ".html", "w").write(text)
    for href in re.findall(r'href="([^"#]+)"', text):
        v = urllib.parse.urljoin(u, href)
        low = urllib.parse.unquote(v).lower()
        if not re.match(r"https://(www\.)?sos\.wa\.gov/", v):
            continue
        if re.search(r"voters.?pamphlet.*(statewide|state wide)|il26|ip26|initiative.*2026|2026.*(measure|initiative)", low) and "spanish" not in low and "chinese" not in low and "korean" not in low and "vietnamese" not in low:
            queue.append(v)
open(f"{OUT}/_fetched.txt", "w").write("\n".join(sorted(seen)))
