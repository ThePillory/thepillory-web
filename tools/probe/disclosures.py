"""Temporary probe, round 6: FPPC search by name + one Form 700 PDF's text; NetFile Schedule A-1 rows. Saves to tools/probe/out/."""
import re, json, subprocess, urllib.request, urllib.parse, http.cookiejar, pathlib
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
log = []
def say(*a): s = " ".join(str(x) for x in a); print(s); log.append(s)
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    try:
        with op.open(urllib.request.Request(u, data=data, headers=h), timeout=90) as r:
            b = r.read(); say(f"== {u[:160]} -> {r.status} {r.headers.get('content-type')} {len(b)}"); return b
    except urllib.error.HTTPError as e:
        say(f"== {u[:160]} -> HTTP {e.code}: {e.read()[:600]!r}"); return b""
    except Exception as e:
        say(f"== {u[:160]} -> {type(e).__name__}: {e}"); return b""
def around(t, w, width=1600, k=4):
    for m in list(re.finditer(re.escape(w), t))[:k]: say("   ...", t[max(0, m.start()-width//2): m.start()+width//2].replace("\n", " "), "...")
# FPPC: how the page asks SearchDocuments
home = raw("https://form700search.fppc.ca.gov/").decode("utf-8", "replace")
for src in re.findall(r'<script[^>]+src="(/Scripts/bundle[^"]+)"', home):
    js = raw("https://form700search.fppc.ca.gov" + src).decode("utf-8", "replace")
    around(js, "hdnSearchDocumentsUrl", 2400, 3)
    around(js, "searchQueryInfo", 1600, 4)
J = {"Content-Type": "application/json", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest"}
tries = [
  {"searchQueryInfo": {"queryFields": [{"queryField": "FilerLastName", "filterValue": "Newsom"}]}},
  {"queryInfo": [{"queryField": "FilerLastName", "filterValue": "Newsom"}]},
  {"searchQueryInfo": [{"queryField": "FilerLastName", "queryType": "Terms", "filterValue": ["Newsom"]}]},
  {"filters": [{"queryField": "FilerLastName", "filterValue": "Newsom"}]},
]
for body in tries:
    b = raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps(body).encode(), hdr=J)
    t = b.decode("utf-8", "replace"); say("   body", json.dumps(body), "->", t[:300].replace("\\\\", ""))
    if "Newsom" in t[:3000]:
        (OUT / "fppc-newsom.txt").write_text(t[:200000]); break
# The first Newsom document's PDF
t = (OUT / "fppc-newsom.txt").read_text() if (OUT / "fppc-newsom.txt").exists() else ""
ids = re.findall(r'indexID\\\\?":\\\\?"([0-9a-f-]{36})', t)
say("Newsom indexIDs", ids[:5])
for iid in ids[:2]:
    pdf = raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?indexID=" + iid)
    if pdf[:4] == b"%PDF":
        p = pathlib.Path("/tmp/f.pdf"); p.write_bytes(pdf)
        say(subprocess.run(["pdfinfo", str(p)], capture_output=True, text=True).stdout)
        (OUT / f"fppc-pdf-{iid}.txt").write_text(subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout)
# NetFile: what searchSchedules takes, then Schedule A-1 rows
nf = raw("https://netfile.com/public/assets/index-vtK6lIvZ.js").decode("utf-8", "replace")
around(nf, "searchSchedules", 1800, 3)
base = "https://netfile.com/api/public/sites/api/"
for sched in ["A1", "ScheduleA1", "A-1", "Schedule A-1", ["A1"], ["ScheduleA1"]]:
    q = {"aid": "CLVS", "isArchived": False, "search": "", "searchSchedules": sched, "currentPage": 1, "pageSize": 50, "sort": "filingDate"}
    b = raw(base + "searchtransactions", data=json.dumps(q).encode(), hdr={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        d = json.loads(b); names = sorted(set(i["templateName"] for i in d["items"]))
        say("   sched", json.dumps(sched), "->", d.get("totalCount"), names)
        if any(n != "Cover" for n in names):
            (OUT / "netfile-a1.json").write_bytes(b); break
    except Exception as e:
        say("   sched", sched, "->", type(e).__name__)
(OUT / "log.txt").write_text("\n".join(log))
