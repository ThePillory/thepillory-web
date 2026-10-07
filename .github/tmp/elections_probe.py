# TEMPORARY (removed before merge): fourth pass: Omniballot (official accessible ballot), statement and summary HTML.
import re, html, json, urllib.request, urllib.parse
UA = "Mozilla/5.0 (ThePillory civic records; +https://thepillory.co)"
def get(u, raw=False, headers=None):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA, **(headers or {})}), timeout=40)
        b = r.read(); return r.status, r.geturl(), (b if raw else b.decode("utf-8", "ignore"))
    except Exception as e:
        return getattr(e, "code", None), u, f"ERROR {e}"
s, u, h = get("https://ca.omniballot.us/sites/06009/default/app/home")
print("OMNI HOME", s, u, len(h)); print(h[:3000])
for src in re.findall(r'<script[^>]+src="([^"]+)"', h)[:10]:
    full = urllib.parse.urljoin(u, src); s2, u2, js = get(full)
    print("\nJS", full, s2, len(js))
    for m in sorted(set(re.findall(r'["\'`](/?(?:api|sites|services|data|election|ballot)[A-Za-z0-9_/\-{}.$]*)["\'`]', js)))[:80]: print("   path:", m)
    for m in sorted(set(re.findall(r'https?://[A-Za-z0-9.\-]+(?:/[A-Za-z0-9_/\-.]*)?', js)))[:40]: print("   url:", m)
for path in ["https://ca.omniballot.us/sites/06009/default/app/home/api", "https://ca.omniballot.us/api/sites/06009", "https://ca.omniballot.us/sites/06009/api/election", "https://ca.omniballot.us/sites/06009/default/api/config"]:
    s, u, t = get(path, headers={"Accept": "application/json"}); print("\nTRY", path, s, t[:400])
s, u, h = get("https://voterguide.sos.ca.gov/candidates/governor-candidate-statements.htm")
i = h.find('id="mainCont"'); print("\nGOV STATEMENTS HTML", s); print(h[i:i+7000])
s, u, h = get("https://voterguide.sos.ca.gov/propositions/1/")
i = h.find("SUMMARY"); print("\nPROP HTML", s); print(h[max(0, i-600):i+4500])
s, u, h = get("https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/key-dates-deadlines")
body = re.sub(r"<(script|style|nav|footer|header)[\s\S]*?</\1>", " ", h, flags=re.I)
print("\nKEY DATES", s, re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))[:2500])
for u in ["https://elections.calaverasgov.us/Next-Election/Where-to-Vote", "https://elections.calaverasgov.us/Next-Election/Important-Dates"]:
    s, uu, h = get(u); print("\nPAGE", u, s)
