import re, urllib.request, urllib.parse, http.cookiejar
UA = "Mozilla/5.0 (ThePillory candidate list research; +https://thepillory.co)"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with op.open(req, timeout=90) as r:
        return r.read().decode("utf-8", "replace"), r.headers.get("Content-Type", ""), r.geturl()
# Florida: the table rows for federal offices
t, ct, u = get("https://dos.elections.myflorida.com/candidates/canlist.asp?elecid=20261103-GEN&cantype=FED&office=&status=QUA")
i = t.find("<table"); print("FL", len(t), u); 
rows = re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)
print("FL rows", len(rows))
for r in rows[:25]:
    print("  |", " | ".join(re.sub(r"<[^>]+>|\s+", " ", c).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S))[:220])
# Texas: the app's scripts, for its API
t, ct, u = get("https://goelect.txelections.civixapps.com/ivis-cbp-ui/candidate-information")
for s in re.findall(r'src="([^"]+\.js)"', t)[:6]:
    try:
        js, _, _ = get(urllib.parse.urljoin(u, s))
        apis = sorted(set(re.findall(r'["\'](/?(?:api|ivis)[^"\']{3,120})["\']', js)))
        print("TX", s, len(js), [a for a in apis if re.search(r"candid|elect|search|office", a, re.I)][:40])
        for m in re.findall(r'https?://[a-z0-9.-]+civixapps[^"\'\s]*', js)[:10]: print("  host", m)
    except Exception as e:
        print("TX js error", s, e)
# Pennsylvania: links on the ElectionInfo page
t, ct, u = get("https://www.pavoterservices.pa.gov/ElectionInfo/ElectionInfo.aspx")
for h, x in re.findall(r'href="([^"]+)"[^>]*>([^<]{0,90})', t):
    if re.search(r"candid|report|ballot|office", h + x, re.I): print("PA", repr(x.strip()), h[:160])
print("PA select names", re.findall(r'<select[^>]+name="([^"]+)"', t)[:10])
print("PA buttons", re.findall(r'<input[^>]+type="submit"[^>]+(?:name|value)="([^"]+)"', t)[:10])
# Illinois
for url in ["https://www.elections.il.gov/ElectionOperations/CandidateFilingSearch.aspx", "https://www.elections.il.gov/ElectionOperations/ElectionCandidates.aspx", "https://www.elections.il.gov/electionoperations/DownloadVoteTotals.aspx"]:
    try:
        t, ct, u = get(url)
        print("IL", url, len(t), re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*2026[^<]*)', t)[:8])
        for h, x in re.findall(r'href="([^"]+)"[^>]*>([^<]{0,90})', t):
            if re.search(r"candid|download|export", h + x, re.I): print("   ", repr(x.strip()), h[:150])
    except Exception as e:
        print("IL error", url, e)
