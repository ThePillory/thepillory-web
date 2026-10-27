#!/usr/bin/env python3
"""Temporary probe: primarily formed committees for the November 2026 propositions. Not kept."""
import collections, re, sys, urllib.request, zipfile
sys.path.insert(0, "tools")
from build_ca_campaign import rows, iso, EXPORT, money  # noqa
from pathlib import Path
work = Path(sys.argv[1]); work.mkdir(parents=True, exist_ok=True)
zp = work / "dbwebexport.zip"
if not zp.exists():
    req = urllib.request.Request(EXPORT, headers={"User-Agent": "ThePillory data build (thepillory.co)"})
    with urllib.request.urlopen(req) as res, open(zp, "wb") as f:
        while chunk := res.read(1 << 20): f.write(chunk)
zf = zipfile.ZipFile(zp)
PROPS = {"1", "2", "3", "4", "5", "37", "38", "39", "40", "41", "42", "43", "44", "45"}
def num(s):
    m = re.fullmatch(r"\s*(?:PROP(?:OSITION|\.)?\s*)?0*(\d{1,3})\s*", (s or "").upper())
    return m.group(1) if m else None
# Latest Form 410 per filer since 2024.
so = {}
for r in rows(zf, "CVR_SO_CD"):
    d = iso(r.get("RPT_DATE")) or ""
    if d < "2024-01-01": continue
    k = r["FILER_ID"]; a = int(r.get("AMEND_ID") or 0)
    if k not in so or (d, a) > (so[k]["d"], so[k]["a"]):
        so[k] = {"d": d, "a": a, "fid": r["FILING_ID"], "prim": (r.get("PRIMFC_CB") or "").strip(), "gen": (r.get("GENPURP_CB") or "").strip(), "name": r.get("FILER_NAML"), "ent": r.get("ENTITY_CD")}
fids = {v["fid"]: k for k, v in so.items()}
so2 = collections.defaultdict(list); cols = None
for r in rows(zf, "CVR2_SO_CD"):
    if cols is None: cols = list(r.keys()); print("CVR2_SO cols", cols)
    if r["FILING_ID"] in fids:
        so2[fids[r["FILING_ID"]]].append({k: (r.get(k) or "").strip() for k in ("ENTITY_CD", "BAL_NUM", "BAL_NAME", "BAL_JURIS", "SUP_OPP_CD", "ITEM_CD") if k in r})
print("PRIM counts", collections.Counter(v["prim"] for v in so.values()).most_common(), collections.Counter(v["gen"] for v in so.values()).most_common())
# F460 covers since 2026-06-25 naming a 2026 prop number.
hits = collections.defaultdict(lambda: {"sides": collections.Counter(), "juris": set(), "name": "", "ent": set()})
for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
    if r["FORM_TYPE"] not in ("F460", "F496"): continue
    t = iso(r.get("THRU_DATE")) or iso(r.get("RPT_DATE")) or ""
    if t < "2026-06-25": continue
    n = num(r.get("BAL_NUM"))
    if n not in PROPS: continue
    h = hits[(n, r["FILER_ID"])]; h["sides"][(r.get("SUP_OPP_CD") or "").strip()] += 1; h["juris"].add((r.get("BAL_JURIS") or "").strip()[:15]); h["name"] = r["FILER_NAML"]; h["ent"].add(r["ENTITY_CD"] + "/" + r["FORM_TYPE"])
for (n, f), h in sorted(hits.items(), key=lambda x: (int(x[0][0]), x[0][1])):
    s = so.get(f, {})
    print("P", n, f, (h["name"] or "")[:60], dict(h["sides"]), sorted(h["ent"]), "410:", s.get("prim"), s.get("gen"), s.get("ent"), "410 measures:", [(x.get("BAL_NUM"), x.get("SUP_OPP_CD"), (x.get("BAL_NAME") or "")[:30]) for x in so2.get(f, [])][:4])
