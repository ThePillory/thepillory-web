# TEMPORARY (removed before merge): third pass: the official documents' text and HTML structure.
import re, html, subprocess, urllib.request, urllib.parse
UA = "Mozilla/5.0 (ThePillory civic records; +https://thepillory.co)"
def get(u, raw=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request(urllib.parse.quote(u, safe=":/?=&%#"), headers={"User-Agent": UA}), timeout=60)
        b = r.read(); return r.status, (b if raw else b.decode("utf-8", "ignore"))
    except Exception as e:
        return None, (b"" if raw else f"ERROR {e}")
def pdftext(u, layout=True):
    s, b = get(u, raw=True)
    print(f"\n######## PDF {u} -> {s} {len(b)} bytes")
    if not b: return ""
    open("/tmp/x.pdf", "wb").write(b)
    info = subprocess.run(["pdfinfo", "/tmp/x.pdf"], capture_output=True, text=True).stdout
    print(info[:400])
    return subprocess.run(["pdftotext"] + (["-layout"] if layout else []) + ["/tmp/x.pdf", "-"], capture_output=True, text=True).stdout
t = pdftext("https://elections.cdn.sos.ca.gov/statewide-elections/2026-general/cert-list-candidates.pdf")
print(t[:5000]); i = t.find("State Senate"); print("...SENATE...", t[i:i+400] if i > 0 else "")
for k in ["District 4", "District 8", "District 5"]:
    for m in re.finditer(k, t): print("  CTX:", t[max(0, m.start()-200):m.start()+500].replace("\n", " | ")[:700]); break
t = pdftext("https://elections.calaverasgov.us/Portals/Elections/Documents/Guides/Master VIP.pdf")
print("LEN", len(t)); print(t[:9000])
for k in ["SAMPLE BALLOT", "OFFICIAL BALLOT", "STATE SENATOR", "MEMBER OF THE STATE ASSEMBLY", "UNITED STATES REPRESENTATIVE", "MEASURE A", "IMPARTIAL ANALYSIS", "ARGUMENT IN FAVOR", "ARGUMENT AGAINST", "REBUTTAL", "CANDIDATE STATEMENT", "Supervisor", "Age:", "Occupation"]:
    idx = [m.start() for m in re.finditer(k, t)]
    print(f"\n== '{k}' at {idx[:12]}")
    if idx: print(t[idx[0]:idx[0]+1800])
t = pdftext("https://elections.calaverasgov.us/Portals/Elections/Documents/Candidates/qualified caniddate listcfmcfmr009_nominationlist.pdf?ver=we4iXWdmaw_7ZiEPp4gN7g%3d%3d")
print(t[:6000])
s, h = get("https://voterguide.sos.ca.gov/propositions/1/arguments-rebuttals.htm")
i = h.find("ARGUMENT IN FAVOR"); print("\n######## ARG HTML", s); print(h[max(0, i-1500):i+2500])
j = h.find("Anni Chung"); print("\n######## SIGNERS HTML"); print(h[j-1200:j+1500])
s, h = get("https://voterguide.sos.ca.gov/propositions/1/")
i = h.find("SUMMARY"); print("\n######## PROP HTML", s); print(h[max(0, i-800):i+3500])
s, h = get("https://voterguide.sos.ca.gov/candidates/governor-candidate-statements.htm")
print("\n######## GOV STATEMENTS", s); body = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h); i = body.find("mainCont"); print(body[i:i+6000])
for u in ["https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/key-dates-deadlines", "https://elections.calaverasgov.us/Next-Election/Important-Dates", "https://elections.calaverasgov.us/Next-Election/Where-to-Vote"]:
    s, h = get(u); body = re.sub(r"<(script|style|nav|footer|header)[\s\S]*?</\1>", " ", h, flags=re.I)
    print(f"\n######## {u} -> {s}\n", re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))[:3000])
    for a, b in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', h, re.S)[:400]:
        if re.search(r"polling|vote center|drop|location|lookup|register|pdf", a + b, re.I): print("   L:", re.sub(r"<[^>]+>|\s+", " ", b).strip()[:60], urllib.parse.urljoin(u, html.unescape(a)))
