"""TEMPORARY research script (removed before merge): does the portal answer the sync Worker's User-Agent?"""
import subprocess, time
B = "https://calaverascountyca.iqm2.com/Citizens/calendar.aspx?View=List"
for ua in ["ThePilloryDataSync/1.0 (+https://thepillory.co)", "Python-urllib/3.12", "Mozilla/5.0 (compatible; thepillory-research; +https://thepillory.co)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36"]:
    t = time.time()
    r = subprocess.run(["curl", "-sS", "-m", "60", "-A", ua, "-o", "/dev/null", "-w", "%{http_code} %{size_download}", B], capture_output=True, text=True)
    print(f"UA={ua!r}: {r.stdout} rc={r.returncode} {r.stderr.strip()} {time.time()-t:.1f}s")
    time.sleep(5)
