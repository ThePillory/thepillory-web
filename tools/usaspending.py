"""
Federal awards (contracts and grants) for an organization, from USAspending.gov.
Pure helpers plus the lookup; tools/load_gov_money.py runs it in GitHub Actions
(Cloudflare's servers can't reach USAspending), and /awards/ reads what it
stored in D1 (federal_awards_cache). Tested in tools/test_usaspending.py.

Matching: only recipients whose name is exactly the organization's (name_key(),
the same rule as nameKey() in functions/awards/index.js). USAspending lists one
organization several times (a parent record, a child record, a bare recipient
record), often with the money on only one of them: each organization is shown
once, by the record with the most money. Different organizations can share a
name, so each is shown separately with its location; up to three.
"""
import datetime
import json
import re
import urllib.error
import urllib.request

API = "https://api.usaspending.gov/api/v2/"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
YEARS = 4  # this fiscal year and the three before it
MAX_RECIPIENTS = 3
STOP = {"the", "inc", "incorporated", "llc", "corp", "corporation", "co", "ltd"}
LEVEL_RANK = {"P": 0, "C": 1, "R": 2}


def name_key(name):
    """An organization's name for exact matching: lowercase, no punctuation or "Inc."/"The"."""
    words = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in STOP)


def fiscal_years(today=None, n=YEARS):
    """[{fy, start, end}], newest first; a fiscal year starts October 1 of the year before."""
    today = today or datetime.date.today()
    fy = today.year + (1 if today.month >= 10 else 0)
    return [{"fy": fy - i, "start": f"{fy - i - 1}-10-01", "end": f"{fy - i}-09-30"} for i in range(n)]


def pick_recipients(results, name):
    """
    The recipient records to show for this exact name: one per organization
    (records whose IDs differ only by the -P/-C/-R level are the same one),
    the record with the most money, largest first; organizations with money
    before those without; at most MAX_RECIPIENTS.
    """
    key = name_key(name)
    groups = {}
    for r in results or []:
        if name_key(r.get("name")) != key or not r.get("id"):
            continue
        base = re.sub(r"-[PCR]$", "", r["id"])
        groups.setdefault(base, []).append(r)
    picked = []
    for rows in groups.values():
        best = sorted(rows, key=lambda r: (-(r.get("amount") or 0), LEVEL_RANK.get(r.get("recipient_level"), 9)))[0]
        picked.append(best)
    picked.sort(key=lambda r: -(r.get("amount") or 0))
    with_money = [r for r in picked if (r.get("amount") or 0) > 0]
    return {"total_found": len(picked), "recipients": (with_money or picked)[:MAX_RECIPIENTS]}


def _post(path, body, timeout=60):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _get(path, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(API + path, headers={"User-Agent": UA}), timeout=timeout) as r:
        return json.load(r)


def lookup(name, today=None, post=_post, get=_get):
    """The result /awards/ shows: {name, total_found, recipients: [{id, name, uei, level, location, years}], fiscal_years, checked}."""
    found = post("recipient/", {"keyword": name, "award_type": "all", "limit": 50})
    pick = pick_recipients(found.get("results"), name)
    fys = fiscal_years(today)
    recipients = []
    for r in pick["recipients"]:
        try:
            profile = get(f"recipient/{r['id']}/")
        except urllib.error.HTTPError:
            profile = None
        loc = (profile or {}).get("location") or {}
        location = ", ".join(x for x in (loc.get("city_name"), loc.get("state_code") or loc.get("country_name")) if x)
        years = []
        for y in fys:
            d = post("search/spending_by_category/awarding_agency/",
                     {"filters": {"recipient_id": r["id"], "time_period": [{"start_date": y["start"], "end_date": y["end"]}]}, "limit": 10})
            agencies = [{"name": a["name"], "amount": a["amount"]} for a in d.get("results", []) if a.get("amount")]
            years.append({"fy": y["fy"], "total": round(sum(a["amount"] for a in agencies), 2), "agencies": agencies})
        recipients.append({"id": r["id"], "name": r.get("name"), "uei": r.get("uei"), "level": r.get("recipient_level"), "location": location, "years": years})
    return {"name": name, "total_found": pick["total_found"], "recipients": recipients, "fiscal_years": [y["fy"] for y in fys],
            "checked": (today or datetime.date.today()).isoformat()}
