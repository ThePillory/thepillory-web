"""Temporary probe, round 4: FPPC search/export calls and NetFile's SEI API base."""
import re, json, urllib.request, urllib.parse, http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(u, data=None, hdr=None, n=1500):
    try:
        h = {"User-Agent": UA}; h.update(hdr or {})
        with op.open(urllib.request.Request(u, data=data, headers=h), timeout=60) as r:
            b = r.read(); t = b.decode("utf-8", "replace"); print(f"\n== {u} -> {r.status} {r.headers.get('content-type')} {len(b)} bytes"); return t
    except urllib.error.HTTPError as e:
        print(f"\n== {u} -> HTTP {e.code}: {e.read()[:400]!r}"); return ""
    except Exception as e:
        print(f"\n== {u} -> {type(e).__name__}: {e}"); return ""
def around(t, word, w=700, k=6):
    for m in list(re.finditer(re.escape(word), t))[:k]: print("   ...", t[max(0, m.start()-w//2): m.start()+w//2].replace("\n", " "), "...")
h = get("https://form700search.fppc.ca.gov/")
print(h[:200]); around(h, "<script", 400, 12); around(h, "<form", 600, 3); around(h, "Search", 500, 6)
js = get("https://form700search.fppc.ca.gov/Scripts/searchExportBundle?v=PmZlP9DDYzcACL-VvAVDQMhok6EFPb07FuLAfWYKwj81")
for w in ["status", "Export", "FilingYear", "ajax", "$.post", "fetch(", "token"]: around(js, w, 600, 3)
nf = get("https://netfile.com/public/assets/index-vtK6lIvZ.js")
for w in ["baseUrl", "searchTransactions", "exportTransactionCSV", "searchFilings", "Turnstile", "turnstile"]: around(nf, w, 900, 3)
