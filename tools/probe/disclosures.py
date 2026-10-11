"""Temporary probe, round 3: justices' report PDFs (text layer?), FPPC search endpoints, NetFile Connect2."""
import re, json, subprocess, urllib.request, urllib.parse, http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    with op.open(urllib.request.Request(u, data=data, headers=h), timeout=60) as r:
        b = r.read(); print(f"\n== {u} -> {r.status} {r.headers.get('content-type')} {len(b)} bytes"); return b
def get(u, **k):
    try: return raw(u, **k).decode("utf-8", "replace")
    except Exception as e: print(f"\n== {u} -> {type(e).__name__}: {e}"); return ""
# 1. Justices: the 2025 reports, and earlier years' pages
for y in (2023, 2024):
    h = get(f"https://fixthecourt.com/{y}disclosures/")
    print("  ", sorted(set(re.findall(r'href="([^"]*\.pdf)"', h)))[:14])
for u in ["https://fixthecourt.com/wp-content/uploads/2026/06/Roberts-Jr-John-G-Annual-2025.pdf", "https://fixthecourt.com/wp-content/uploads/2026/06/Barrett-Amy-C-Annual-2025.pdf"]:
    try:
        open("/tmp/r.pdf", "wb").write(raw(u))
        print(subprocess.run(["pdfinfo", "/tmp/r.pdf"], capture_output=True, text=True).stdout)
        t = subprocess.run(["pdftotext", "-layout", "/tmp/r.pdf", "-"], capture_output=True, text=True).stdout
        print("   text chars:", len(t.strip()))
        i = t.find("TRANSACTIONS"); i = i if i >= 0 else t.find("INVESTMENTS")
        print(t[:1200]); print("....."); print(t[i:i+3500] if i >= 0 else t[-3000:])
    except Exception as e: print("  ", type(e).__name__, e)
# 2. FPPC: the page's inline scripts (where the grid's data URL lives)
h = get("https://form700search.fppc.ca.gov/")
for s in re.findall(r"<script(?![^>]*src)[^>]*>(.*?)</script>", h, re.S): print("  INLINE:", s.strip()[:3000])
js = get("https://form700search.fppc.ca.gov/Scripts/searchExportBundle?v=PmZlP9DDYzcACL-VvAVDQMhok6EFPb07FuLAfWYKwj81")
for m in sorted(set(re.findall(r"(?:url|URL|Url)\s*[:=]\s*[^,;]{0,160}", js)))[:60]: print("   ", m)
for m in sorted(set(re.findall(r"[\"'](/?(?:api|Search|Export|Filing|Document|Home)[A-Za-z0-9_/\-]*)[\"']", js))): print("   PATH", m)
# 3. NetFile Connect2 public API (Calaveras)
for u in ["https://netfile.com/public/env-config.js", "https://netfile.com/Connect2/api/public/campaign/list/filing?aid=CLVS&format=json",
          "https://netfile.com/Connect2/api/help", "https://netfile.com/api/public/sites"]:
    print(get(u, hdr={"Accept": "application/json"})[:1500])
js = get("https://netfile.com/public/assets/index-vtK6lIvZ.js")
for m in sorted(set(re.findall(r"[\"'`]([^\"'`]{0,60}(?:sei|Sei|SEI|statement|form700|Form700)[^\"'`]{0,80})[\"'`]", js)))[:80]: print("   NF", m)
for m in sorted(set(re.findall(r"[\"'`](/api/[^\"'`]{1,120})[\"'`]", js)))[:80]: print("   NFAPI", m)
