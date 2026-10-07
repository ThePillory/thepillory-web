# TEMPORARY (removed before merge): second pass on the official election sources.
import re, html, json, os, subprocess, urllib.request, urllib.parse
UA = "Mozilla/5.0 (ThePillory civic records; +https://thepillory.co)"
def get(u, raw=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40)
        b = r.read()
        return r.status, r.geturl(), r.headers.get("content-type", ""), (b if raw else b.decode("utf-8", "ignore"))
    except Exception as e:
        return None, u, "", (b"" if raw else f"ERROR {e}")
def links(t, base, pat):
    out, seen = [], set()
    for h, txt in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', t, re.S | re.I):
        txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", txt))).strip()
        full = urllib.parse.urljoin(base, html.unescape(h))
        if re.search(pat, full + " " + txt, re.I) and full not in seen:
            seen.add(full); out.append((txt[:90], full))
    return out
def text(t):
    body = re.sub(r"<(script|style|nav|footer|header)[\s\S]*?</\1>", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body))).strip()
def show(title, u, pat, n=40, txt=0):
    s, url, ct, t = get(u)
    print(f"\n===== {title}: {u} -> {s} {url} [{ct}]")
    if s is None: print(t[:200]); return ""
    for x in links(t, url, pat)[:n]: print("  ", x)
    if txt: print("  TEXT:", text(t)[:txt])
    return t
def pdf(title, u, n=3000, grep=None):
    s, url, ct, b = get(u, raw=True)
    print(f"\n===== PDF {title}: {u} -> {s} [{ct}] {len(b)} bytes")
    if not b: return ""
    open("/tmp/x.pdf", "wb").write(b)
    t = subprocess.run(["pdftotext", "-layout", "/tmp/x.pdf", "-"], capture_output=True, text=True).stdout
    print(t[:n])
    if grep:
        for line in t.splitlines():
            if re.search(grep, line, re.I): print("  G:", line.strip()[:200])
    return t

show("SOS Nov 3 2026", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026", r"candidate|certified|random|alphabet|statement|measure|deadline|calendar|pdf|xls|csv", 60)
t = show("SOS cand list page", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/certified-list-candidates", r"pdf|xls|csv|certified|list", 30)
for title, u in links(t, "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/certified-list-candidates", r"\.pdf")[:1]:
    pdf("certified list", u, 6000, r"calaveras|state senate|district 4|district 8|district 5|assembly")
show("random alphabet", "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/randomized-alphabet", r"pdf|random|rotation", 20, 1500)
show("VIG candidates", "https://voterguide.sos.ca.gov/candidates/", r"candidates/|statement|governor|senate|congress", 40, 1500)
show("VIG governor", "https://voterguide.sos.ca.gov/candidates/governor/", r"statement|candidate|pdf", 30, 2500)
show("Prop 1 arguments", "https://voterguide.sos.ca.gov/propositions/1/arguments-rebuttals.htm", r"pdf", 10, 5000)
show("Prop 1 analysis", "https://voterguide.sos.ca.gov/propositions/1/analysis.htm", r"pdf", 5, 600)
show("Prop 45 page", "https://voterguide.sos.ca.gov/propositions/45/", r"arguments|analysis|pdf", 10, 2500)
show("VIG quick ref", "https://voterguide.sos.ca.gov/quick-reference-guide/", r"pdf|prop", 10, 1200)
for p in ["Candidates-and-Measures", "Candidates-and-Measures/Candidate-Filing", "Candidates-and-Measures/Candidate-and-Measure-Guides"]:
    t = show(f"Calaveras {p}", f"https://elections.calaverasgov.us/Next-Election/General-Election/{p}", r"pdf|ballot|measure|candidate|statement|sample|guide|docs|showdocument|xls", 60, 2500)
show("Calaveras results", "https://elections.calaverasgov.us/Results/Current-Results", r"pdf|clarity|results|html|xml|json|csv", 40, 1500)
show("Calaveras next election", "https://elections.calaverasgov.us/Next-Election/General-Election", r"pdf|ballot|sample|polling|vote center|drop|deadline|register|important dates", 60, 2000)
show("Calaveras registering", "https://elections.calaverasgov.us/Voter-Services/Registering-to-Vote", r"register|deadline|pdf", 20, 800)
for path in ["state-senate/district/4", "state-assembly/district/8", "us-rep/district/5", "lieutenant-governor", "secretary-of-state", "controller", "treasurer", "attorney-general", "insurance-commissioner", "superintendent-of-public-instruction", "board-of-equalization/district/1", "governor/county/calaveras", "ballot-measures/county/calaveras", "status/calaveras"]:
    s, url, ct, t = get(f"https://api.sos.ca.gov/returns/{path}")
    print(f"\n===== returns/{path} -> {s}\n", re.sub(r"\s+", " ", t)[:500])
