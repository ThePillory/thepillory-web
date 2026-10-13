import re, sys, urllib.request, html
UA = "Mozilla/5.0 (ThePillory candidate list research; +https://thepillory.co)"
PAGES = {
 "TX": ["https://www.sos.state.tx.us/elections/candidates/index.shtml", "https://candidate.texas-election.com/Elections/getQualifiedCandidatesInfo.do"],
 "FL": ["https://dos.fl.gov/elections/candidates-committees/candidates/", "https://dos.elections.myflorida.com/candidates/", "https://dos.elections.myflorida.com/candidates/downloadcanlist.asp?elecid=20261103-GEN"],
 "NY": ["https://elections.ny.gov/certification-november-3-2026-general-election", "https://elections.ny.gov/2026-election-information", "https://elections.ny.gov/candidate-petition-filings"],
 "PA": ["https://www.pa.gov/agencies/dos/programs/voting-and-elections/running-for-office/candidates-on-ballot", "https://www.pavoterservices.pa.gov/ElectionInfo/ElectionInfo.aspx"],
 "IL": ["https://www.elections.il.gov/ElectionOperations/CandidateList.aspx", "https://www.elections.il.gov/electionoperations/ElectionVoteTotals.aspx"],
 "OH": ["https://www.ohiosos.gov/elections/election-results-and-data/2026/", "https://www.ohiosos.gov/elections/candidates/"],
 "GA": ["https://sos.ga.gov/page/2026-elections", "https://sos.ga.gov/elections-division"],
 "NC": ["https://www.ncsbe.gov/results-data/candidate-lists", "https://dl.ncsbe.gov/?prefix=Elections/2026/Candidate%20Filing/"],
 "MI": ["https://www.michigan.gov/sos/elections/upcoming-elections", "https://mvic.sos.state.mi.us/votehistory/Index"],
 "NJ": ["https://www.nj.gov/state/elections/election-information-2026.shtml", "https://www.nj.gov/state/elections/candidate-information.shtml"],
}
for st in (sys.argv[1:] or PAGES):
    for url in PAGES[st]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read(3_000_000).decode("utf-8", "replace")
                ct = r.headers.get("Content-Type", "")
            print(f"\n== {st} {url} [{ct}] {len(body)} bytes")
            if "html" not in ct:
                print(body[:1500]); continue
            seen = set()
            for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', body, re.S | re.I):
                t = html.unescape(re.sub(r"<[^>]+>|\s+", " ", text)).strip()
                if re.search(r"candidat|general election|certif|ballot", t + href, re.I) and re.search(r"2026|general|candidat", t + href, re.I) and href not in seen:
                    seen.add(href); print(f"  {t[:90]!r} -> {href[:200]}")
        except Exception as e:
            print(f"\n== {st} {url} ERROR {e}")
