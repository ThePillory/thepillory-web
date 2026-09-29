"""TEMPORARY research script (removed before merge): can a cloud server reach the county meeting portal?"""
import subprocess, time, re, html

URLS = [
    "https://calaverascountyca.iqm2.com/Citizens/Default.aspx",
    "http://calaverascountyca.iqm2.com/Citizens/Default.aspx",
    "https://calaverascountyca.iqm2.com/Services/RSS.aspx?Feed=Calendar",
    "https://calaverascountyca.iqm2.com/Citizens/calendar.aspx?View=List",
    "https://santacruzcountyca.iqm2.com/Citizens/Default.aspx",
    "https://www.calaverasgov.us/Meeting-Calendar/category/planning-commission",
    "https://www.calaverasgov.us/Meeting-Calendar",
]
BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
for u in URLS:
    t = time.time()
    r = subprocess.run(["curl", "-sS", "-L", "-m", "120", "-A", BROWSER, "-o", "/tmp/out", "-w", "%{http_code} %{remote_ip} %{time_connect} %{time_starttransfer}", u], capture_output=True, text=True)
    body = open("/tmp/out", errors="replace").read() if r.returncode == 0 else ""
    print(f"\n########## {u}\n{r.stdout} rc={r.returncode} {r.stderr.strip()} {time.time()-t:.1f}s bytes={len(body)}")
    if body:
        ids = re.findall(r"Detail_Meeting\.aspx\?ID=(\d+)", body)
        print("meeting ids:", ids[:20])
        print("links:", sorted(set(m for m in re.findall(r'href="([^"]+)"', body) if re.search(r"rss|ical|\.ics|Detail_Meeting|FileOpen|agenda", m, re.I)))[:40])
        txt = html.unescape(re.sub(r"(?s)<[^>]+>", " ", re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", body)))
        print("TEXT:", re.sub(r"\s+", " ", txt)[:3000])
        if "RSS" in u: print("RAW:", body[:4000])
