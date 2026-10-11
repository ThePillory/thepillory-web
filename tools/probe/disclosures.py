"""Temporary probe: can GitHub's servers reach the justices' and California's disclosure sites? Prints links only."""
import re, sys, urllib.request, http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(u):
    try:
        with op.open(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40) as r:
            b = r.read(); print(f"\n== {u} -> {r.status} {r.headers.get('content-type')} {len(b)} bytes, final {r.url}"); return b.decode("utf-8", "replace")
    except Exception as e:
        print(f"\n== {u} -> {type(e).__name__}: {e}"); return ""
def links(html, pat):
    seen = []
    for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I):
        t = re.sub(r"<[^>]+>|\s+", " ", text).strip()
        if re.search(pat, href + " " + t, re.I) and href not in seen:
            seen.append(href); print("  ", href, "|", t[:90])
    print(f"   ({len(seen)} links)")
for u in ["https://www.uscourts.gov/data-news/reports/financial-disclosure-reports",
          "https://www.uscourts.gov/judges-judgeships/judicial-financial-disclosure-reports",
          "https://www.uscourts.gov/forms-rules/forms/financial-disclosure-reports",
          "https://pub.jefs.uscourts.gov/",
          "https://www.supremecourt.gov/publicinfo/publicinfo.aspx",
          "https://fixthecourt.com/financial-disclosures/"]:
    links(get(u), r"disclos|justice|supreme|\.pdf|2024|2025")
h = get("https://form700search.fppc.ca.gov/")
links(h, r"search|filer|form|700")
print(re.findall(r"<form[^>]*>", h)[:5]); print(re.findall(r'<input[^>]+name="([^"]+)"', h)[:40])
for u in ["https://form700search.fppc.ca.gov/Search/SearchFilerForms.aspx", "https://www.fppc.ca.gov/transparency/form-700-filed-by-public-officials.html",
          "https://netfile.com/public/CLVS/sei", "https://public.netfile.com/pub2/?aid=CLVS"]:
    h = get(u); links(h, r"700|search|filer|statement|\.pdf"); print(re.findall(r'<input[^>]+name="([^"]+)"', h)[:40]); print(h[:600] if len(h) < 4000 else "")
