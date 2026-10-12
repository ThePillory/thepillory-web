"""Temporary probe round 7: Senate public-law CDS download as a browser; a House enacted CPF table PDF's text."""
import io, json, re, urllib.request, urllib.error
from pathlib import Path
import pdfplumber
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
BROWSER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8"}
def get(url, h):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=180) as r:
            return r.status, r.headers.get("Content-Type"), r.headers.get("Content-Disposition"), r.read(), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), None, e.read()[:3000], url
res = {}
s, ct, cd, b, u = get("https://www.appropriations.senate.gov/download/fy26-thud-cds-public-law", BROWSER)
res["senate_dl"] = [s, ct, cd, u, len(b), b[:8].hex()]
h = b.decode("utf-8", "replace") if not b.startswith(b"%PDF") else ""
res["senate_dl_links"] = sorted(set(re.findall(r'(?:href|src|content)="([^"]*(?:imo|\.pdf|download)[^"]*)"', h)))[:30]
def tables(pdf):
    with pdfplumber.open(io.BytesIO(pdf)) as p:
        pg = p.pages[1] if len(p.pages) > 1 else p.pages[0]
        up = [c for c in pg.chars if c.get("upright")]
        out = {"pages": len(p.pages), "upright": [len(up), len(pg.chars)], "rotation": pg.rotation}
        # Rotated text: group characters by x (each printed line is a column of characters).
        cols = {}
        for c in pg.chars:
            cols.setdefault(round(c["x0"]), []).append(c)
        lines = []
        for x in sorted(cols, reverse=True):
            cs = sorted(cols[x], key=lambda c: -c["top"])
            lines.append((x, "".join(c["text"] for c in cs)))
        out["rot_lines"] = [l for _, l in lines][:50]
        out["text"] = (pg.extract_text() or "")[:1200]
        return out
if b.startswith(b"%PDF"):
    res["senate_pl"] = tables(b)
s, ct, cd, b, u = get("https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/fy26-military-construction%2C-veterans-affairs-cpf-table.pdf", BROWSER)
res["house_enacted"] = [s, ct, len(b)]
if b.startswith(b"%PDF"):
    res["house_enacted_tables"] = tables(b)
(OUT / "govmoney7.json").write_text(json.dumps(res, indent=1, default=str))
