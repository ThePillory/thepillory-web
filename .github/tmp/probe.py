import json, re, sys, urllib.request, urllib.parse, html
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records research)"}
def get(url, n=600000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60)
        b = r.read(n)
        return r.status, r.headers.get("Content-Type", ""), b
    except Exception as e:
        return getattr(e, "code", "ERR"), str(e)[:200], b""
def show(label, url, mode="head", pat=None, n=600000, limit=40):
    s, ct, b = get(url, n)
    print(f"\n===== {label} | {url} -> {s} [{ct[:60]}] {len(b)} bytes")
    t = b.decode("utf-8", "ignore")
    if mode == "head":
        print(t[:1500])
    elif mode == "json":
        try:
            d = json.loads(t); print(json.dumps(d, indent=1)[:2500])
        except Exception as e:
            print("not json", t[:500])
    elif mode == "links":
        links = sorted(set(re.findall(r'href="([^"]+)"', t)))
        for l in [x for x in links if (not pat or re.search(pat, x, re.I))][:limit]: print("  ", l)
    elif mode == "text":
        txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)))
        txt = re.sub(r"<[^>]+>", " ", txt); txt = re.sub(r"\s+", " ", txt)
        if pat:
            for m in re.finditer(pat, txt, re.I):
                print("  ...", txt[max(0, m.start()-200): m.end()+400]); limit -= 1
                if limit <= 0: break
        else:
            print(txt[:3000])
FD = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
# --- Treasury Fiscal Data
for ds in ["v2/accounting/od/debt_outstanding", "v2/accounting/od/debt_to_penny", "v1/accounting/mts/mts_table_1", "v1/accounting/mts/mts_table_9", "v2/accounting/od/interest_expense", "v1/accounting/mts/mts_table_4", "v1/accounting/mts/mts_table_5"]:
    show("FD earliest " + ds, FD + ds + "?sort=record_date&page[size]=2", "json")
show("FD mts1 latest annual", FD + "v1/accounting/mts/mts_table_1?filter=record_calendar_month:eq:09,classification_desc:eq:Total&sort=-record_date&page[size]=3", "json")
show("FD mts9 sample", FD + "v1/accounting/mts/mts_table_9?filter=record_date:eq:2025-09-30&page[size]=60&fields=classification_desc,current_fytd_rcpt_outly_amt,sequence_level_nbr,line_code_nbr", "json")
# --- OMB historical tables
show("OMB hist page", "https://www.whitehouse.gov/omb/information-resources/budget/historical-tables/", "links", r"hist|xls")
show("OMB budget page", "https://www.whitehouse.gov/omb/budget/historical-tables/", "links", r"hist|xls")
show("govinfo BUDGET hist", "https://www.govinfo.gov/app/collection/budget/2025", "head")
# --- Census
show("Census popest national 2020-2024", "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/national/totals/", "links", r"csv")
show("Census popest 2010-2020", "https://www2.census.gov/programs-surveys/popest/datasets/2010-2020/national/totals/", "links", r"csv")
show("Census popest 2000-2010", "https://www2.census.gov/programs-surveys/popest/datasets/2000-2010/intercensal/national/", "links", r"csv")
show("Census HH-1", "https://www2.census.gov/programs-surveys/demo/tables/families/time-series/households/", "links", r"hh")
# --- party divisions
show("House party divisions", "https://history.house.gov/Institution/Party-Divisions/Party-Divisions/", "text", r"107th|118th", limit=3)
show("Senate party division", "https://www.senate.gov/history/partydiv.htm", "text", r"107th Congress|118th Congress", limit=3)
# --- CA
show("CA DOF historical charts", "https://dof.ca.gov/budget/summary-schedules-and-historical-charts/", "links", r"chart|xls|pdf|historical")
show("CA ebudget", "https://ebudget.ca.gov/budget/2025-26/#/BudgetSummary", "head")
show("CA DOF E-4", "https://dof.ca.gov/forecasting/demographics/estimates/", "links", r"e-4|e-5|e4|e5|estimate")
show("CA Senate since 1849", "https://www.senate.ca.gov/senators-1849", "head")
show("CA Senate history", "https://www.senate.ca.gov/history", "links", r"senat|1849|histor")
show("CA Assembly history", "https://www.assembly.ca.gov/about-assembly", "links", r"histor|1849|member")
show("CA Gov library", "https://governors.library.ca.gov/list.html", "text", r"Newsom|Schwarzenegger|Davis", limit=3)
show("CA SOS prior elections", "https://www.sos.ca.gov/elections/prior-elections/statewide-election-results", "links", r"general|statement")
show("CA SOS SOV 2022", "https://www.sos.ca.gov/elections/prior-elections/statewide-election-results/general-election-november-8-2022/statement-vote", "links", r"pdf")
show("CA AG history", "https://oag.ca.gov/history", "text", r"Attorney General", limit=3)
show("CA SOS past secretaries", "https://www.sos.ca.gov/about/history", "links", r"secretar|histor")
# --- Calaveras supervisors
show("Calaveras past results", "https://elections.calaverasgov.us/Results/Past-Results", "links", r"result|pdf|20\d\d")
show("Calaveras BOS", "https://www.calaverasgov.us/Government/Board-of-Supervisors", "links", r"supervisor|district|former|past")
# --- Congress history
show("legislators-historical", "https://unitedstates.github.io/congress-legislators/legislators-historical.json", "head", n=3000)
show("executive.json", "https://unitedstates.github.io/congress-legislators/executive.json", "head", n=2000)
show("Census CD relationship files", "https://www2.census.gov/geo/relfiles/", "links", r"cd|sld")
show("Census cd108", "https://www2.census.gov/geo/relfiles/cdsld108/", "links", r"06|txt|zip")
show("Census cd113", "https://www2.census.gov/geo/relfiles/cdsld13/", "links", r"06|txt|zip")
show("Census cd113b", "https://www2.census.gov/geo/relfiles/cdsld113/", "links", r"06|txt|zip")
# --- Federal Register EOs by president
show("FR EOs Clinton", "https://www.federalregister.gov/api/v1/documents.json?conditions[presidential_document_type]=executive_order&conditions[president]=william-j-clinton&per_page=2&order=oldest&fields[]=executive_order_number&fields[]=signing_date&fields[]=title", "json")
show("FR presidents", "https://www.federalregister.gov/api/v1/documents/facets/president?conditions[presidential_document_type]=executive_order", "json")
# --- FEC totals all cycles
show("FEC totals McClintock", "https://api.open.fec.gov/v1/candidate/H8CA04152/totals/?api_key=DEMO_KEY&per_page=20&sort=-cycle", "json")
# --- clerk/senate old votes
show("House clerk 2001 roll 1", "https://clerk.house.gov/evs/2001/roll001.xml", "head")
show("Senate 107 votes", "https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_107_1.xml", "head")
# --- Open States retired CA
show("OpenStates people repo CA retired", "https://api.github.com/repos/openstates/people/contents/data/ca/retired", "head", n=3000)
# --- events
show("NBER cycles", "https://www.nber.org/research/business-cycle-dating", "text", r"peak|trough", limit=4)
show("HHS PHE COVID", "https://aspr.hhs.gov/legal/PHE/Pages/covid19-07Jan2020.aspx", "text", r"public health emergency", limit=2)
