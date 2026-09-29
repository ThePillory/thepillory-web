"""TEMPORARY research script (removed before merge): print what the county publishes."""
import html, re, urllib.request, urllib.error

UA = {"User-Agent": "Mozilla/5.0 (compatible; thepillory-research; +https://thepillory.co)"}

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, "", ""
    except Exception as e:
        return 0, "", f"ERROR {e}"

def text(raw):
    raw = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<(br|/p|/div|/h\d|/li|/tr|/td)\b[^>]*>", "\n", raw)
    raw = html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))
    return "\n".join(l for l in (re.sub(r"[ \t ]+", " ", x).strip() for x in raw.split("\n")) if l)

def links(raw, pat):
    return sorted(set(html.unescape(m) for m in re.findall(r'href="([^"]*)"', raw) if re.search(pat, m, re.I)))

def show(url, raw_chars=0, pat=None, text_chars=12000):
    st, ct, body = get(url)
    print(f"\n\n########## {url}\nstatus {st} type {ct} bytes {len(body)}")
    if pat: print("LINKS:", "\n".join(links(body, pat)))
    if raw_chars: print("RAW:\n" + body[:raw_chars])
    print("TEXT:\n" + text(body)[:text_chars])
    return body

for u in ["https://bos.calaverasgov.us/robots.txt", "https://calaverascountyca.iqm2.com/robots.txt"]:
    show(u, text_chars=2000)
sup = show("https://bos.calaverasgov.us/Board-of-Supervisors/Supervisors", pat=r"supervisor|district")
for l in links(sup, r"District-?\d|Supervisor[s]?/"):
    if l.startswith("/"): l = "https://bos.calaverasgov.us" + l
    if l.startswith("http"): show(l, text_chars=2500)
rss = show("https://calaverascountyca.iqm2.com/Services/RSS.aspx?Feed=Calendar", raw_chars=6000, text_chars=3000)
show("https://calaverascountyca.iqm2.com/Citizens/Default.aspx", pat=r"Detail_Meeting|Board/|FileOpen|RSS|ical|\.ics", text_chars=6000)
cal = show("https://calaverascountyca.iqm2.com/Citizens/calendar.aspx?View=List", pat=r"Detail_Meeting|RSS|ical|\.ics|Board/", text_chars=6000)
ids = re.findall(r"Detail_Meeting\.aspx\?ID=(\d+)", cal + rss)
print("\nMEETING IDS:", ids[:40])
for mid in list(dict.fromkeys(ids))[:3]:
    show(f"https://calaverascountyca.iqm2.com/Citizens/Detail_Meeting.aspx?ID={mid}", raw_chars=15000, pat=r"FileOpen|SplitView|Detail_LegiFile|video|youtube", text_chars=8000)
show("https://calaverascountyca.iqm2.com/Services/RSS.aspx?Feed=Board", raw_chars=1500, text_chars=500)
show("https://bos.calaverasgov.us/Board-Meetings", pat=r"iqm2|agenda|youtube|comment", text_chars=5000)
