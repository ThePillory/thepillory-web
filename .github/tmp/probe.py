import json, re, sys, urllib.request, html, io, zipfile
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records research)"}
def get(url, n=3000000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90)
        return r.status, r.headers.get("Content-Type", ""), r.read(n)
    except Exception as e:
        return getattr(e, "code", "ERR"), str(e)[:200], b""
def text(b):
    t = b.decode("utf-8", "ignore")
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))
def show(label, url, mode="head", pat=None, n=3000000, limit=40, width=500):
    s, ct, b = get(url, n)
    print(f"\n===== {label} | {url} -> {s} [{ct[:50]}] {len(b)} bytes")
    if mode == "head": print(b[:1500].decode("utf-8", "ignore"))
    elif mode == "links":
        links = sorted(set(re.findall(r'href="([^"]+)"', b.decode("utf-8", "ignore"))))
        for l in [x for x in links if (not pat or re.search(pat, x, re.I))][:limit]: print("  ", l)
    elif mode == "text":
        t = text(b)
        if pat:
            for m in list(re.finditer(pat, t, re.I))[:limit]: print("  ...", t[max(0, m.start()-150): m.end()+width])
        else: print(t[:3000])
    return b
# Census relationship files
for d in ["cd108th", "cd110th", "cdsld13", "cdsld16", "cdsld18", "cdsld13/06", "cdsld18/06"]:
    show("relfiles " + d, f"https://www2.census.gov/geo/relfiles/{d}/", "links", r"\.(txt|zip|csv)|/$")
b = show("cd110 CA", "https://www2.census.gov/geo/relfiles/cd110th/06/", "links", r".")
# Open States retired sample
s, ct, b = get("https://api.github.com/repos/openstates/people/contents/data/ca/retired")
try:
    files = json.loads(b); print("\n===== openstates retired count", len(files))
    for f in files[:3]:
        s2, _, y = get(f["download_url"]); print("---", f["name"]); print(y.decode()[:900])
    names = [f["name"] for f in files]; print("sample names", names[:10])
except Exception as e: print("openstates err", e, b[:300])
# CA SOS statement of vote pages
show("SOV 2022 page", "https://www.sos.ca.gov/elections/prior-elections/statewide-election-results/general-election-nov-8-2022/statement-vote", "links", r"pdf")
show("SOV 2002 page", "https://www.sos.ca.gov/elections/prior-elections/statewide-election-results/general-election-november-5-2002/statement-vote", "links", r"pdf|htm")
# DOF budget history
show("DOF budget", "https://dof.ca.gov/budget/", "links", r"histor|chart|summary|schedule")
show("ebudget home", "https://ebudget.ca.gov/", "links", r"histor|chart|summary|schedule")
# Calaveras
show("Calaveras previous elections", "https://elections.calaverasgov.us/Results/Previous-Elections", "links", r"pdf|result|20\d\d")
show("Calaveras BOS page text", "https://www.calaverasgov.us/Government/Board-of-Supervisors", "text", r"District [1-5]", limit=6, width=200)
# CA statewide officer history pages
for lab, url in [("LtGov", "https://ltg.ca.gov/about/history/"), ("SOS former", "https://www.sos.ca.gov/about/former-secretaries-state"), ("Controller", "https://www.sco.ca.gov/eo_about_former.html"), ("Treasurer", "https://www.treasurer.ca.gov/about/history.asp"), ("Insurance", "https://www.insurance.ca.gov/0500-about-us/"), ("SPI", "https://www.cde.ca.gov/eo/mn/rl/formerspis.asp"), ("AG list", "https://oag.ca.gov/history/former-ags"), ("BOE", "https://www.boe.ca.gov/info/former_members.htm")]:
    show(lab, url, "text", r"(19|20)\d\d\s*[-–]\s*(19|20)?\d\d", limit=4, width=250)
# Census pop 2020-2024
show("popest 2020s", "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/state/totals/", "links", r"csv")
show("popest 2020s nat", "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/", "links", r"csv")
# events
show("NBER", "https://www.nber.org/research/business-cycle-dating", "text", r"(Peak|Trough)", limit=3, width=300)
show("HHS PHE", "https://aspr.hhs.gov/legal/PHE/Pages/default.aspx", "text", r"COVID|H1N1", limit=4, width=300)
show("congress.gov PL 107-40", "https://www.congress.gov/107/plaws/publ40/PLAW-107publ40.htm", "text", r"Authorization", limit=1, width=200)
show("congress.gov PL 107-243", "https://www.congress.gov/107/plaws/publ243/PLAW-107publ243.htm", "text", r"Authorization", limit=1, width=200)
# Senate votes XML year 2001 sample
show("Senate vote 107-1-1", "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1071/vote_107_1_00001.xml", "head")
# House clerk XML member format sample
s, ct, b = get("https://clerk.house.gov/evs/2008/roll100.xml")
t = b.decode("utf-8", "ignore"); i = t.find("<recorded-vote>"); print("\n===== house 2008 roll100 recorded-vote", t[i:i+600]); print(t[:900])
