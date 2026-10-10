# TEMPORARY: how Vote.gov and USA.gov list each state's official voting links, and the FEC candidate list's shape.
import os, re, json, urllib.request, urllib.parse
OUT = "tmp-research/out-vote"
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (compatible; ThePillory research; +https://thepillory.co)"
URLS = [
    "https://vote.gov/",
    "https://vote.gov/register/washington/",
    "https://vote.gov/register/washington",
    "https://vote.gov/register/california/",
    "https://vote.gov/state/washington/",
    "https://www.usa.gov/state-election-office",
    "https://www.usa.gov/state-election-office/washington",
    "https://www.usa.gov/states/washington",
    "https://api.open.fec.gov/v1/candidates/?api_key=DEMO_KEY&state=WA&office=S&election_year=2026&is_active_candidate=true&per_page=100",
    "https://api.open.fec.gov/v1/candidates/?api_key=DEMO_KEY&state=WA&office=H&district=07&election_year=2026&is_active_candidate=true&per_page=100",
]
def name(u):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", u.split("://", 1)[1].replace("api_key=DEMO_KEY", ""))[:150]
for u in URLS:
    try:
        req = urllib.request.Request(u, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
            open(f"{OUT}/{name(u)}.txt", "w").write(f"STATUS {r.status} FINAL {r.geturl()}\n" + body)
    except Exception as e:
        open(f"{OUT}/_errors.txt", "a").write(f"{u}\t{e}\n")
