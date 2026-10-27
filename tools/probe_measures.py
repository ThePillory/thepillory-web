#!/usr/bin/env python3
"""Temporary probe: a Cal-Access proposition page's committees. Not kept."""
import re, time, urllib.request
UA = {"User-Agent": "ThePillory data build (thepillory.co)"}
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read().decode("utf-8", "replace")
idx = get("https://cal-access.sos.ca.gov/Campaign/Measures/")
print("INDEX LINKS", re.findall(r"href='(Detail\.aspx\?id=\d+&session=\d+)'>(PROPOSITION \d+)", idx))
for pid in ("1492875", "1492876"):
    time.sleep(2)
    try:
        h = get(f"https://cal-access.sos.ca.gov/Campaign/Measures/Detail.aspx?id={pid}&session=2025")
        t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", h))
        i = t.find("SUPPORT"); print("DETAIL", pid, len(h)); print(t[max(0, i - 1500):i + 3000])
        print("COMMITTEE LINKS", re.findall(r"href='?\"?([^'\" >]*Committees/Detail\.aspx\?id=\d+[^'\" >]*)", h)[:40])
        j = h.find("SUPPORT"); print("RAW", h[max(0, j - 400):j + 1500])
    except Exception as e:
        print("DETAIL ERR", pid, e)
