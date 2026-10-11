"""Temporary probe, round 2: how the judiciary's, FPPC's and NetFile's disclosure sites serve filings."""
import re, urllib.request, urllib.parse, http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(u, data=None, hdr=None):
    try:
        h = {"User-Agent": UA}; h.update(hdr or {})
        with op.open(urllib.request.Request(u, data=data, headers=h), timeout=40) as r:
            b = r.read(); print(f"\n== {u} -> {r.status} {r.headers.get('content-type')} {len(b)} bytes"); return b.decode("utf-8", "replace")
    except Exception as e:
        print(f"\n== {u} -> {type(e).__name__}: {e}"); return ""
def strings(t, pat, n=60):
    out = sorted(set(re.findall(pat, t)))[:n]
    for s in out: print("   ", s[:200])
def text(h, n=3000):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", h, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t); t = re.sub(r"\s+", " ", t); print("   TEXT:", t[:n])
# The judiciary
h = get("https://pub.jefs.uscourts.gov/")
text(h, 2500)
strings(h, r'(?:href|src|action)="([^"]+)"')
strings(h, r'["\'](/[A-Za-z0-9_/\-.]*(?:api|search|filer|report|disclos)[A-Za-z0-9_/\-.?=]*)["\']')
for s in re.findall(r'<script[^>]+src="([^"]+)"', h)[:6]:
    js = get(urllib.parse.urljoin("https://pub.jefs.uscourts.gov/", s))
    strings(js, r'["\'`](/?[A-Za-z0-9_/\-.]*(?:api|search|filer|report|disclos|pdf)[A-Za-z0-9_/\-.?=]*)["\'`]', 80)
h = get("https://fixthecourt.com/2025disclosures/")
strings(h, r'href="([^"]*(?:uscourts|jefs|\.pdf)[^"]*)"', 40)
# FPPC Form 700 search
h = get("https://form700search.fppc.ca.gov/")
text(h, 2500)
strings(h, r'(?:href|src|action)="([^"]+)"')
for s in re.findall(r'<script[^>]+src="([^"]+)"', h)[:8]:
    js = get(urllib.parse.urljoin("https://form700search.fppc.ca.gov/", s))
    strings(js, r'["\'`](/?[A-Za-z0-9_/\-.]*(?:api|Search|search|Filer|filer|Export|export|Document|pdf)[A-Za-z0-9_/\-.?=]*)["\'`]', 80)
# NetFile public portal (Calaveras)
h = get("https://netfile.com/public/CLVS/sei")
for s in re.findall(r'<script[^>]+src="([^"]+)"', h)[:3]:
    js = get(urllib.parse.urljoin("https://netfile.com/", s))
    strings(js, r'["\'`]((?:https?://[a-z0-9.\-]+)?/[A-Za-z0-9_/\-.{}$]*(?:api|sei|filing|Filing|document|Document|public)[A-Za-z0-9_/\-.?={}$]*)["\'`]', 120)
