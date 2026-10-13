import re, subprocess, sys, tempfile, urllib.request
UA = "Mozilla/5.0 (ThePillory candidate list research; +https://thepillory.co)"
NJ = "https://www.nj.gov/state/elections/assets/pdf/election-results/2026/"
URLS = [
 ("NC csv", "https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/Candidate_Listing_2026.csv"),
 ("NC general pdf", "https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/2026_general_candidate_list_by_contest_federal_and_state.pdf"),
 ("NJ cert", NJ + "2026-certification-of-general-election-nominees_us-senate_us-house.pdf"),
 ("NJ amended senate", NJ + "2026-certification-amended-certification-of-nominees-general-us-senate.pdf"),
 ("NJ amended 7", NJ + "2026-certification-amended-7th-congressional-district-us-house.pdf"),
 ("FL canlist", "https://election.myflorida.com/candidate/CanList.asp?elecid=20261103-GEN"),
 ("FL canlist2", "https://dos.elections.myflorida.com/candidates/canlist.asp?elecid=20261103-GEN"),
 ("FL download", "https://dos.elections.myflorida.com/candidates/downloadcanlist.asp?elecid=20261103-GEN&cantype=STA&office=&status="),
 ("TX civix", "https://goelect.txelections.civixapps.com/ivis-cbp-ui/candidate-information"),
 ("PA", "https://www.pavoterservices.pa.gov/ElectionInfo/ElectionInfo.aspx"),
 ("IL", "https://www.elections.il.gov/ElectionOperations/CandidateList.aspx"),
 ("NY via archive", "https://web.archive.org/web/2026/https://elections.ny.gov/certification-november-3-2026-general-election"),
 ("OH via archive", "https://web.archive.org/web/2026/https://www.ohiosos.gov/elections/election-results-and-data/2026/"),
 ("GA via archive", "https://web.archive.org/web/2026/https://sos.ga.gov/page/2026-elections"),
 ("MI via archive", "https://web.archive.org/web/2026/https://www.michigan.gov/sos/elections/upcoming-elections"),
]
for name, url in URLS:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
            body = r.read(20_000_000); ct = r.headers.get("Content-Type", ""); final = r.geturl()
    except Exception as e:
        print(f"\n### {name} ERROR {e}"); continue
    print(f"\n### {name} [{ct}] {len(body)} bytes {final}")
    if body[:4] == b"%PDF":
        f = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False); f.write(body); f.close()
        t = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout
        print(t[:3500])
    else:
        t = body.decode("utf-8", "replace")
        if "html" in ct:
            links = re.findall(r'href="([^"]+)"[^>]*>([^<]{0,80})', t)
            for h, x in links:
                if re.search(r"candid|certif|general|2026|xls|csv|pdf|api", h + x, re.I):
                    print(f"  {x.strip()[:70]!r} -> {h[:180]}")
            print(re.sub(r"\s+", " ", re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", t, flags=re.S))[:1500])
        else:
            print(t[:2500])
