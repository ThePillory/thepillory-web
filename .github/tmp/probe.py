import re, urllib.request, io
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records research)"}
def get(url):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url.replace(" ", "%20"), headers=UA), timeout=120); return r.status, r.read()
    except Exception as e: return getattr(e, "code", "ERR"), b""
s, b = get("https://dof.ca.gov/budget/historical-budget-information/summary-schedules-and-historical-charts/")
print("DOF charts", s)
links = sorted(set(re.findall(r'href="([^"]+)"', b.decode("utf-8", "ignore"))))
for l in links:
    if re.search(r"xls|pdf|chart", l, re.I): print("  ", l)
import openpyxl
for l in links:
    if re.search(r"chart.?a|chart.?b|chart.?k|chart.?p", l, re.I) and l.lower().endswith(("xlsx", "xls")):
        u = l if l.startswith("http") else "https://dof.ca.gov" + l
        s, x = get(u); print("\n=====", u, s, len(x))
        try:
            wb = openpyxl.load_workbook(io.BytesIO(x), read_only=True, data_only=True)
            for ws in wb.worksheets[:1]:
                for i, r in enumerate(ws.iter_rows(values_only=True)):
                    if i < 12 or i % 10 == 0: print("  ", [c for c in r[:9]])
                    if i > 80: break
        except Exception as e: print("err", e)
s, b = get("https://elections.calaverasgov.us/Results/Previous-Elections")
t = b.decode("utf-8", "ignore")
print("\nCalaveras previous", s, len(t))
for m in re.finditer(r"(Portals/[^\"']+|\.pdf[^\"']*)", t): print("  ", t[max(0, m.start()-120): m.end()+20].replace("\n", " "))
for m in list(re.finditer(r"(19|20)\d\d", t))[:5]: print("  yr ...", re.sub(r"\s+", " ", t[max(0, m.start()-200): m.end()+200]))
s, b = get("https://www.calaverasgov.us/Government/Board-of-Supervisors/Past-Supervisors"); print("\npast supervisors", s, len(b))
s, b = get("https://elections.calaverasgov.us/Portals/Elections/Documents/Results/"); print("results dir", s, len(b))
