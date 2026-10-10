# TEMPORARY research probe: incomplete lineups. Remove before merge.
import json, sys
sys.path.insert(0, "tools")
import build_scotus as B
out = []
for term, dk in [(2025, "24-5774"), (2025, "25-1083"), (2025, "24-699"), (2025, "141, Orig."), (2022, "21-1086"), (2021, "21-309"), (2022, "21-476"), (2024, "24-297")]:
    c = next(x for x in json.load(open(f"data/scotus/terms/{term}.json"))["cases"] if x["docket"] == dk)
    t = B.pdf_text(B.fetch(c["pdf"], binary=True), layout=True)
    p = B.lineup_paragraph(t)
    i = t.find("delivered the opinion")
    out.append(f"===== OT{term} {dk}\nPARA: {p}\nRAW: {t[max(0, i - 300): i + 1200] if i >= 0 else t[:1500]}")
open("tmp-research/lineup-probe2.txt", "w").write("\n".join(out))
