# TEMPORARY (removed before merge): ballot-order law (Elections Code 13111, 13112) and the randomized alphabet press release.
import re, html, urllib.request
UA = "Mozilla/5.0 (ThePillory civic records; +https://thepillory.co)"
def text(u):
    try:
        h = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")
    except Exception as e:
        return f"ERROR {e}"
    h = re.sub(r"<(script|style|nav|footer|header)[\s\S]*?</\1>", " ", h, flags=re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h)))
for sec in ["13111", "13112"]:
    t = text(f"https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=ELEC&sectionNum={sec}.")
    i = t.find(f"{sec}.")
    print(f"\n==== ELEC {sec}\n", t[i:i+4500])
t = text("https://www.sos.ca.gov/administration/news-releases-and-advisories/2026-news-releases-and-advisories/california-secretary-state-shirley-n-weber-phd-announces-results-randomized-alphabet-drawing-november-3-2026-general-election")
i = t.find("randomized"); print("\n==== PRESS RELEASE\n", t[max(0, i-500):i+2500])
