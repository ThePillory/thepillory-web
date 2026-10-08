import json, re, sys, urllib.request, html, io, zipfile, subprocess, tempfile
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records research)"}
def get(url, n=30000000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url.replace(" ", "%20"), headers=UA), timeout=120)
        return r.status, r.headers.get("Content-Type", ""), r.read(n)
    except Exception as e:
        return getattr(e, "code", "ERR"), str(e)[:200], b""
def hdr(l, u, s, ct, b): print(f"\n===== {l} | {u} -> {s} [{ct[:40]}] {len(b)} bytes")
def links(l, u, pat):
    s, ct, b = get(u); hdr(l, u, s, ct, b)
    for x in sorted(set(re.findall(r'href="([^"]+)"', b.decode("utf-8", "ignore")))):
        if re.search(pat, x, re.I): print("  ", x)
def head(l, u, n=2500):
    s, ct, b = get(u); hdr(l, u, s, ct, b); print(b[:n].decode("latin-1"))
def pdf(l, u, n=3500, grep=None):
    s, ct, b = get(u); hdr(l, u, s, ct, b)
    if not b: return
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(b); f.flush()
        t = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout
    if grep:
        for m in list(re.finditer(grep, t))[:4]: print("  ...", t[max(0, m.start()-300): m.end()+900])
    else: print(t[:n])
def xlsx(l, u, rows=25):
    s, ct, b = get(u); hdr(l, u, s, ct, b)
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(b), read_only=True, data_only=True)
        for ws in wb.worksheets[:1]:
            print("sheet", ws.title)
            for i, r in enumerate(ws.iter_rows(values_only=True)):
                if i < rows or i % 20 == 0: print("  ", [c for c in r[:12]])
                if i > 140: break
    except Exception as e: print("xlsx err", e)
def xls(l, u, rows=25):
    s, ct, b = get(u); hdr(l, u, s, ct, b)
    try:
        import xlrd
        wb = xlrd.open_workbook(file_contents=b); ws = wb.sheet_by_index(0)
        for i in range(min(ws.nrows, 90)):
            if i < rows or i % 10 == 0: print("  ", ws.row_values(i)[:10])
    except Exception as e: print("xls err", e)
links("DOF historical budget", "https://dof.ca.gov/budget/historical-budget-information/", r"pdf|xls|chart|summary|histor")
links("relfiles cd108 CA", "https://www2.census.gov/geo/relfiles/cd108th/CA/", r".")
head("co_cd_06 cdsld13", "https://www2.census.gov/geo/relfiles/cdsld13/06/co_cd_delim_06.txt", 1200)
head("co_lu_06 cdsld13", "https://www2.census.gov/geo/relfiles/cdsld13/06/co_lu_delim_06.txt", 800)
head("co_cd_06 cdsld18", "https://www2.census.gov/geo/relfiles/cdsld18/06/co_cd_delim_06.txt", 800)
pdf("SOV 2022 governor", "https://elections.cdn.sos.ca.gov/sov/2022-general/sov/19-governor.pdf", 2500)
pdf("SOV 2022 summary", "https://elections.cdn.sos.ca.gov/sov/2022-general/sov/06-summary.pdf", 6000)
pdf("SOV 2002 sum", "https://elections.cdn.sos.ca.gov/sov/2002-general/sum.pdf", 6000)
pdf("SOV 2002 ltgov", "https://elections.cdn.sos.ca.gov/sov/2002-general/ltgov.pdf", 2500)
xlsx("OMB 1.1", "https://www.whitehouse.gov/wp-content/uploads/2026/04/hist01z1_fy2027.xlsx", 12)
xlsx("OMB 3.1", "https://www.whitehouse.gov/wp-content/uploads/2026/04/hist03z1_fy2027.xlsx", 12)
xlsx("OMB 7.1", "https://www.whitehouse.gov/wp-content/uploads/2026/04/hist07z1_fy2027.xlsx", 10)
xlsx("OMB 10.1", "https://www.whitehouse.gov/wp-content/uploads/2026/04/hist10z1_fy2027.xlsx", 10)
xls("HH-1", "https://www2.census.gov/programs-surveys/demo/tables/families/time-series/households/hh1.xls", 20)
head("Census pop 2000s", "https://www2.census.gov/programs-surveys/popest/datasets/2000-2010/intercensal/national/us-est00int-tot.csv", 1200)
head("Census pop 2010s", "https://www2.census.gov/programs-surveys/popest/datasets/2010-2020/national/totals/nst-est2020.csv", 900)
head("Census pop 2020s", "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/NST-EST2025-ALLDATA.csv", 900)
links("DOF E-4 2021-2026", "https://dof.ca.gov/forecasting/demographics/estimates/e-4-population-estimates-for-cities-counties-and-the-state-2021-2026-with-2020-census-benchmark/", r"xls")
links("DOF E-8 2000-2010", "https://dof.ca.gov/forecasting/demographics/estimates/estimates-e8-2000-2010/", r"xls")
links("DOF E-8 2010-2020", "https://dof.ca.gov/forecasting/demographics/estimates/estimates-e8-2010-2020/", r"xls")
links("DOF E-5 2020-2026", "https://dof.ca.gov/forecasting/demographics/estimates/e-5-population-and-housing-estimates-for-cities-counties-and-the-state-2020-2026/", r"xls")
s, ct, b = get("https://www.nber.org/research/business-cycle-dating"); t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", b.decode("utf-8", "ignore")))
for m in re.finditer(r"(March|December|February|November|June|April) (2001|2007|2009|2020)", t): print("NBER", t[max(0,m.start()-200):m.end()+200]); 
s, ct, b = get("https://api.github.com/repos/openstates/people/contents/data/ca/legislature"); print("\nopenstates current CA files:", len(json.loads(b)) if b else s)
