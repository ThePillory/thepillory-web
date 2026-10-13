#!/usr/bin/env python3
"""Temporary, read-only: how much dark-money data is loaded, and 20 labeled
groups checked against their public records (IRS via ProPublica, FEC)."""
import json, os, random, re, sys, time, urllib.parse, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import load_trades as T  # noqa: E402

class A: database = "pillory"
q = lambda sql: T.d1(A, command=sql)
UA = "ThePillory accuracy check (+https://thepillory.co)"
FEC = os.environ.get("FEC_API_KEY") or "DEMO_KEY"

def get(url):
    for wait in (2, 5, 15, None):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if wait is None:
                return {"_error": str(e)}
            time.sleep(wait)

def norm(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", (s or "").upper().replace("&", " AND "))
    s = re.sub(r"\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|LLC|L L C|LTD|ASSOCIATION|ASSN)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()

print("# Dark money: what's loaded\n")
for label, sql in [
    ("Outside spenders whose donors were read (spender, period)", "SELECT COUNT(*) n, COUNT(DISTINCT committee_id) spenders, SUM(truncated) truncated FROM outside_donor_reads"),
    ("Donors stored, by label", "SELECT kind, COUNT(*) n, ROUND(SUM(total)) total FROM outside_donors GROUP BY kind ORDER BY n DESC"),
    ("Spender reads with a 'don't disclose' share above 0", "SELECT COUNT(*) n FROM outside_donor_reads WHERE dark_total > 0"),
    ("Nonprofits with Form 990 figures", "SELECT subsection, political_read, COUNT(*) n FROM nonprofits GROUP BY 1, 2 ORDER BY 1, 2"),
    ("IRS lookups (one match only)", "SELECT COUNT(*) asked, SUM(ein IS NOT NULL) matched FROM org_lookups"),
    ("Electioneering (Form 9) rows", "SELECT cycle, COUNT(*) n, COUNT(DISTINCT candidate_id) candidates, COUNT(DISTINCT committee_id) spenders FROM electioneering GROUP BY cycle"),
    ("Members of Congress whose outside spenders have donors read", "SELECT COUNT(DISTINCT x.official_id) n FROM funding_outside x JOIN outside_donor_reads r ON r.committee_id = x.committee_id AND r.cycle = x.cycle"),
]:
    try:
        rows = q(sql)
    except SystemExit as e:
        rows = [{"error": str(e)[:300]}]
    print(f"## {label}")
    for r in rows:
        print("- " + ", ".join(f"{k}: {v}" for k, v in r.items()))
    print()

random.seed(20261013)
picked = []
for kind, n in (("c4", 5), ("c6", 5), ("committee", 5), ("llc", 5)):
    rows = q(f"SELECT committee_id, cycle, name, kind, donor_committee_id, ein, state, total, count, source_url FROM outside_donors WHERE kind = '{kind}'")
    picked += random.sample(rows, min(n, len(rows)))
print(f"# {len(picked)} labeled groups, checked against public records\n")
errors = 0
for d in picked:
    notes, ok = [], True
    if d["kind"] in ("c4", "c6"):
        o = get(f"https://projects.propublica.org/nonprofits/api/v2/organizations/{d['ein']}.json").get("organization") or {}
        sub = o.get("subsection_code")
        want = 4 if d["kind"] == "c4" else 6
        same_name = norm(o.get("name")) == norm(d["name"])
        same_state = (o.get("state") or "") == (d["state"] or "")
        if sub != want: ok = False
        if not same_name: ok = False
        if d["state"] and not same_state: ok = False
        notes.append(f"IRS (EIN {d['ein']}): {o.get('name')!r}, {o.get('state')}, 501(c)({sub})")
    elif d["kind"] == "committee":
        c = (get(f"https://api.open.fec.gov/v1/committee/{d['donor_committee_id']}/?api_key={FEC}").get("results") or [{}])[0]
        if norm(c.get("name")) != norm(d["name"]):
            ok = False
        notes.append(f"FEC {d['donor_committee_id']}: {c.get('name')!r}")
    else:
        if not re.search(r"\bL\.?\s?L\.?\s?C\.?\b", d["name"].upper()):
            ok = False
        notes.append("name ends in LLC" if ok else "name doesn't say LLC")
    # Every donor: the spender's own FEC receipts from it in the period.
    params = {"committee_id": d["committee_id"], "contributor_name": d["name"], "two_year_transaction_period": d["cycle"], "per_page": 100, "api_key": FEC}
    rs = get("https://api.open.fec.gov/v1/schedules/schedule_a/?" + urllib.parse.urlencode(params)).get("results") or []
    rs = [r for r in rs if (r.get("memo_code") or "") != "X" and norm(r.get("contributor_name")) == norm(d["name"])]
    fec_total = round(sum(float(r.get("contribution_receipt_amount") or 0) for r in rs), 2)
    if not rs:
        ok = False
        notes.append("not found in the spender's FEC receipts")
    else:
        diff = abs(fec_total - float(d["total"]))
        notes.append(f"FEC receipts: ${fec_total:,.0f} in {len(rs)} rows vs ThePillory ${float(d['total']):,.0f}{'' if diff <= max(1, 0.01 * fec_total) else ' (differs)'}")
    errors += 0 if ok else 1
    print(f"- {'OK ' if ok else 'CHECK'} [{d['kind']}] {d['name']} → spender {d['committee_id']} ({d['cycle']}): " + "; ".join(notes))
    time.sleep(1)
print(f"\nLabel errors: {errors} of {len(picked)}")
