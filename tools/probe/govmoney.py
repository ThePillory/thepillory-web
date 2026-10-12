"""Temporary probe round 8: pdftotext -layout on Senate CDS (committee and public law) and House enacted CPF tables."""
import json, subprocess, urllib.request, urllib.error
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
BROWSER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
res = {}
for name, url in [("senate_pl_thud", "https://www.appropriations.senate.gov/download/fy26-thud-cds-public-law&download=1"),
                  ("senate_pl_ag", "https://www.appropriations.senate.gov/download/fy26-ag-cds-public-law&download=1"),
                  ("senate_cmte_thud", "https://www.appropriations.senate.gov/imo/media/doc/fy26_thud_cds.pdf"),
                  ("house_enacted_milcon", "https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/fy26-military-construction%2C-veterans-affairs-cpf-table.pdf"),
                  ("house_enacted_ag", "https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/fy26-agriculture%2C-rural-development%2C-fda-cpf-table-with-technical-and-conforming-changes.pdf")]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=BROWSER), timeout=180) as r:
            b = r.read(); ct = r.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        res[name] = [e.code]; continue
    if not b.startswith(b"%PDF"):
        res[name] = ["not pdf", ct, len(b)]; continue
    p = OUT / f"{name}.pdf"; p.write_bytes(b)
    t = subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "3", str(p), "-"], capture_output=True, text=True).stdout
    info = subprocess.run(["pdfinfo", str(p)], capture_output=True, text=True).stdout
    res[name] = {"bytes": len(b), "info": info[-400:], "text": t[:5000]}
    p.unlink()
(OUT / "govmoney8.json").write_text(json.dumps(res, indent=1))
