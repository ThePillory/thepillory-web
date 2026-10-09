# TEMPORARY research probe 3 (removed before merge): the sign-in form's fields
# (GET only, no credentials), and what the session CSV page links to.
import re, urllib.request, http.cookiejar
OUT = "tmp-research/out"
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records)"}
cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
log = []
def note(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log.append(s)
for url in ["https://open.pluralpolicy.com/accounts/login/?next=/data/session-csv/", "https://open.pluralpolicy.com/accounts/signup/"]:
    try:
        r = op.open(urllib.request.Request(url, headers=UA), timeout=60); h = r.read().decode("utf-8", "replace")
        note("PAGE", url, r.status, r.geturl(), len(h))
        for f in re.findall(r"<form[^>]*>.*?</form>", h, re.S):
            note("  FORM", re.search(r"<form[^>]*>", f).group(0))
            for i in re.findall(r"<(?:input|button|select)[^>]*>", f): note("    ", re.sub(r'value="[A-Za-z0-9]{30,}"', 'value="…"', i))
        for a in re.findall(r'href="([^"]*(?:github|google|oauth|social|provider)[^"]*)"', h): note("  LINK", a)
    except Exception as e:
        note("FAIL", url, repr(e))
note("COOKIES", [c.name for c in cj])
open(f"{OUT}/log3.txt", "w").write("\n".join(log))
