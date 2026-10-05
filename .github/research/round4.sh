#!/bin/bash
# TEMPORARY research (round 4): Cal-Access bulk export and the FPPC Form 700 search. Remove before merging.
set -u
UA="ThePillory research (thepillory.co)"
echo "### A1 export headers"; curl -sSI -A "$UA" https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip | head -12
echo "### A2 download"; time curl -sS -A "$UA" -o /tmp/x.zip https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip; ls -la /tmp/x.zip
echo "### A3 entries"; unzip -l /tmp/x.zip | grep -iE "FILERNAME|FILER_LINKS|FILER_FILINGS|CVR_CAMPAIGN|SMRY_CD|FILER_TO_FILER|FILERS_CD|\.TSV" | head -40
mkdir -p /tmp/ca && cd /tmp/ca && unzip -q -o /tmp/x.zip '*CVR_CAMPAIGN_DISCLOSURE_CD.TSV' '*SMRY_CD.TSV' '*FILERNAME_CD.TSV' '*FILER_LINKS_CD.TSV' '*FILER_FILINGS_CD.TSV' 2>&1 | head -3
find /tmp/ca -name '*.TSV' -exec ls -la {} \;
for t in CVR_CAMPAIGN_DISCLOSURE_CD SMRY_CD FILERNAME_CD FILER_LINKS_CD FILER_FILINGS_CD; do f=$(find /tmp/ca -name "$t.TSV" | head -1); echo "### header $t"; head -1 "$f" | tr '\t' '|' ; head -3 "$f" | tail -2 | tr '\t' '|' | cut -c1-600; done
CVR=$(find /tmp/ca -name 'CVR_CAMPAIGN_DISCLOSURE_CD.TSV' | head -1)
echo "### A4 CVR rows for the Governor's last name (F460, 2025+)"
python3 - "$CVR" <<'PY'
import csv, sys
csv.field_size_limit(10**9)
f = open(sys.argv[1], encoding='latin-1', newline='')
r = csv.reader(f, delimiter='\t', quoting=csv.QUOTE_NONE)
h = next(r); idx = {k: i for i, k in enumerate(h)}
print(h)
n = 0
for row in r:
    if len(row) < len(h): continue
    if row[idx['CAND_NAML']].strip().upper() == 'NEWSOM' and row[idx['FORM_TYPE']] == 'F460' and row[idx['THRU_DATE']][:4] in ('2025', '2026'):
        print({k: row[idx[k]] for k in ['FILING_ID','AMEND_ID','FILER_ID','FILER_NAML','CAND_NAML','CAND_NAMF','FROM_DATE','THRU_DATE','RPT_DATE','FORM_TYPE','CMTTE_TYPE','CMTTE_ID','OFFICE_CD','OFFIC_DSCR'] if k in idx})
        n += 1
        if n > 8: break
PY
SM=$(find /tmp/ca -name 'SMRY_CD.TSV' | head -1)
FID=$(python3 - "$CVR" <<'PY'
import csv, sys
csv.field_size_limit(10**9)
r = csv.reader(open(sys.argv[1], encoding='latin-1', newline=''), delimiter='\t', quoting=csv.QUOTE_NONE); h = next(r); i = {k: n for n, k in enumerate(h)}
for row in r:
    if len(row) >= len(h) and row[i['CAND_NAML']].strip().upper() == 'NEWSOM' and row[i['FORM_TYPE']] == 'F460' and row[i['THRU_DATE']][:4] == '2025':
        print(row[i['FILING_ID']]); break
PY
)
echo "### A5 SMRY rows for filing $FID"; head -1 "$SM" | tr '\t' '|'; grep -P "^$FID\t" "$SM" | grep -P "\tF460\t" | head -30 | tr '\t' '|'
echo "### B form700search bundles"
cd /tmp
for b in $(curl -sS -A "$UA" https://form700search.fppc.ca.gov/ | grep -oE '/Scripts/[a-zA-Z]+\?v=[^"]+'); do echo "-- $b"; curl -sS -A "$UA" "https://form700search.fppc.ca.gov$b" | grep -oE '["'"'"'](/?api/[^"'"'"' ]+|/?Search/[A-Za-z]+[^"'"'"' ]*|/?[A-Za-z]+/(Search|Filer|Filing|Export|Results|Document)[A-Za-z]*[^"'"'"' ]*)["'"'"']' | sort -u | head -40; done
curl -sS -A "$UA" https://form700search.fppc.ca.gov/ | grep -oE '(data-[a-z-]+="[^"]{0,120}"|ng-[a-z-]+="[^"]{0,80}"|action="[^"]+"|id="[A-Za-z]+")' | sort -u | head -40
echo "### C cal-access detail page"; curl -sS -o /dev/null -w "%{http_code}\n" -A "$UA" "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=1400000"
