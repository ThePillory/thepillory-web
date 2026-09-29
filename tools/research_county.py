"""TEMPORARY research script (removed before merge): what does a meeting's web agenda contain?"""
import subprocess, re, html
BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
def get(u):
    r = subprocess.run(["curl", "-sS", "-L", "-m", "120", "-A", BROWSER, u], capture_output=True)
    return r.stdout.decode("utf-8", "replace")
def text(b):
    b = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", b)
    b = re.sub(r"(?i)<(br|/p|/div|/tr|/li|/h\d)\b[^>]*>", "\n", b)
    return "\n".join(l for l in (re.sub(r"\s+", " ", x).strip() for x in html.unescape(re.sub(r"(?s)<[^>]+>", " ", b)).split("\n")) if l)
cal = get("https://calaverascountyca.iqm2.com/Citizens/calendar.aspx?View=List")
i = cal.find("Sep 22, 2026")
print("CALENDAR RAW around Sep 22:\n", cal[max(0, i-3000):i+2500])
bos = re.findall(r"Detail_Meeting\.aspx\?ID=(\d+)[^<]*</a>[\s\S]{0,1500}?Board of Supervisors - Regular", cal)
print("BOS ids:", bos[-5:])
for mid in ["2822", "2793"]:
    b = get(f"https://calaverascountyca.iqm2.com/Citizens/Detail_Meeting.aspx?ID={mid}")
    print(f"\n\n########## Detail_Meeting {mid}: {len(b)} bytes")
    print("LINKS:", sorted(set(html.unescape(m) for m in re.findall(r'href="([^"]+)"', b) if re.search(r"FileOpen|Detail_LegiFile|youtube|zoom|SplitView|Video", m, re.I)))[:60])
    print("TEXT:\n", text(b)[:9000])
    j = b.find("MeetingDetail")
    print("RAW:\n", b[j:j+9000] if j >= 0 else b[20000:29000])
