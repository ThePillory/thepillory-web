#!/usr/bin/env python3
"""Temporary probe: how the export links November 2026 propositions to their committees. Not kept."""
import collections, re, sys, urllib.request, zipfile
sys.path.insert(0, "tools")
from build_ca_campaign import rows, EXPORT  # noqa
from pathlib import Path
work = Path(sys.argv[1]); work.mkdir(parents=True, exist_ok=True)
zp = work / "dbwebexport.zip"
if not zp.exists():
    req = urllib.request.Request(EXPORT, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
    with urllib.request.urlopen(req) as res, open(zp, "wb") as f:
        while chunk := res.read(1 << 20): f.write(chunk)
zf = zipfile.ZipFile(zp)
bm = list(rows(zf, "BALLOT_MEASURES_CD"))
print("BALLOT_MEASURES cols:", list(bm[0].keys()) if bm else None, len(bm))
recent = [r for r in bm if "2026" in (r.get("ELECTION_DATE") or "")]
for r in recent[:80]: print("BM", dict(r))
ids = {r.get("FILER_ID") for r in recent}
fl = rows(zf, "FILER_LINKS_CD")
first = True; types = collections.Counter(); hits = []
for r in fl:
    if first: print("FILER_LINKS cols:", list(r.keys())); first = False
    a, b = r.get("FILER_ID_A"), r.get("FILER_ID_B")
    if a in ids or b in ids:
        types[r.get("LINK_TYPE")] += 1
        if len(hits) < 80: hits.append(dict(r))
print("LINK types for 2026 measures:", types.most_common())
for h in hits: print("LINK", h)
lk = [r for r in rows(zf, "LOOKUP_CODES_CD") if r.get("CODE_TYPE") in ("16000", "16001", "16002") or "LINK" in (r.get("CODE_DESC") or "").upper()]
for r in lk[:40]: print("LOOKUP", dict(r))
names = {}
for r in rows(zf, "FILERNAME_CD"):
    if r.get("FILER_ID") in ids: names[r["FILER_ID"]] = (r.get("FILER_TYPE"), r.get("NAML"))
print("MEASURE FILER NAMES", list(names.items())[:30])
req = urllib.request.Request("https://cal-access.sos.ca.gov/Campaign/Measures/", headers={"User-Agent": "ThePillory data build (thepillory.co)"})
html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
i = html.find("PROPOSITION 004"); print("HTML near Prop 4:", html[max(0, i - 700):i + 300])
