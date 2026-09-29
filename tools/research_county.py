"""TEMPORARY research script (removed before merge): agenda item markup, published links, agenda PDF text."""
import subprocess, re, html
BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
B = "https://calaverascountyca.iqm2.com"
def get(u, out=None):
    args = ["curl", "-sS", "-L", "-m", "120", "-A", BROWSER, u] + (["-o", out] if out else [])
    r = subprocess.run(args, capture_output=True)
    return r.stdout.decode("utf-8", "replace")
print("ROBOTS:", get(B + "/robots.txt")[:800])
d = get(B + "/Citizens/Detail_Meeting.aspx?ID=2822")
i = d.find("Consent Agenda")
print("\n##### ITEMS RAW 2822\n", d[i-6000:i+9000])
print("\n##### ALL HREFS 2822\n", sorted(set(re.findall(r"href=['\"]([^'\"]+)['\"]", d)))[:120])
cal = get(B + "/Citizens/calendar.aspx?View=List")
for mid in ["2822", "2793"]:
    j = cal.find(f"ID={mid}")
    print(f"\n##### CALENDAR ROW {mid}\n", cal[j-600:j+2600])
get(B + "/Citizens/FileOpen.aspx?Type=14&ID=2040&Inline=True", "/tmp/agenda.pdf")
print("\nPDF bytes:", len(open("/tmp/agenda.pdf", "rb").read()), open("/tmp/agenda.pdf", "rb").read()[:8])
