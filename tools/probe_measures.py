#!/usr/bin/env python3
"""Temporary probe: how November 2026 ballot measure committees appear in the Cal-Access export. Not kept."""
import collections, csv, io, re, sys, urllib.request, zipfile
sys.path.insert(0, "tools")
from build_ca_campaign import rows, iso, EXPORT  # noqa
from pathlib import Path
work = Path(sys.argv[1]); work.mkdir(parents=True, exist_ok=True)
zp = work / "dbwebexport.zip"
if not zp.exists():
    req = urllib.request.Request(EXPORT, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
    with urllib.request.urlopen(req) as res, open(zp, "wb") as f:
        while chunk := res.read(1 << 20): f.write(chunk)
zf = zipfile.ZipFile(zp)
print("TABLES:", sorted({n.split("/")[-1] for n in zf.namelist()}))
ent = collections.Counter(); combos = collections.Counter(); ex = {}
for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
    thru = iso(r.get("THRU_DATE")) or iso(r.get("RPT_DATE")) or ""
    if thru < "2026-01-01": continue
    bn = (r.get("BAL_NUM") or "").strip(); bname = (r.get("BAL_NAME") or "").strip()
    if not bn and not bname: continue
    ent[(r["FORM_TYPE"], r["ENTITY_CD"])] += 1
    k = (bn, (r.get("BAL_JURIS") or "").strip()[:20], (r.get("SUP_OPP_CD") or "").strip(), bname[:50])
    combos[k] += 1; ex.setdefault(k, (r["FILER_ID"], (r["FILER_NAML"] or "")[:70], thru))
print("CVR entity counts 2026 with BAL fields:", ent.most_common(20))
for k, n in combos.most_common(120): print("CVR", n, k, ex[k])
c2 = collections.Counter(); first = None
for r in rows(zf, "CVR2_CAMPAIGN_DISCLOSURE_CD"):
    if first is None: first = list(r.keys()); print("CVR2 cols:", first)
    bn = (r.get("BAL_NUM") or "").strip()
    if bn: c2[(r["FORM_TYPE"], r["ENTITY_CD"], bn, (r.get("SUP_OPP_CD") or "").strip(), (r.get("BAL_NAME") or "")[:40])] += 1
for k, n in c2.most_common(60): print("CVR2", n, k)
print("CVR_SO cols:", list(next(rows(zf, "CVR_SO_CD")).keys()))
so = collections.Counter()
for r in rows(zf, "CVR_SO_CD"):
    d = iso(r.get("RPT_DATE")) or ""
    if d >= "2025-06-01": so[(r.get("ENTITY_CD"), (r.get("COMMITTEE_TYPE") or r.get("CMTTE_TYPE") or "").strip())] += 1
print("CVR_SO 2025+ entity/type:", so.most_common(20))
for u in ["https://cal-access.sos.ca.gov/Campaign/Measures/", "https://cal-access.sos.ca.gov/Campaign/Measures/list.aspx?session=2025"]:
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        print("PAGE", u, len(html)); print(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))[:2500])
        print("LINKS", sorted(set(re.findall(r'href="([^"]*(?:Measure|measure|Detail)[^"]*)"', html)))[:80])
    except Exception as e:
        print("PAGE ERR", u, e)
