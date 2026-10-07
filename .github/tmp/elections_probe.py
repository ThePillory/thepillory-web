# TEMPORARY (removed before merge): map the official election sources.
import re, html, json, os, sys, urllib.request, urllib.parse
UA = "Mozilla/5.0 (ThePillory civic records; +https://thepillory.co)"
def get(u, raw=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30)
        b = r.read()
        return r.status, r.geturl(), r.headers.get("content-type", ""), (b if raw else b.decode("utf-8", "ignore"))
    except Exception as e:
        return None, u, "", f"ERROR {e}"
def links(t, base, pat):
    out = []
    for h, txt in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', t, re.S | re.I):
        txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", txt))).strip()
        full = urllib.parse.urljoin(base, html.unescape(h))
        if re.search(pat, full + " " + txt, re.I):
            out.append((txt[:80], full))
    seen = set(); res = []
    for x in out:
        if x[1] not in seen: seen.add(x[1]); res.append(x)
    return res
def show(title, u, pat, n=40):
    s, url, ct, t = get(u)
    print(f"\n===== {title}: {u} -> {s} {url} [{ct}]")
    if s is None: print(t[:300]); return t
    m = re.search(r"<title[^>]*>(.*?)</title>", t, re.S | re.I)
    print("title:", html.unescape(m.group(1)).strip()[:150] if m else None)
    for x in links(t, url, pat)[:n]: print("  ", x)
    return t

show("SOS upcoming", "https://www.sos.ca.gov/elections/upcoming-elections", r"2026|general|candidate|voter")
show("SOS Nov 2026", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-nov-3-2026", r"candidate|certified|list|measure|propos|guide|statement|xls|csv|pdf|calendar|deadline")
show("SOS cand list page", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-nov-3-2026/certified-list-candidates", r"pdf|xls|csv|certified|list")
show("SOS qualified measures", "https://www.sos.ca.gov/elections/ballot-measures/qualified-ballot-measures", r"prop|measure|pdf|2026")
t = show("Voter guide home", "https://voterguide.sos.ca.gov/", r"propositions|prop|quick|candidate|statement|pdf|argument")
show("Voter guide props", "https://voterguide.sos.ca.gov/propositions/", r"propositions/\d|prop", 30)
# One proposition page structure
s, url, ct, t = get("https://voterguide.sos.ca.gov/propositions/")
pl = [l for l in links(t or "", url or "", r"/propositions/\d+") ]
if pl:
    s2, u2, ct2, p = get(pl[0][1])
    print("\n===== first prop page:", pl[0], s2)
    body = re.sub(r"<(script|style|nav|footer|header)[\s\S]*?</\1>", " ", p, flags=re.I)
    heads = re.findall(r"<h[1-4][^>]*>(.*?)</h[1-4]>", body, re.S | re.I)
    print("headings:", [re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]+>","",h))).strip()[:80] for h in heads][:40])
    txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))
    print("text start:", txt[:1500])
    for x in links(p, u2, r"argument|analysis|text|pdf")[:20]: print("  ", x)
show("SOS results", "https://electionresults.sos.ca.gov/", r"api|json|returns|feed|download|xml", 30)
for u in ["https://api.sos.ca.gov/returns/status", "https://api.sos.ca.gov/returns/ballot-measures", "https://api.sos.ca.gov/returns/us-rep/district/5", "https://api.sos.ca.gov/returns/governor"]:
    s, url, ct, t = get(u); print(f"\n===== {u} -> {s} [{ct}]\n", t[:600])
show("Calaveras elections", "https://elections.calaverasgov.us/", r"2026|ballot|candidate|measure|sample|statement|result|guide|polling|register|deadline", 60)
show("Calaveras county site elections", "https://www.calaverasgov.us/Government/Departments/Elections", r"2026|ballot|candidate|measure|sample|statement|result|guide|polling", 60)
key = os.environ.get("FEC_KEY") or "DEMO_KEY"
for q in ["office=H&state=CA&district=05", "office=S&state=CA"]:
    s, url, ct, t = get(f"https://api.open.fec.gov/v1/candidates/?{q}&election_year=2026&per_page=50&sort=name&api_key={key}")
    try:
        d = json.loads(t); print(f"\n===== FEC {q}: {d.get('pagination',{}).get('count')} candidates")
        for c in d["results"][:30]: print("  ", c["name"], c["party"], c["candidate_status"], c.get("incumbent_challenge_full"), c["candidate_id"], c.get("has_raised_funds"))
    except Exception as e: print("FEC error", s, t[:300])
for u in ["https://registertovote.ca.gov/", "https://www.sos.ca.gov/elections/polling-place", "https://voterstatus.sos.ca.gov/", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-nov-3-2026/key-dates-and-deadlines"]:
    s, url, ct, t = get(u); m = re.search(r"<title[^>]*>(.*?)</title>", t or "", re.S | re.I)
    print(f"\n===== {u} -> {s} {url} title: {html.unescape(m.group(1)).strip()[:120] if m else None}")
