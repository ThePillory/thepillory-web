# TEMPORARY research probe: why lineups aren't found. Remove before merge.
import json, re, subprocess, sys, urllib.request
sys.path.insert(0, "tools")
import build_scotus as B
out = []
for term in (2024, 2022, 2025):
    d = json.load(open(f"data/scotus/terms/{term}.json"))
    picks = [c for c in d["cases"] if c.get("author_code") != "PC" and not c.get("lineup")][:3]
    for c in picks:
        raw = B.fetch(c["pdf"], binary=True)
        for mode in (True, False):
            t = B.pdf_text(raw, layout=mode)
            hits = [m.start() for m in re.finditer(r"delivered the opinion|PER CURIAM", t, re.I)][:2]
            out.append(f"===== OT{term} {c['docket']} layout={mode} chars={len(t)} hits={hits}")
            for h in hits:
                out.append(t[max(0, h - 400): h + 900])
open("tmp-research/lineup-probe.txt", "w").write("\n".join(out))
